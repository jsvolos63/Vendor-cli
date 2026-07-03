// Tests for runVendorCli — the family's shared vendoring CLI, driven the way
// real kits drive it: by spawning a bin shim (test/fixture-kit/bin/vendor.mjs)
// against a fixture kit that uses every export form the surface derivation
// must handle. Ported from the test-vendor.mjs that used to ship (byte-
// identical) in every kit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('argument validation: bad format, missing --out, --pick outside global', () => {
  const dir = freshDir();
  assert.notEqual(run(['--format', 'nope', '--out', 'x.js'], dir).status, 0);
  assert.notEqual(run(['--format', 'esm'], dir).status, 0);
  assert.notEqual(run(['--format', 'esm', '--out', 'x.js', '--pick', 'a'], dir).status, 0);
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
