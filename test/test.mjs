// Tests for runVendorCli — the family's shared vendoring CLI, driven the way
// real kits drive it: by spawning a bin shim (test/fixture-kit/bin/vendor.mjs)
// against a fixture kit that uses every export form the surface derivation
// must handle. Ported from the test-vendor.mjs that used to ship (byte-
// identical) in every kit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KIT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixture-kit');
const BIN = join(KIT_DIR, 'bin', 'vendor.mjs');
const pkg = JSON.parse(readFileSync(join(KIT_DIR, 'package.json'), 'utf8'));
const source = readFileSync(join(KIT_DIR, 'index.js'), 'utf8');

// Mirror of the bin's surface derivation, kept intentionally simple: every
// top-level export declaration name plus aggregate `export { a as b }` aliases.
function exportedNames(esm) {
  const names = [];
  const declRe = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/gm;
  let m;
  while ((m = declRe.exec(esm)) !== null) names.push(m[1]);
  const aggRe = /^export\s*\{([^}]*)\}\s*;?\s*$/gm;
  while ((m = aggRe.exec(esm)) !== null) {
    for (const part of m[1].split(',')) {
      const spec = part.trim();
      if (!spec) continue;
      const alias = spec.match(/^([A-Za-z0-9_$]+)(?:\s+as\s+([A-Za-z0-9_$]+))?$/);
      if (alias) names.push(alias[2] || alias[1]);
    }
  }
  return names;
}

const NAMES = exportedNames(source);

function run(args, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
}

function syntaxCheck(file) {
  return spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
}

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-test-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the kit has a non-empty derived export surface', () => {
  assert.ok(NAMES.length > 0, 'exportedNames found nothing — derivation regex or kit layout changed');
});

test('esm format: provenance header + verbatim source', () => {
  const dir = freshDir();
  const r = run(['--format', 'esm', '--out', 'out.js'], dir);
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(join(dir, 'out.js'), 'utf8');
  assert.ok(out.startsWith(`// VENDORED from ${pkg.name} v${pkg.version} (github:`));
  assert.ok(out.includes('DO NOT EDIT'));
  assert.ok(out.endsWith(source), 'esm output must end with the unmodified source');
});

// The surface map is the object literal assigned at the very end of the
// generated file; slice from the assignment marker so indented `key:` lines
// in the kit's own source can't be mistaken for surface entries.
function surfaceMapNames(out, marker) {
  const idx = out.indexOf(marker);
  assert.notEqual(idx, -1, `generated output must contain "${marker}"`);
  return [...out.slice(idx).matchAll(/^  ([A-Za-z0-9_$]+): /gm)].map((m) => m[1]);
}

test('global format: parseable classic script exposing every export on the named global', () => {
  const dir = freshDir();
  const r = run(['--format', 'global', '--name', 'TestKitGlobal', '--out', 'out.global.js'], dir);
  assert.equal(r.status, 0, r.stderr);
  const file = join(dir, 'out.global.js');
  const out = readFileSync(file, 'utf8');
  assert.equal(syntaxCheck(file).status, 0, 'global output must parse as a classic script');
  assert.ok(!/^export\s/m.test(out), 'no export keywords may survive');
  const mapped = surfaceMapNames(out, 'globalThis.TestKitGlobal = {');
  assert.deepEqual([...mapped].sort(), [...NAMES].sort(), 'surface map must expose exactly the derived exports');
});

test('global format: --name is required and validated', () => {
  const dir = freshDir();
  assert.notEqual(run(['--format', 'global', '--out', 'x.js'], dir).status, 0);
  assert.notEqual(run(['--format', 'global', '--name', 'not a name', '--out', 'x.js'], dir).status, 0);
});

test('global format: --pick narrows the surface and rejects unknown names', () => {
  const dir = freshDir();
  const pickTwo = NAMES.slice(0, 2);
  const r = run(['--format', 'global', '--name', 'G', '--pick', pickTwo.join(','), '--out', 'picked.js'], dir);
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(join(dir, 'picked.js'), 'utf8');
  const mapped = surfaceMapNames(out, 'globalThis.G = {');
  assert.deepEqual([...mapped].sort(), [...pickTwo].sort());

  const bad = run(['--format', 'global', '--name', 'G', '--pick', 'definitelyNotAnExport', '--out', 'x.js'], dir);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /definitelyNotAnExport/);
});

// Extract one global's surface map from a (possibly multi-global) output:
// the entries between `globalThis.<name> = {` and its closing `};`.
function globalMapNames(out, name) {
  const m = out.match(new RegExp(`^globalThis\\.${name} = \\{\\n([^}]*)\\};`, 'm'));
  assert.ok(m, `output must assign globalThis.${name}`);
  return [...m[1].matchAll(/^  ([A-Za-z0-9_$]+): /gm)].map((x) => x[1]);
}

test('global format: repeatable --global emits several named globals over ONE kit body', () => {
  const dir = freshDir();
  const a = NAMES.slice(0, 2);
  const b = NAMES.slice(2, 4);
  const r = run(
    ['--format', 'global', '--global', `GlobA:${a.join(',')}`, '--global', `GlobB:${b.join(',')}`, '--out', 'multi.js'],
    dir
  );
  assert.equal(r.status, 0, r.stderr);
  const file = join(dir, 'multi.js');
  const out = readFileSync(file, 'utf8');
  assert.equal(syntaxCheck(file).status, 0, 'multi-global output must parse as a classic script');
  assert.ok(!/^export\s/m.test(out), 'no export keywords may survive');
  assert.deepEqual([...globalMapNames(out, 'GlobA')].sort(), [...a].sort());
  assert.deepEqual([...globalMapNames(out, 'GlobB')].sort(), [...b].sort());
  // The whole point of the flag: one emitted body shared by every global —
  // not the full bundle once per global (the consumer double-ship this fixes).
  assert.equal(out.split('function greet(').length - 1, 1, 'kit body must be emitted exactly once');
});

test('global format: a single --global spelling emits exactly the legacy --name/--pick bytes', () => {
  const dir = freshDir();
  const picks = NAMES.slice(0, 2).join(',');
  assert.equal(run(['--format', 'global', '--name', 'G', '--pick', picks, '--out', 'legacy.js'], dir).status, 0);
  assert.equal(run(['--format', 'global', '--global', `G:${picks}`, '--out', 'spec.js'], dir).status, 0);
  assert.equal(readFileSync(join(dir, 'spec.js'), 'utf8'), readFileSync(join(dir, 'legacy.js'), 'utf8'));
  // …and a pickless --global matches --name's full surface.
  assert.equal(run(['--format', 'global', '--name', 'G', '--out', 'legacy-full.js'], dir).status, 0);
  assert.equal(run(['--format', 'global', '--global', 'G', '--out', 'spec-full.js'], dir).status, 0);
  assert.equal(readFileSync(join(dir, 'spec-full.js'), 'utf8'), readFileSync(join(dir, 'legacy-full.js'), 'utf8'));
});

test('--global validation: global-format-only, exclusive with --name/--pick, names/picks/dupes checked', () => {
  const dir = freshDir();
  assert.notEqual(run(['--format', 'esm', '--global', 'G', '--out', 'x.js'], dir).status, 0);
  assert.notEqual(run(['--format', 'global', '--name', 'G', '--global', 'H', '--out', 'x.js'], dir).status, 0);
  assert.notEqual(run(['--format', 'global', '--pick', NAMES[0], '--global', 'H', '--out', 'x.js'], dir).status, 0);
  assert.notEqual(run(['--format', 'global', '--global', 'not a name:x', '--out', 'x.js'], dir).status, 0);
  assert.notEqual(run(['--format', 'global', '--global', 'G:', '--out', 'x.js'], dir).status, 0, 'empty pick list after ":" must fail');
  assert.notEqual(run(['--format', 'global', '--global', 'G', '--global', 'G', '--out', 'x.js'], dir).status, 0, 'duplicate global names must fail');
  const bad = run(['--format', 'global', '--global', 'G:definitelyNotAnExport', '--out', 'x.js'], dir);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /definitelyNotAnExport/);
});

test('--check: passes in sync and fails on drift for a multi-global destination', () => {
  const dir = freshDir();
  const args = ['--format', 'global', '--global', `A2:${NAMES[0]}`, '--global', `B2:${NAMES[1]}`, '--out', 'v2.js'];
  assert.equal(run(args, dir).status, 0);
  assert.equal(run([...args, '--check'], dir).status, 0, 'freshly generated multi-global copy must be in sync');
  writeFileSync(join(dir, 'v2.js'), readFileSync(join(dir, 'v2.js'), 'utf8') + '\n// tampered\n');
  assert.notEqual(run([...args, '--check'], dir).status, 0, 'tampered multi-global copy must fail the check');
});

test('bare format: parseable, export-free, no global assignment', () => {
  const dir = freshDir();
  const r = run(['--format', 'bare', '--out', 'out.bare.js'], dir);
  assert.equal(r.status, 0, r.stderr);
  const file = join(dir, 'out.bare.js');
  const out = readFileSync(file, 'utf8');
  assert.equal(syntaxCheck(file).status, 0, 'bare output must parse as a classic script');
  assert.ok(!/^export\s/m.test(out), 'no export keywords may survive');
  // The kit source may legitimately *reference* globalThis; what bare must
  // not do is emit the surface-map assignment the global format adds.
  assert.ok(!/^globalThis\.[A-Za-z_$][A-Za-z0-9_$]* = \{$/m.test(out), 'bare output must not assign a surface global');
  assert.ok(!out.includes('module.exports'));
});

test('cjs format: parseable and exports the full derived surface', () => {
  const dir = freshDir();
  const r = run(['--format', 'cjs', '--out', 'out.cjs'], dir);
  assert.equal(r.status, 0, r.stderr);
  const file = join(dir, 'out.cjs');
  const out = readFileSync(file, 'utf8');
  assert.equal(syntaxCheck(file).status, 0, 'cjs output must parse');
  const mapped = surfaceMapNames(out, 'module.exports = {');
  assert.deepEqual([...mapped].sort(), [...NAMES].sort(), 'module.exports must expose exactly the derived exports');
});

test('cjs format: --pick narrows module.exports (body kept whole)', () => {
  const dir = freshDir();
  const pickTwo = NAMES.slice(0, 2);
  const r = run(['--format', 'cjs', '--pick', pickTwo.join(','), '--out', 'picked.cjs'], dir);
  assert.equal(r.status, 0, r.stderr);
  const file = join(dir, 'picked.cjs');
  const out = readFileSync(file, 'utf8');
  assert.equal(syntaxCheck(file).status, 0, 'picked cjs output must parse');
  const mapped = surfaceMapNames(out, 'module.exports = {');
  assert.deepEqual([...mapped].sort(), [...pickTwo].sort());
  // Unpicked DECLARATIONS still exist in the body — only the exposed API
  // narrows. (Aggregate-alias names like helperAlias are exports-map-only, so
  // assert on the fixture's local declaration names.)
  for (const name of ['greet', 'fetchThing', 'ANSWER', 'Widget', 'doubled', 'internalHelper']) {
    assert.ok(out.includes(name), `body keeps ${name}`);
  }
});

test('--check: passes in sync, fails on drift, fails when missing', () => {
  const dir = freshDir();
  const args = ['--format', 'global', '--name', 'G', '--out', 'v.js'];
  assert.notEqual(run([...args, '--check'], dir).status, 0, 'missing dest must fail');

  assert.equal(run(args, dir).status, 0);
  assert.equal(run([...args, '--check'], dir).status, 0, 'freshly generated copy must be in sync');

  writeFileSync(join(dir, 'v.js'), readFileSync(join(dir, 'v.js'), 'utf8') + '\n// tampered\n');
  const drift = run([...args, '--check'], dir);
  assert.notEqual(drift.status, 0, 'tampered copy must fail the check');
  assert.match(drift.stderr, /out of sync/);
});

test('argument validation: bad format, missing --out, --pick outside global/cjs', () => {
  const dir = freshDir();
  assert.notEqual(run(['--format', 'nope', '--out', 'x.js'], dir).status, 0);
  assert.notEqual(run(['--format', 'esm'], dir).status, 0);
  assert.notEqual(run(['--format', 'esm', '--out', 'x.js', '--pick', 'a'], dir).status, 0);
  assert.notEqual(run(['--format', 'bare', '--out', 'x.js', '--pick', 'a'], dir).status, 0);
});

test('unsupported export forms (default / re-export-from / export *) fail loudly', () => {
  // Each of these previously slipped past both the surface derivation and the
  // export stripping, emitting broken output (`default x` is a syntax error)
  // or a silently incomplete surface. Generation must refuse instead.
  const dir = freshDir();
  const CLI = join(KIT_DIR, '..', '..', 'index.mjs');
  let n = 0;
  const makeKitBin = (body) => {
    const kit = join(dir, `bad-kit-${n++}`);
    mkdirSync(join(kit, 'bin'), { recursive: true });
    writeFileSync(
      join(kit, 'package.json'),
      JSON.stringify({ name: '@jfs/bad-kit', version: '1.0.0', type: 'module' }) + '\n'
    );
    writeFileSync(join(kit, 'index.js'), body);
    writeFileSync(
      join(kit, 'bin', 'vendor.mjs'),
      `import { runVendorCli } from ${JSON.stringify(pathToFileURL(CLI).href)};\n` +
        `runVendorCli(${JSON.stringify(kit)});\n`
    );
    return join(kit, 'bin', 'vendor.mjs');
  };
  const cases = [
    'export default function greet() {}\nexport const A = 1;\n',
    "export const A = 1;\nexport { A as B } from './other.js';\n",
    "export const A = 1;\nexport * from './other.js';\n",
  ];
  for (const body of cases) {
    const bin = makeKitBin(body);
    const r = spawnSync(process.execPath, [bin, '--format', 'cjs', '--out', 'out.cjs'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(r.status, 1, `expected failure for: ${body.split('\n')[1] || body}\n${r.stderr}`);
    assert.match(r.stderr, /unsupported export form/);
  }
  // A kit using only the supported forms still generates fine (the fixture
  // kit itself — exercised throughout this file — is the positive case).
});

// ------------------------------------------------- fixture-exact assertions
// The generic tests above derive expectations from the fixture's source; these
// pin the concrete surface so a regression in the derivation itself (not just
// a fixture change) is caught with exact values.

test('fixture surface derives exactly the expected names', () => {
  assert.deepEqual(
    [...NAMES].sort(),
    ['ANSWER', 'THE_ANSWER', 'Widget', 'doubled', 'fetchThing', 'greet', 'helperAlias'].sort()
  );
});

test('global format output is executable and the surface works', async () => {
  const dir = freshDir();
  const r = run(['--format', 'global', '--name', 'FixtureKit', '--out', 'g.js'], dir);
  assert.equal(r.status, 0, r.stderr);
  const code = readFileSync(join(dir, 'g.js'), 'utf8');
  // Execute the IIFE in this process and probe the exposed global.
  (0, eval)(code);
  assert.equal(globalThis.FixtureKit.greet('kit'), 'hello kit');
  assert.equal(globalThis.FixtureKit.THE_ANSWER, 42);
  assert.equal(globalThis.FixtureKit.helperAlias(21), 42);
  assert.equal(new globalThis.FixtureKit.Widget('w1').id, 'w1');
  delete globalThis.FixtureKit;
});

test('multi-global output is executable and each global exposes only its picks', () => {
  const dir = freshDir();
  const r = run(
    ['--format', 'global', '--global', 'FixA:greet,THE_ANSWER', '--global', 'FixB:doubled', '--out', 'g2.js'],
    dir
  );
  assert.equal(r.status, 0, r.stderr);
  (0, eval)(readFileSync(join(dir, 'g2.js'), 'utf8'));
  assert.equal(globalThis.FixA.greet('kit'), 'hello kit');
  assert.equal(globalThis.FixA.THE_ANSWER, 42);
  assert.equal(globalThis.FixB.doubled(21), 42);
  assert.equal(globalThis.FixA.doubled, undefined, 'FixA must not expose FixB picks');
  assert.equal(globalThis.FixB.greet, undefined, 'FixB must not expose FixA picks');
  delete globalThis.FixA;
  delete globalThis.FixB;
});

test('cjs format output is require()-able with a working surface', async () => {
  const dir = freshDir();
  const r = run(['--format', 'cjs', '--out', 'k.cjs'], dir);
  assert.equal(r.status, 0, r.stderr);
  const { createRequire } = await import('node:module');
  const mod = createRequire(import.meta.url)(join(dir, 'k.cjs'));
  assert.equal(mod.greet('cjs'), 'hello cjs');
  assert.equal(mod.ANSWER, 42);
  assert.equal(mod.helperAlias(2), 4);
});

test('header carries the fixture package version', () => {
  const dir = freshDir();
  const r = run(['--format', 'esm', '--out', 'h.js'], dir);
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(join(dir, 'h.js'), 'utf8');
  assert.ok(out.startsWith('// VENDORED from @jfs/fixture-kit v9.9.9 (github:jsvolos63/fixture-kit)'));
});
