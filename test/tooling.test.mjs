// Tests for the two dev scripts consolidated into this package: bumpKitPins
// (kit-pin rewriter, with an injectable HEAD resolver so nothing hits the
// network) and versionStamp (the shell version stamper). Happy paths call the
// exports directly against a temp fixture repo; the exit-code paths spawn a
// subprocess since versionStamp calls process.exit on failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const INDEX = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs');
const { bumpKitPins, verifyKitPins, versionStamp } = await import(pathToFileURL(INDEX));

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
