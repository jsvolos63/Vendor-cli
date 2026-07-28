// Tests for the dev scripts consolidated into this package: bumpKitPins (the
// kit-pin rewriter, with an injectable HEAD resolver so nothing hits the
// network), verifyKitPins (the pin existence pre-flight), and versionStamp
// (the shell version stamper). Happy paths call the exports directly against a
// temp fixture repo; the exit-code paths spawn a subprocess since versionStamp
// calls process.exit on failure. The git-first resolution/existence paths are
// driven through the injectable `run` (spawnSync) seam plus a stubbed global
// fetch — the whole suite stays offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const INDEX = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs');
const { bumpKitPins, verifyKitPins, versionStamp, parseBumpKitPinsArgs, _fetchHeadSha, _commitExists } =
  await import(pathToFileURL(INDEX));

function freshRepo(pkg, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tooling-test-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

// Run versionStamp in a subprocess so its process.exit is observable.
function stampSubprocess(dir, args = []) {
  const script =
    `import { versionStamp } from ${JSON.stringify(pathToFileURL(INDEX).href)};` +
    `versionStamp(${JSON.stringify(dir)}, ${JSON.stringify(args)});`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
}

// ---------------------------------------------------------------- versionStamp

const PKG_SOURCE_STAMP = {
  version: '1.2.3',
  versionStamp: {
    source: { packageVersion: true },
    edits: [
      { file: 'sw.js', find: "const SW_VERSION = '[^']*';", replace: "const SW_VERSION = '{version}';" },
      { file: 'index.html', find: '<span class="v">v[^<]*</span>', replace: '<span class="v">v{version}</span>' },
      { file: 'index.html', flags: 'g', find: '\\?v=[^&"\'\\s]*', replace: '?v={version}' },
    ],
  },
};

test('versionStamp stamps every edit from the package.json version', () => {
  const dir = freshRepo(PKG_SOURCE_STAMP, {
    'sw.js': "const SW_VERSION = '0.0.0';\n",
    'index.html': '<span class="v">v0.0.0</span>\n<script src="app.js?v=0.0.0"></script>\n<link href="a.css?v=old">\n',
  });
  versionStamp(dir);
  assert.equal(readFileSync(join(dir, 'sw.js'), 'utf8'), "const SW_VERSION = '1.2.3';\n");
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  assert.match(html, /<span class="v">v1\.2\.3<\/span>/);
  assert.match(html, /app\.js\?v=1\.2\.3/);
  assert.match(html, /a\.css\?v=1\.2\.3/);
  assert.doesNotMatch(html, /0\.0\.0/);
});

test('versionStamp is idempotent and --check passes when in sync', () => {
  const dir = freshRepo(PKG_SOURCE_STAMP, {
    'sw.js': "const SW_VERSION = '0.0.0';\n",
    'index.html': '<span class="v">v0.0.0</span>\n<script src="app.js?v=0.0.0"></script>\n',
  });
  versionStamp(dir);
  const after = readFileSync(join(dir, 'sw.js'), 'utf8');
  versionStamp(dir); // second run must not change anything
  assert.equal(readFileSync(join(dir, 'sw.js'), 'utf8'), after);
  assert.doesNotThrow(() => versionStamp(dir, ['--check']));
});

test('versionStamp --check exits 1 on drift', () => {
  const dir = freshRepo(PKG_SOURCE_STAMP, {
    'sw.js': "const SW_VERSION = '0.0.0';\n",
    'index.html': '<span class="v">v0.0.0</span>\n<script src="app.js?v=0.0.0"></script>\n',
  });
  const res = stampSubprocess(dir, ['--check']);
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /out of date/);
});

test('versionStamp supports a fromFile source (capture group 1)', () => {
  const dir = freshRepo(
    {
      version: '9.9.9', // deliberately different — must be ignored in favour of the const
      versionStamp: {
        source: { fromFile: { path: 'version.js', pattern: "VERSION = '([^']+)'" } },
        edits: [{ file: 'sw.js', find: "const SW_VERSION = '[^']*';", replace: "const SW_VERSION = '{version}';" }],
      },
    },
    { 'version.js': "const VERSION = '2.18.6';\n", 'sw.js': "const SW_VERSION = 'x';\n" },
  );
  versionStamp(dir);
  assert.equal(readFileSync(join(dir, 'sw.js'), 'utf8'), "const SW_VERSION = '2.18.6';\n");
});

test('versionStamp deployEnv source resolves an env var and --check is a no-op', () => {
  const dir = freshRepo(
    {
      version: '1.0.0',
      versionStamp: {
        source: { deployEnv: { vars: ['DEPLOY_ID', 'COMMIT_REF:8'], fallback: 'timestamp' } },
        edits: [{ file: 'sw.js', find: "const SW_VERSION = [^;]+;", replace: "const SW_VERSION = '{version}';" }],
      },
    },
    { 'sw.js': "const SW_VERSION = 'x';\n" },
  );
  process.env.DEPLOY_ID = 'abc123';
  try {
    versionStamp(dir);
    assert.equal(readFileSync(join(dir, 'sw.js'), 'utf8'), "const SW_VERSION = 'abc123';\n");
    // --check is not meaningful for a per-deploy source: it must not throw.
    assert.doesNotThrow(() => versionStamp(dir, ['--check']));
  } finally {
    delete process.env.DEPLOY_ID;
  }
});

test('versionStamp exits 1 on a missing pattern', () => {
  const dir = freshRepo(PKG_SOURCE_STAMP, { 'sw.js': 'no marker here\n', 'index.html': '<span class="v">v0</span>\n' });
  const res = stampSubprocess(dir);
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /not found/);
});

test('versionStamp exits 1 with a clear message on an invalid edit regex', () => {
  const dir = freshRepo(
    { version: '1.0.0', versionStamp: { source: { packageVersion: true }, edits: [{ file: 'sw.js', find: '[', replace: '{version}' }] } },
    { 'sw.js': 'x\n' },
  );
  const res = stampSubprocess(dir);
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /invalid regex/);
});

test('versionStamp exits 1 with a clear message on an invalid fromFile pattern', () => {
  const dir = freshRepo(
    { version: '1.0.0', versionStamp: { source: { fromFile: { path: 'v.js', pattern: '(' } }, edits: [{ file: 'sw.js', find: 'x', replace: '{version}' }] } },
    { 'v.js': "VERSION='1'\n", 'sw.js': 'x\n' },
  );
  const res = stampSubprocess(dir);
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /invalid versionStamp.source.fromFile.pattern/);
});

test('versionStamp exits 1 with a clear message when an edit file is missing', () => {
  // sw.js deliberately absent — must name the file, not dump an ENOENT stack.
  const dir = freshRepo(PKG_SOURCE_STAMP, {
    'index.html': '<span class="v">v0.0.0</span>\n<script src="app.js?v=0.0.0"></script>\n',
  });
  const res = stampSubprocess(dir);
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /cannot read sw\.js/);
});

test('versionStamp exits 1 with a clear message when the fromFile source is missing', () => {
  const dir = freshRepo(
    {
      version: '1.0.0',
      versionStamp: {
        source: { fromFile: { path: 'v.js', pattern: "VERSION = '([^']+)'" } },
        edits: [{ file: 'sw.js', find: 'x', replace: '{version}' }],
      },
    },
    { 'sw.js': 'x\n' },
  );
  const res = stampSubprocess(dir);
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /cannot read versionStamp\.source\.fromFile v\.js/);
});

test('versionStamp refuses a suspicious version string', () => {
  const dir = freshRepo(
    { version: 'has space', versionStamp: { source: { packageVersion: true }, edits: [{ file: 'sw.js', find: 'x', replace: '{version}' }] } },
    { 'sw.js': 'x\n' },
  );
  const res = stampSubprocess(dir);
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /suspicious version/);
});

// ---------------------------------------------------------------- bumpKitPins

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('bumpKitPins rewrites a moved pin and reports the change', async () => {
  const dir = freshRepo({
    name: 'consumer',
    devDependencies: {
      '@jfs/dom-kit': `github:jsvolos63/dom-kit#${SHA_A}`,
      jsdom: '^25.0.0',
    },
  });
  const changed = await bumpKitPins(dir, { resolveHead: async () => SHA_B });
  assert.equal(changed, true);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.devDependencies['@jfs/dom-kit'], `github:jsvolos63/dom-kit#${SHA_B}`);
  assert.equal(pkg.devDependencies.jsdom, '^25.0.0'); // non-pin untouched
});

test('bumpKitPins leaves an up-to-date pin alone', async () => {
  const dir = freshRepo({
    name: 'consumer',
    devDependencies: { '@jfs/dom-kit': `github:jsvolos63/dom-kit#${SHA_A}` },
  });
  const before = readFileSync(join(dir, 'package.json'), 'utf8');
  const changed = await bumpKitPins(dir, { resolveHead: async () => SHA_A });
  assert.equal(changed, false);
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), before);
});

test('bumpKitPins also bumps pins under vendoredKits, ignoring its note field', async () => {
  const dir = freshRepo({
    name: 'consumer',
    devDependencies: { jsdom: '^25.0.0' },
    vendoredKits: {
      note: 'never edit by hand',
      '@jfs/news-kit': `github:jsvolos63/news-kit#${SHA_A}`,
      '@jfs/dom-kit': `github:jsvolos63/dom-kit#${SHA_A}`,
    },
  });
  const logs = [];
  const origLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  let changed;
  try {
    changed = await bumpKitPins(dir, { resolveHead: async () => SHA_B });
  } finally {
    console.log = origLog;
  }
  assert.equal(changed, true);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.vendoredKits['@jfs/news-kit'], `github:jsvolos63/news-kit#${SHA_B}`);
  assert.equal(pkg.vendoredKits['@jfs/dom-kit'], `github:jsvolos63/dom-kit#${SHA_B}`);
  assert.equal(pkg.vendoredKits.note, 'never edit by hand'); // non-pin untouched
  assert.equal(pkg.devDependencies.jsdom, '^25.0.0');
  // Copy-in consumers own the regeneration of their vendored copies — the
  // bumper must say so instead of implying a vendor:sync happened.
  assert.ok(
    logs.some((l) => /vendoredKits/.test(l) && /regenerate/.test(l)),
    `expected a regenerate-yourself note in output, got:\n${logs.join('\n')}`
  );
});

test('bumpKitPins moves a kit pinned in both a section and vendoredKits together', async () => {
  const dir = freshRepo({
    name: 'consumer',
    devDependencies: { '@jfs/dom-kit': `github:jsvolos63/dom-kit#${SHA_A}` },
    vendoredKits: { '@jfs/dom-kit': `github:jsvolos63/dom-kit#${SHA_A}` },
  });
  let resolves = 0;
  const changed = await bumpKitPins(dir, {
    resolveHead: async () => {
      resolves++;
      return SHA_B;
    },
  });
  assert.equal(changed, true);
  assert.equal(resolves, 1); // one resolve moves every occurrence
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.devDependencies['@jfs/dom-kit'], `github:jsvolos63/dom-kit#${SHA_B}`);
  assert.equal(pkg.vendoredKits['@jfs/dom-kit'], `github:jsvolos63/dom-kit#${SHA_B}`);
});

test('bumpKitPins prints no vendoredKits note for a devDependencies-only consumer', async () => {
  const dir = freshRepo({
    name: 'consumer',
    devDependencies: { '@jfs/dom-kit': `github:jsvolos63/dom-kit#${SHA_A}` },
  });
  const logs = [];
  const origLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    await bumpKitPins(dir, { resolveHead: async () => SHA_B });
  } finally {
    console.log = origLog;
  }
  assert.ok(!logs.some((l) => /vendoredKits/.test(l)), `unexpected vendoredKits note:\n${logs.join('\n')}`);
});

// --------------------------------------------------------------- verifyKitPins

test('verifyKitPins passes when every pin resolves, ignoring non-pins', async () => {
  const dir = freshRepo({
    name: 'consumer',
    dependencies: { '@jfs/netlify-kit': `github:jsvolos63/netlify-kit#${SHA_A}` },
    devDependencies: {
      '@jfs/dom-kit': `github:jsvolos63/dom-kit#${SHA_B}`,
      jsdom: '^25.0.0', // non-pin — must not be checked
    },
  });
  const seen = [];
  const n = await verifyKitPins(dir, {
    checkExists: async (repo, sha) => {
      seen.push(`${repo}#${sha.slice(0, 7)}`);
      return true;
    },
  });
  assert.equal(n, 2);
  assert.deepEqual(seen, [`jsvolos63/netlify-kit#${SHA_A.slice(0, 7)}`, `jsvolos63/dom-kit#${SHA_B.slice(0, 7)}`]);
});

test('verifyKitPins throws a clear error naming pins that do not exist', async () => {
  const dir = freshRepo({
    name: 'consumer',
    devDependencies: {
      '@jfs/dom-kit': `github:jsvolos63/dom-kit#${SHA_A}`,
      '@jfs/news-kit': `github:jsvolos63/news-kit#${SHA_B}`,
    },
  });
  // dom-kit resolves; news-kit does not (the bad-SHA scenario this exists for).
  await assert.rejects(
    verifyKitPins(dir, { checkExists: async (repo) => repo !== 'jsvolos63/news-kit' }),
    (err) => {
      assert.match(err.message, /do(es)? not exist/i);
      assert.match(err.message, /news-kit/);
      assert.doesNotMatch(err.message, /dom-kit/); // only the missing one is named
      return true;
    },
  );
});

test('verifyKitPins propagates an inconclusive API status instead of passing', async () => {
  const dir = freshRepo({
    name: 'consumer',
    devDependencies: { '@jfs/dom-kit': `github:jsvolos63/dom-kit#${SHA_A}` },
  });
  await assert.rejects(
    verifyKitPins(dir, {
      checkExists: async () => {
        throw new Error('jsvolos63/dom-kit@aaaaaaa: GitHub API returned HTTP 403');
      },
    }),
    /HTTP 403/,
  );
});

test('verifyKitPins is a no-op (returns 0) when there are no kit pins', async () => {
  const dir = freshRepo({ name: 'consumer', devDependencies: { jsdom: '^25.0.0' } });
  const n = await verifyKitPins(dir, { checkExists: async () => { throw new Error('should not be called'); } });
  assert.equal(n, 0);
});

test('verifyKitPins also scans the vendoredKits object, ignoring its note field', async () => {
  const dir = freshRepo({
    name: 'consumer',
    devDependencies: { '@jfs/vendor-cli': `github:jsvolos63/vendor-cli#${SHA_A}` },
    vendoredKits: {
      note: 'never edit by hand',
      '@jfs/news-kit': `github:jsvolos63/news-kit#${SHA_B}`,
      '@jfs/dom-kit': `github:jsvolos63/dom-kit#${SHA_A}`,
    },
  });
  const seen = [];
  const n = await verifyKitPins(dir, {
    checkExists: async (repo) => { seen.push(repo); return true; },
  });
  assert.equal(n, 3); // vendor-cli (devDep) + news-kit + dom-kit (vendoredKits); note ignored
  assert.deepEqual(seen.sort(), ['jsvolos63/dom-kit', 'jsvolos63/news-kit', 'jsvolos63/vendor-cli']);
});

test('verifyKitPins de-dups a kit pinned in both a section and vendoredKits', async () => {
  const dir = freshRepo({
    name: 'consumer',
    devDependencies: { '@jfs/dom-kit': `github:jsvolos63/dom-kit#${SHA_A}` },
    vendoredKits: { '@jfs/dom-kit': `github:jsvolos63/dom-kit#${SHA_A}` },
  });
  let calls = 0;
  const n = await verifyKitPins(dir, { checkExists: async () => { calls++; return true; } });
  assert.equal(n, 1);
  assert.equal(calls, 1);
});

// ------------------------------------------------- git-first pin resolution
// The kit-pin bins used to resolve HEAD and check existence through the GitHub
// REST API only, which is unusable wherever the ambient credential is scoped
// to the git transport rather than api.github.com (401 authenticated / 403
// unauthenticated on these private repos). Resolution is now git-first with
// the API kept as the fallback. These tests drive both branches through the
// injectable `run` seam and a stubbed global fetch — nothing hits the network.

const REPO = 'jsvolos63/pwa-kit';

// A spawnSync-shaped result.
const gitOk = (stdout = '') => ({ status: 0, stdout, stderr: '', error: undefined, signal: null });
const gitFail = (stderr, status = 128) => ({ status, stdout: '', stderr, error: undefined, signal: null });

// Swap globalThis.fetch for the duration of fn.
async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const apiNever = () => {
  throw new Error('the GitHub API must not be called on the git-success path');
};

test('_fetchHeadSha resolves HEAD via git ls-remote, without touching the API', async () => {
  const calls = [];
  const sha = await withFetch(apiNever, () =>
    _fetchHeadSha(REPO, {
      run: (args) => {
        calls.push(args);
        return gitOk(`${SHA_A}\tHEAD\n`);
      },
    }),
  );
  assert.equal(sha, SHA_A);
  assert.equal(calls.length, 1);
  // Argument ARRAY, never a shell string, and the URL is built from the
  // validated repo name.
  assert.deepEqual(calls[0], ['ls-remote', `https://github.com/${REPO}`, 'HEAD']);
});

test('_fetchHeadSha falls back to the GitHub API when the git command fails', async () => {
  let apiCalls = 0;
  const sha = await withFetch(
    async () => {
      apiCalls++;
      return { ok: true, status: 200, text: async () => `${SHA_B}\n` };
    },
    () => _fetchHeadSha(REPO, { run: () => gitFail('fatal: unable to access: proxy CONNECT aborted') }),
  );
  assert.equal(sha, SHA_B);
  assert.equal(apiCalls, 1);
});

test('_fetchHeadSha surfaces BOTH failures when git and the API are unavailable', async () => {
  await withFetch(
    async () => ({ ok: false, status: 401, text: async () => '' }),
    async () => {
      await assert.rejects(
        _fetchHeadSha(REPO, { run: () => gitFail('fatal: could not read Username: terminal prompts disabled') }),
        (err) => {
          assert.match(err.message, /could not resolve HEAD/);
          assert.match(err.message, /git ls-remote failed/);
          assert.match(err.message, /terminal prompts disabled/);
          assert.match(err.message, /HTTP 401/);
          return true;
        },
      );
    },
  );
});

test('_fetchHeadSha treats unparseable ls-remote output as a git failure', async () => {
  const sha = await withFetch(
    async () => ({ ok: true, status: 200, text: async () => SHA_B }),
    () => _fetchHeadSha(REPO, { run: () => gitOk('not a sha at all\n') }),
  );
  assert.equal(sha, SHA_B); // fell through to the API rather than returning junk
});

test('_fetchHeadSha refuses a repo name outside the kit namespace', async () => {
  await assert.rejects(
    withFetch(apiNever, () =>
      _fetchHeadSha('evil/../../etc', {
        run: () => {
          throw new Error('git must not run for an unvalidated repo name');
        },
      }),
    ),
    /unexpected repo name/,
  );
});

test('_commitExists confirms a pin with a depth-1 git fetch of the exact SHA', async () => {
  const calls = [];
  let tempDir;
  const exists = await withFetch(apiNever, () =>
    _commitExists(REPO, SHA_A, {
      run: (args, opts) => {
        calls.push({ args, opts });
        if (args[0] === 'init') {
          tempDir = args[3];
          return gitOk();
        }
        return gitOk();
      },
    }),
  );
  assert.equal(exists, true);
  assert.deepEqual(calls[0].args.slice(0, 3), ['init', '--quiet', '--bare']);
  assert.deepEqual(calls[1].args, ['fetch', '--quiet', '--depth=1', `https://github.com/${REPO}`, SHA_A]);
  assert.equal(calls[1].opts.cwd, tempDir);
  assert.equal(existsSync(tempDir), false, 'the temporary bare repo must be cleaned up');
});

test('_commitExists reports a genuinely missing commit as missing (not inconclusive)', async () => {
  const exists = await withFetch(apiNever, () =>
    _commitExists(REPO, SHA_B, {
      run: (args) =>
        args[0] === 'init'
          ? gitOk()
          : gitFail(`fatal: remote error: upload-pack: not our ref ${SHA_B}`),
    }),
  );
  assert.equal(exists, false);
});

test('_commitExists falls back to the API when git cannot answer', async () => {
  let apiCalls = 0;
  const exists = await withFetch(
    async () => {
      apiCalls++;
      return { status: 200 };
    },
    () =>
      _commitExists(REPO, SHA_A, {
        run: (args) => (args[0] === 'init' ? gitOk() : gitFail('fatal: unable to access: Could not resolve host')),
      }),
  );
  assert.equal(exists, true);
  assert.equal(apiCalls, 1);
});

test('_commitExists throws (never passes) when git AND the API are both inconclusive', async () => {
  await withFetch(
    async () => ({ status: 403 }),
    async () => {
      await assert.rejects(
        _commitExists(REPO, SHA_A, {
          run: (args) => (args[0] === 'init' ? gitOk() : gitFail('fatal: unable to access: Could not resolve host')),
        }),
        (err) => {
          assert.match(err.message, /could not verify pin/);
          assert.match(err.message, /git fetch failed/);
          assert.match(err.message, /HTTP 403/);
          return true;
        },
      );
    },
  );
});

test('_commitExists cleans up its temp dir even when the git call throws', async () => {
  let tempDir;
  await withFetch(
    async () => ({ status: 404 }),
    () =>
      _commitExists(REPO, SHA_A, {
        run: (args) => {
          if (args[0] === 'init') {
            tempDir = args[3];
            return gitOk();
          }
          throw new Error('spawn git ENOENT');
        },
      }),
  );
  assert.ok(tempDir);
  assert.equal(existsSync(tempDir), false, 'the temporary bare repo must be cleaned up on throw too');
});

test('verifyKitPins fails closed when the pin check is inconclusive on both transports', async () => {
  const dir = freshRepo({
    name: 'consumer',
    devDependencies: { '@jfs/dom-kit': `github:jsvolos63/dom-kit#${SHA_A}` },
  });
  await withFetch(
    async () => ({ status: 500 }),
    async () => {
      await assert.rejects(
        verifyKitPins(dir, {
          checkExists: (repo, sha) =>
            _commitExists(repo, sha, {
              run: (args) => (args[0] === 'init' ? gitOk() : gitFail('fatal: unable to access: Could not resolve host')),
            }),
        }),
        /could not verify pin/,
      );
    },
  );
});

// -------------------------------------------------------- explicit --pin SHAs

test('parseBumpKitPinsArgs accepts both --pin spellings, repeatably', () => {
  const { pins } = parseBumpKitPinsArgs(['--pin', `@jfs/dom-kit=${SHA_A}`, `--pin=pwa-kit=${SHA_B}`]);
  assert.deepEqual(pins, { '@jfs/dom-kit': SHA_A, 'pwa-kit': SHA_B });
  assert.deepEqual(parseBumpKitPinsArgs([]).pins, {});
});

test('parseBumpKitPinsArgs rejects malformed and unknown arguments', () => {
  assert.throws(() => parseBumpKitPinsArgs(['--pin']), /requires a <kit>=<sha>/);
  assert.throws(() => parseBumpKitPinsArgs(['--pin', 'dom-kit']), /expected <kit>=<sha>/);
  assert.throws(() => parseBumpKitPinsArgs(['--wat']), /unknown argument/);
});

test('bumpKitPins honours an explicit pin and skips resolution for that kit', async () => {
  const dir = freshRepo({
    name: 'consumer',
    devDependencies: {
      '@jfs/dom-kit': `github:jsvolos63/dom-kit#${SHA_A}`,
      '@jfs/pwa-kit': `github:jsvolos63/pwa-kit#${SHA_A}`,
    },
  });
  const resolved = [];
  const changed = await bumpKitPins(dir, {
    pins: { '@jfs/dom-kit': SHA_B.toUpperCase() }, // case-insensitive input
    resolveHead: async (repo) => {
      resolved.push(repo);
      return SHA_A; // pwa-kit stays put
    },
  });
  assert.equal(changed, true);
  assert.deepEqual(resolved, ['jsvolos63/pwa-kit'], 'the explicitly pinned kit must not be resolved');
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.devDependencies['@jfs/dom-kit'], `github:jsvolos63/dom-kit#${SHA_B}`);
  assert.equal(pkg.devDependencies['@jfs/pwa-kit'], `github:jsvolos63/pwa-kit#${SHA_A}`);
});

test('bumpKitPins accepts the repo name as well as the package name in a --pin', async () => {
  const dir = freshRepo({
    name: 'consumer',
    vendoredKits: { '@jfs/news-kit': `github:jsvolos63/news-kit#${SHA_A}` },
  });
  const changed = await bumpKitPins(dir, {
    pins: { 'news-kit': SHA_B },
    resolveHead: async () => {
      throw new Error('must not resolve');
    },
  });
  assert.equal(changed, true);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.vendoredKits['@jfs/news-kit'], `github:jsvolos63/news-kit#${SHA_B}`);
});

test('bumpKitPins rejects an invalid --pin SHA before touching package.json', async () => {
  const dir = freshRepo({
    name: 'consumer',
    devDependencies: { '@jfs/dom-kit': `github:jsvolos63/dom-kit#${SHA_A}` },
  });
  const before = readFileSync(join(dir, 'package.json'), 'utf8');
  await assert.rejects(
    bumpKitPins(dir, {
      pins: { '@jfs/dom-kit': 'deadbeef' },
      resolveHead: async () => {
        throw new Error('must not resolve');
      },
    }),
    /not a 40-character hex commit SHA/,
  );
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), before);
});

test('bumpKitPins rejects a --pin naming a kit this repo does not pin', async () => {
  const dir = freshRepo({
    name: 'consumer',
    devDependencies: { '@jfs/dom-kit': `github:jsvolos63/dom-kit#${SHA_A}` },
  });
  await assert.rejects(
    bumpKitPins(dir, {
      pins: { '@jfs/nope-kit': SHA_B },
      resolveHead: async () => SHA_A,
    }),
    (err) => {
      assert.match(err.message, /no kit pinned as "@jfs\/nope-kit"/);
      assert.match(err.message, /@jfs\/dom-kit/); // lists what IS pinned
      return true;
    },
  );
});
