// @jfs/vendor-cli — the kit family's shared vendoring CLI.
//
// Every @jfs kit ships a `bin/vendor.mjs` that used to be a byte-identical
// 200-line copy of this logic; a fix in one copy silently missed the other
// four. The generation now lives (and is tested) here, once. Each kit's bin
// is a thin shim:
//
//   #!/usr/bin/env node
//   import { dirname } from 'node:path';
//   import { fileURLToPath } from 'node:url';
//   import { runVendorCli } from '@jfs/vendor-cli';
//   runVendorCli(dirname(dirname(fileURLToPath(import.meta.url))));
//
// runVendorCli(kitDir) reads the KIT's package.json + index.js from kitDir
// and generates/checks the consumer-side vendored copy. See the usage block
// below for the flag reference (unchanged from the per-kit era: --format
// esm|global|bare|cjs, --out, --name, --pick, --check).
//
// Vendor this kit into a consumer repo — the kit-side replacement for the
// hand-rolled scripts/vendor-*.mjs copies that used to live in every consumer.
//
// The consumers are buildless static sites: node_modules is not deployed, so
// each one commits a generated copy of the kit and CI fails if it drifts from
// the pinned package. This bin owns the generation, so "how to package this
// kit for a buildless consumer" lives (and is tested) here, once, instead of
// being re-implemented per consumer.
//
// Usage (from a consumer repo, with the kit installed as a devDependency):
//
//   <bin-name> --format <esm|global|bare|cjs> --out <dest> \
//              [--name <GlobalName>] [--pick a,b,c] [--check]
//
//   --format esm      verbatim ESM copy (unit tests import this)
//   --format global   classic-script IIFE exposing the public API on
//                     `globalThis.<Name>` (--name required) — for service
//                     workers via importScripts() and classic <script> pages
//   --format bare     `export`-stripped copy whose declarations become
//                     bundle-scoped when concatenated into a classic-script
//                     bundle (aggregate `export { a as b }` alias lines are
//                     dropped — aliases can't be expressed as declarations)
//   --format cjs      CommonJS transform (module.exports of the public API)
//                     for `require()` from CommonJS Netlify Functions
//   --pick a,b,c      global and cjs formats: expose just this subset (each
//                     name must exist in the derived surface — typos are an
//                     error). Narrows the EXPOSED API (the global object /
//                     module.exports map), not the shipped bytes — the body
//                     is kept whole because internal helpers are shared and
//                     regex-level tree-shaking would be unsound. Use it to
//                     keep a consumer's coupling surface explicit.
//   --check           don't write; exit 1 if <dest> differs from what would
//                     be generated (consumers run this in CI as vendor:check)
//
// The exposed surface for global/cjs is DERIVED from the source's own
// top-level `export` declarations — never a hand-maintained list. A stale
// list would either omit a newly-added export (breaking the consumer at
// runtime) or reference a removed one (a ReferenceError that fails service
// worker install), and a drift check can't catch either because the committed
// copy and the regenerated one would share the same stale list.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function runVendorCli(kitDir, argv = process.argv.slice(2)) {
const KIT_DIR = kitDir;
const pkg = JSON.parse(readFileSync(`${KIT_DIR}/package.json`, 'utf8'));
const source = readFileSync(`${KIT_DIR}/index.js`, 'utf8');

const repoMatch = String(pkg.repository?.url || '').match(
  /github\.com[/:]([^/]+\/[^/.]+)/
);
const REPO = repoMatch ? repoMatch[1] : pkg.name;

function fail(msg) {
  console.error(`${pkg.name} vendor: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------- arguments

const args = argv;
const opts = { check: false, pick: null, name: null, format: null, out: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => {
    if (i + 1 >= args.length) fail(`${a} requires a value`);
    return args[++i];
  };
  if (a === '--check') opts.check = true;
  else if (a === '--format') opts.format = next();
  else if (a === '--out') opts.out = next();
  else if (a === '--name') opts.name = next();
  else if (a === '--pick') opts.pick = next().split(',').map((s) => s.trim()).filter(Boolean);
  else fail(`unknown argument: ${a}`);
}

const FORMATS = ['esm', 'global', 'bare', 'cjs'];
if (!FORMATS.includes(opts.format)) fail(`--format must be one of: ${FORMATS.join(', ')}`);
if (!opts.out) fail('--out <dest> is required');
if (opts.format === 'global' && !opts.name) fail('--format global requires --name <GlobalName>');
if (opts.name && !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(opts.name)) fail(`--name must be a valid identifier, got: ${opts.name}`);
if (opts.pick && opts.format !== 'global' && opts.format !== 'cjs') {
  fail('--pick is only valid with --format global or cjs');
}

// ------------------------------------------------------- derive the surface

// Ordered { exported, local } pairs from the source's own `export`
// declarations plus aggregate `export { a as b, c }` alias lines. The kits
// deliberately use only these forms (no default export, no re-export-from),
// which keeps this derivation exact.
function deriveSurface(esm) {
  const surface = [];
  const declRe = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/gm;
  let m;
  while ((m = declRe.exec(esm)) !== null) {
    surface.push({ exported: m[1], local: m[1] });
  }
  const aggRe = /^export\s*\{([^}]*)\}\s*;?\s*$/gm;
  while ((m = aggRe.exec(esm)) !== null) {
    for (const part of m[1].split(',')) {
      const spec = part.trim();
      if (!spec) continue;
      const alias = spec.match(/^([A-Za-z0-9_$]+)(?:\s+as\s+([A-Za-z0-9_$]+))?$/);
      if (!alias) fail(`unparseable export specifier in aggregate export: "${spec}"`);
      surface.push({ exported: alias[2] || alias[1], local: alias[1] });
    }
  }
  return surface;
}

const surface = deriveSurface(source);
if (surface.length === 0) {
  fail(`found no top-level exports in ${KIT_DIR}/index.js — refusing to generate an empty surface.`);
}

let exposed = surface;
if (opts.pick) {
  const known = new Set(surface.map((s) => s.exported));
  const unknown = opts.pick.filter((n) => !known.has(n));
  if (unknown.length) {
    fail(`--pick names not exported by ${pkg.name}: ${unknown.join(', ')} (available: ${[...known].join(', ')})`);
  }
  exposed = surface.filter((s) => opts.pick.includes(s.exported));
}

// -------------------------------------------------------------- generation

function header(extra) {
  return (
    `// VENDORED from ${pkg.name} v${pkg.version} (github:${REPO}), pinned in package.json.\n` +
    `// DO NOT EDIT — generated by the kit's own vendor bin; run\n` +
    '// `npm run vendor:sync` to regenerate. CI runs `npm run vendor:check`\n' +
    '// to fail on drift.\n' +
    (extra ? `//\n${extra}\n` : '') +
    '\n'
  );
}

// Strip aggregate alias lines first (they're re-expressed via the surface
// map in global/cjs, and deliberately dropped in bare), then the `export`
// keyword from every top-level declaration.
function strippedBody(esm) {
  return esm
    .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/^export\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

function build() {
  const surfaceMap = exposed.map((s) => `  ${s.exported}: ${s.local},`).join('\n');
  switch (opts.format) {
    case 'esm':
      return header('// The unit tests import this verbatim ESM copy.') + source;
    case 'bare':
      return (
        header(
          '// Classic-script build: every `export` is stripped so the declarations\n' +
          "// become bundle-scoped when this file is concatenated into the app's\n" +
          '// classic-script bundle. Aggregate alias exports are dropped.'
        ) + strippedBody(source).replace(/^\n+/, '')
      );
    case 'global':
      return (
        header(
          '// Classic-script IIFE build for importScripts()/<script> consumers;\n' +
          `// exposes the public API on globalThis.${opts.name}.`
        ) +
        '(function () {\n' +
        '"use strict";\n' +
        strippedBody(source) +
        `\nglobalThis.${opts.name} = {\n${surfaceMap}\n};\n` +
        '}());\n'
      );
    case 'cjs':
      return (
        header(
          '// CommonJS transform of the ESM package so CommonJS Netlify\n' +
          '// Functions can require() it.'
        ) +
        strippedBody(source) +
        `\nmodule.exports = {\n${surfaceMap}\n};\n`
      );
  }
}

const expected = build();
const dest = resolve(process.cwd(), opts.out);

if (opts.check) {
  let current = '';
  try {
    current = readFileSync(dest, 'utf8');
  } catch {
    fail(`${opts.out} missing — run \`npm run vendor:sync\`.`);
  }
  if (current !== expected) {
    fail(`${opts.out} is out of sync with the pinned ${pkg.name}.\nRun \`npm install && npm run vendor:sync\` and commit the result.`);
  }
  console.log(`${pkg.name} vendor: ${opts.out} is in sync (${exposed.length} of ${surface.length} exports exposed).`);
} else {
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, expected);
  console.log(`${pkg.name} vendor: wrote ${opts.out} (format ${opts.format}, ${exposed.length} of ${surface.length} exports).`);
}
}

// ===========================================================================
// The family's other two byte-identical-per-consumer dev scripts, consolidated
// here for the same reason the vendoring generator was: a fix in one copy
// silently missed the rest. Consumers used to carry a local
// scripts/bump-kit-pins.mjs + their own version stamper; they now depend on
// this package directly and call the `jfs-bump-kit-pins` / `jfs-version-stamp`
// bins instead.
// ===========================================================================

// ---------------------------------------------------------------------------
// bumpKitPins — rewrite the `github:jsvolos63/<kit>#<sha>` pins in a consumer's
// package.json to each kit repo's current default-branch HEAD. Run by each
// consumer's kit-pin-bump workflow; touches package.json only when a pin
// actually changed, so `git diff --quiet package.json` remains the signal.
// Scans `dependencies`, `devDependencies`, and the `vendoredKits` object (the
// copy-in consumers, e.g. John's-News) — the same shapes `verifyKitPins`
// covers, so the two stay symmetric. NOTE: for `vendoredKits` pins this bin
// only rewrites the SHAs — those kits are copied in, not npm-installed, so the
// consumer owns regenerating its vendored copies from the new pins (there is
// no `vendor:sync` assumption here). `resolveHead` is injectable so tests can
// exercise the rewrite without hitting the GitHub API.
// ---------------------------------------------------------------------------
const KIT_PIN_RE = /^github:(jsvolos63\/[A-Za-z0-9._-]+)#([0-9a-f]{40})$/;

async function fetchHeadSha(repo) {
  const token = process.env.GITHUB_TOKEN || '';
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/HEAD`, {
    headers: {
      accept: 'application/vnd.github.sha',
      'user-agent': 'kit-pin-bump',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`${repo}: GitHub API returned HTTP ${res.status}`);
  const sha = (await res.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`${repo}: unexpected HEAD response "${sha.slice(0, 60)}"`);
  }
  return sha;
}

export async function bumpKitPins(rootDir = process.cwd(), { resolveHead = fetchHeadSha } = {}) {
  const file = resolve(rootDir, 'package.json');
  const raw = readFileSync(file, 'utf8');
  const pkg = JSON.parse(raw);

  // Collect every pin once. A kit pinned in two places at the same SHA (e.g.
  // a dependency section AND vendoredKits) is one resolve; the rewrite below
  // is a replaceAll, so both occurrences move together.
  const pins = [];
  const dedup = new Map();
  const collect = (name, spec, vendored) => {
    const m = typeof spec === 'string' ? spec.match(KIT_PIN_RE) : null;
    if (!m) return;
    const key = `${m[1]}#${m[2]}`;
    const dup = dedup.get(key);
    if (dup) {
      dup.vendored = dup.vendored || vendored; // still one resolve/rewrite
      return;
    }
    const pin = { name, repo: m[1], pinned: m[2], vendored };
    dedup.set(key, pin);
    pins.push(pin);
  };
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, spec] of Object.entries(pkg[section] || {})) collect(name, spec, false);
  }
  // Copy-in consumers (e.g. John's-News) keep their kit pins under a
  // `vendoredKits` object instead of *dependencies — same `github:<repo>#<sha>`
  // value format. Bump those too; non-pin values like the "note" field simply
  // don't match KIT_PIN_RE.
  if (pkg.vendoredKits && typeof pkg.vendoredKits === 'object') {
    for (const [name, spec] of Object.entries(pkg.vendoredKits)) collect(name, spec, true);
  }

  let out = raw;
  let changed = false;
  let vendoredChanged = false;
  for (const { name, repo, pinned, vendored } of pins) {
    const head = await resolveHead(repo);
    if (head === pinned) {
      console.log(`${name}: up to date at ${pinned.slice(0, 7)}`);
      continue;
    }
    out = out.replaceAll(`github:${repo}#${pinned}`, `github:${repo}#${head}`);
    changed = true;
    if (vendored) vendoredChanged = true;
    console.log(`${name}: ${pinned.slice(0, 7)} -> ${head.slice(0, 7)}`);
  }

  if (changed) {
    JSON.parse(out); // refuse to write a package.json that no longer parses
    writeFileSync(file, out);
    console.log('package.json updated');
    if (vendoredChanged) {
      console.log(
        'note: vendoredKits pins were bumped — this bin only rewrites the SHAs; ' +
          'regenerate the vendored copies from the new pins yourself (copy-in ' +
          'consumers own that step; no vendor:sync is assumed).'
      );
    }
  } else {
    console.log('all kit pins up to date');
  }
  return changed;
}

// ---------------------------------------------------------------------------
// verifyKitPins — pre-flight: assert every `github:jsvolos63/<kit>#<sha>` pin in
// a consumer's package.json points at a commit that actually exists on the
// remote, BEFORE `npm install` tries to fetch it. A hand-edited/typo'd SHA
// otherwise surfaces as an opaque `npm install` git-128 / codeload 404 that
// takes a while to diagnose; run in CI ahead of install, this turns it into a
// one-line "pin X#<sha> does not exist" and fails fast. Existence is checked
// against the same GitHub API `bumpKitPins` resolves HEAD from; `checkExists`
// is injectable so tests never hit the network. Scans the same sections and
// pin format as `bumpKitPins`, so the two stay symmetric. Throws on any missing
// pin (or an unexpected API status); returns the number of pins verified.
// ---------------------------------------------------------------------------
async function commitExists(repo, sha) {
  const token = process.env.GITHUB_TOKEN || '';
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}`, {
    headers: {
      accept: 'application/vnd.github.sha',
      'user-agent': 'kit-pin-check',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 200) return true;
  // 404 (unknown repo/commit) and 422 (malformed sha) both mean "not a real
  // pin"; anything else (403 rate-limit, 5xx) is inconclusive, not "missing".
  if (res.status === 404 || res.status === 422) return false;
  throw new Error(`${repo}@${sha.slice(0, 7)}: GitHub API returned HTTP ${res.status}`);
}

export async function verifyKitPins(rootDir = process.cwd(), { checkExists = commitExists } = {}) {
  const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));

  const pins = [];
  const dedup = new Set();
  const collect = (name, spec) => {
    const m = typeof spec === 'string' ? spec.match(KIT_PIN_RE) : null;
    if (!m) return;
    const key = `${m[1]}#${m[2]}`;
    if (dedup.has(key)) return; // a kit pinned in two sections is one check
    dedup.add(key);
    pins.push({ name, repo: m[1], sha: m[2] });
  };
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, spec] of Object.entries(pkg[section] || {})) collect(name, spec);
  }
  // Some consumers (e.g. John's-News) keep the kit pins under a `vendoredKits`
  // object instead of *dependencies (they copy the kits in rather than install
  // them). Same `github:<repo>#<sha>` value format, so check those too; non-pin
  // values like the "note" field simply don't match KIT_PIN_RE.
  if (pkg.vendoredKits && typeof pkg.vendoredKits === 'object') {
    for (const [name, spec] of Object.entries(pkg.vendoredKits)) collect(name, spec);
  }

  const missing = [];
  for (const p of pins) {
    if (await checkExists(p.repo, p.sha)) {
      console.log(`${p.name}: ${p.sha.slice(0, 7)} resolves on ${p.repo}`);
    } else {
      missing.push(p);
      console.error(`${p.name}: pin github:${p.repo}#${p.sha} does NOT exist on the remote`);
    }
  }

  if (missing.length) {
    const list = missing.map((p) => `${p.name} (${p.repo}#${p.sha.slice(0, 7)})`).join(', ');
    throw new Error(
      `${missing.length} kit pin(s) point at a commit that does not exist: ${list}. ` +
        'Fix the SHA in package.json (see `jfs-bump-kit-pins`) before installing.'
    );
  }
  return pins.length;
}

// ---------------------------------------------------------------------------
// versionStamp — stamp one version string into the shell files that must agree
// on it (service-worker cache name, `?v=` cache-busters, header label), so a
// bumped version can't leave returning visitors on a stale cached shell. Driven
// by a `versionStamp` block in the consumer's package.json:
//
//   "versionStamp": {
//     "source": { "packageVersion": true },
//     "edits": [
//       { "file": "sw.js",
//         "find": "const SW_VERSION = '[^']*';",
//         "replace": "const SW_VERSION = '{version}';" },
//       { "file": "index.html", "flags": "g",
//         "find": "\\?v=[^&\"'\\s]*",
//         "replace": "?v={version}" }
//     ]
//   }
//
// `source` is exactly one of:
//   { "packageVersion": true }                     — package.json "version"
//   { "fromFile": { "path", "pattern" } }          — capture group 1 of a regex
//   { "deployEnv": { "vars": [...], "fallback" } } — a per-deploy id; the
//        vars are tried in order, each optionally sliced as "NAME:8"; a
//        "timestamp" fallback yields Date.now().toString(36). Non-deterministic,
//        so `--check` is a no-op for this source.
//
// Each edit's `find` is a RegExp string (optional `flags`); `{version}` in
// `replace` is substituted literally. `--check` writes nothing and exits 1 on
// drift — consumers run it in CI as version:check.
// ---------------------------------------------------------------------------
const VERSION_RE = /^[A-Za-z0-9._-]+$/;

function failStamp(msg) {
  console.error(`version-stamp: ${msg}`);
  process.exit(1);
}

function resolveStampVersion(source, rootDir) {
  if (!source || typeof source !== 'object') failStamp('versionStamp.source is required');
  if (source.packageVersion) {
    const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));
    return { version: pkg.version, deterministic: true };
  }
  if (source.fromFile) {
    const { path: p, pattern } = source.fromFile;
    if (!p || !pattern) failStamp('versionStamp.source.fromFile needs { path, pattern }');
    const src = readFileSync(resolve(rootDir, p), 'utf8');
    let re;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return failStamp(`invalid versionStamp.source.fromFile.pattern /${pattern}/ — ${e.message}`);
    }
    const m = src.match(re);
    if (!m || m[1] == null) failStamp(`pattern ${pattern} (capture group 1) not found in ${p}`);
    return { version: m[1], deterministic: true };
  }
  if (source.deployEnv) {
    for (const spec of source.deployEnv.vars || []) {
      const [name, len] = String(spec).split(':');
      const val = process.env[name];
      if (typeof val === 'string' && val.trim()) {
        const v = len ? val.trim().slice(0, Number(len)) : val.trim();
        if (VERSION_RE.test(v)) return { version: v, deterministic: false };
      }
    }
    if (source.deployEnv.fallback === 'timestamp') {
      return { version: Date.now().toString(36), deterministic: false };
    }
    failStamp('no deployEnv var resolved and no timestamp fallback');
  }
  return failStamp('versionStamp.source must set packageVersion, fromFile, or deployEnv');
}

export function versionStamp(rootDir = process.cwd(), argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));
  const config = pkg.versionStamp;
  if (!config || !Array.isArray(config.edits) || config.edits.length === 0) {
    failStamp('no versionStamp.edits[] in package.json');
  }

  const { version, deterministic } = resolveStampVersion(config.source, rootDir);
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    failStamp(`refusing to stamp suspicious version "${version}"`);
  }
  if (check && !deterministic) {
    console.log('version-stamp: source is per-deploy (non-deterministic) — nothing to check.');
    return;
  }

  let drift = false;
  for (const edit of config.edits) {
    const { file, find, replace, flags } = edit;
    if (!file || !find || replace == null) {
      failStamp(`each edit needs { file, find, replace }; got ${JSON.stringify(edit)}`);
    }
    const dest = resolve(rootDir, file);
    const src = readFileSync(dest, 'utf8');
    let re;
    try {
      re = new RegExp(find, flags || '');
    } catch (e) {
      return failStamp(`invalid regex in edit for ${file}: /${find}/${flags || ''} — ${e.message}`);
    }
    if (!re.test(src)) failStamp(`pattern ${find} not found in ${file}`);
    const out = replace.replaceAll('{version}', version);
    // Function replacer so `$`-sequences in `out` are treated literally. Reusing
    // `re` is safe: String.replace with a global regex ignores/ resets lastIndex.
    const next = src.replace(re, () => out);
    if (next === src) continue; // already stamped
    if (check) {
      drift = true;
      console.error(`version-stamp: ${file} is out of date (expected ${version})`);
    } else {
      writeFileSync(dest, next);
      console.log(`version-stamp: stamped ${version} into ${file}`);
    }
  }

  if (check && drift) failStamp('run `npm run version:stamp` and commit the result.');
  if (check) console.log(`version-stamp: all files in sync at ${version}.`);
}
