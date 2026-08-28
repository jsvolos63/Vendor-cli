// Tests for runVendorCli — the family's shared vendoring CLI, driven the way
// real kits drive it: by spawning a bin shim (test/fixture-kit/bin/vendor.mjs)
// against a fixture kit that uses every export form the surface derivation
// must handle. Ported from the test-vendor.mjs that used to ship (byte-
// identical) in every kit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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

test('cjs format: --pick narrows module.exports AND tree-shakes the body', () => {
  const dir = freshDir();
  const r = run(['--format', 'cjs', '--pick', 'greet,fetchThing', '--out', 'picked.cjs'], dir);
  assert.equal(r.status, 0, r.stderr);
  const file = join(dir, 'picked.cjs');
  const out = readFileSync(file, 'utf8');
  assert.equal(syntaxCheck(file).status, 0, 'picked cjs output must parse');
  const mapped = surfaceMapNames(out, 'module.exports = {');
  assert.deepEqual([...mapped].sort(), ['fetchThing', 'greet']);
  assert.ok(out.includes('function greet('), 'picked declarations survive');
  assert.ok(out.includes('async function fetchThing('), 'picked declarations survive');
  // …and everything the picks cannot reach is gone from the shipped bytes —
  // the whole point: a narrowed surface must not carry the rest of the kit.
  for (const gone of ['class Widget', 'function doubled(', 'function internalHelper(', 'const ANSWER']) {
    assert.ok(!out.includes(gone), `unreachable declaration dropped: ${gone}`);
  }
  assert.match(r.stdout, /tree-shaken/);
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

test('argument validation: bad format, missing --out, --pick in every format', () => {
  const dir = freshDir();
  assert.notEqual(run(['--format', 'nope', '--out', 'x.js'], dir).status, 0);
  assert.notEqual(run(['--format', 'esm'], dir).status, 0);
  // --pick is accepted in EVERY format now (esm shakes the body too); an
  // unknown name is still an error, and an empty list is refused outright.
  for (const format of ['esm', 'cjs']) {
    const bad = run(['--format', format, '--out', 'x.js', '--pick', 'definitelyNotAnExport'], dir);
    assert.notEqual(bad.status, 0, `${format}: a typo'd pick must fail`);
    assert.match(bad.stderr, /definitelyNotAnExport/);
    assert.equal(existsSync(join(dir, 'x.js')), false);
    const ok = run(['--format', format, '--out', `ok.${format}.js`, '--pick', NAMES[0]], dir);
    assert.equal(ok.status, 0, `${format}: a real pick must be accepted — ${ok.stderr}`);
    assert.notEqual(run(['--format', format, '--out', 'y.js', '--pick', ' , '], dir).status, 0, `${format}: empty pick list`);
  }
});

// --------------------------------------------------------- fail-closed gate
// A kit whose source uses a form the surface derivation can't handle must stop
// generation. The failure mode this guards is the nasty one: a plausible
// artifact, exit code 0, a reassuring log line — and `vendor:check` blind to
// it, because the committed copy and the regenerated copy share the omission.
//
// Every case below asserts BOTH a non-zero exit AND that no output file was
// produced (and that a pre-existing file at the destination is left untouched,
// so a refusal can never leave a partial or stale artifact behind).

let badKitSeq = 0;
const CLI_PATH = join(KIT_DIR, '..', '..', 'index.mjs');

// Build a throwaway kit (package.json + index.js + the same bin shim shape the
// real kits ship) around `body`, and return its bin path.
function makeKitBin(dir, body, { sideEffects = false } = {}) {
  const kit = join(dir, `kit-${badKitSeq++}`);
  mkdirSync(join(kit, 'bin'), { recursive: true });
  writeFileSync(
    join(kit, 'package.json'),
    JSON.stringify({
      name: '@jfs/bad-kit',
      version: '1.0.0',
      type: 'module',
      // The kits all declare this, and the tree-shaker requires it (see the
      // gate test below), so the throwaway kits mirror them by default.
      ...(sideEffects === false ? { sideEffects: false } : {}),
    }) + '\n'
  );
  writeFileSync(join(kit, 'index.js'), body);
  writeFileSync(
    join(kit, 'bin', 'vendor.mjs'),
    `import { runVendorCli } from ${JSON.stringify(pathToFileURL(CLI_PATH).href)};\n` +
      `runVendorCli(${JSON.stringify(kit)});\n`
  );
  return join(kit, 'bin', 'vendor.mjs');
}

function runKit(bin, args, cwd) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
}

// Assert `body` is refused for `format`: non-zero exit, nothing written, and a
// pre-existing destination left byte-identical.
function assertRefused(label, body, format = 'cjs', extraArgs = [], kitOpts = {}) {
  const dir = freshDir();
  const bin = makeKitBin(dir, body, kitOpts);
  const out = 'out.generated.js';
  const dest = join(dir, out);

  const r = runKit(bin, ['--format', format, '--out', out, ...extraArgs], dir);
  assert.notEqual(r.status, 0, `${label}: expected a non-zero exit\nstdout: ${r.stdout}`);
  assert.equal(existsSync(dest), false, `${label}: refusal must not write ${out}`);
  assert.doesNotMatch(r.stdout, /wrote /, `${label}: must not log a successful write`);

  // …and with a stale artifact already sitting at the destination, the refusal
  // must leave it exactly as it was (no truncate, no partial rewrite).
  const stale = '// previously generated\nmodule.exports = {};\n';
  writeFileSync(dest, stale);
  const again = runKit(bin, ['--format', format, '--out', out, ...extraArgs], dir);
  assert.notEqual(again.status, 0, `${label}: expected a non-zero exit (stale-dest run)`);
  assert.equal(readFileSync(dest, 'utf8'), stale, `${label}: refusal must not touch a stale ${out}`);
  return r;
}

test('fail-closed: export forms the derivation cannot handle are refused', () => {
  // Previously each of these produced a BAD ARTIFACT with exit code 0: the
  // export was missing from the derived surface (silently unavailable to the
  // consumer) or the stripped body was a syntax error.
  const cases = [
    ['export var', 'export const A = 1;\nexport var B = 2;\n'],
    ['export function*', 'export const A = 1;\nexport function* gen() { yield 1; }\n'],
    [
      'export async function*',
      'export const A = 1;\nexport async function* agen() { yield 1; }\n',
    ],
    [
      'export const {…} destructuring',
      'const src = { C: 3, D: 4 };\nexport const A = 1;\nexport const { C, D } = src;\n',
    ],
    [
      'export const […] destructuring',
      'const pair = [1, 2];\nexport const A = 1;\nexport const [E, F] = pair;\n',
    ],
    ['export let destructuring', 'const s = { G: 1 };\nexport const A = 1;\nexport let { G } = s;\n'],
    ['export enum-ish unknown form', 'export const A = 1;\nexport type Foo = 1;\n'],
  ];
  for (const [label, body] of cases) {
    const r = assertRefused(label, body);
    assert.match(r.stderr, /cannot derive/, `${label}: stderr should name the undeliverable exports`);
  }
});

test('fail-closed: the refused export is named with its line', () => {
  const dir = freshDir();
  const bin = makeKitBin(dir, 'export const A = 1;\nexport var B = 2;\n');
  const r = runKit(bin, ['--format', 'cjs', '--out', 'out.cjs'], dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /line 2: export var B = 2;/);
});

test('fail-closed: unsupported export forms (default / re-export-from / export *) still name the form', () => {
  const cases = [
    ['export default', 'export default function greet() {}\nexport const A = 1;\n'],
    ['re-export-from', "export const A = 1;\nexport { A as B } from './other.js';\n"],
    ['export *', "export const A = 1;\nexport * from './other.js';\n"],
  ];
  for (const [label, body] of cases) {
    const r = assertRefused(label, body);
    assert.match(r.stderr, /unsupported export form/, `${label}: keeps the specific diagnostic`);
  }
});

test('fail-closed: a static import is refused for classic-script/CommonJS formats', () => {
  // This emitted the `import` line verbatim into the cjs/global builds:
  // `node --check` on the result is a SyntaxError, and a classic service
  // worker importScripts()-ing it fails install.
  const body = "import { createHash } from 'node:crypto';\nexport const A = createHash;\n";
  for (const format of ['cjs', 'global']) {
    const extra = format === 'global' ? ['--name', 'G'] : [];
    const r = assertRefused(`static import (${format})`, body, format, extra);
    assert.match(r.stderr, /static import/);
  }
  // The esm format IS a module, so a bare-specifier import is fine there.
  const dir = freshDir();
  const bin = makeKitBin(dir, body);
  const ok = runKit(bin, ['--format', 'esm', '--out', 'ok.esm.js'], dir);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(readFileSync(join(dir, 'ok.esm.js'), 'utf8').includes("from 'node:crypto'"));
});

test('fail-closed: a relative import is refused in every format (a kit is one file)', () => {
  const body = "import { helper } from './helper.js';\nexport const A = helper;\n";
  for (const format of ['esm', 'cjs']) {
    const r = assertRefused(`relative import (${format})`, body, format);
    assert.match(r.stderr, /relative import/);
  }
});

test('fail-closed: import.meta is refused for classic-script/CommonJS formats', () => {
  const body = 'export const A = 1;\nexport const HERE = import.meta.url;\n';
  for (const format of ['cjs', 'global']) {
    const extra = format === 'global' ? ['--name', 'G'] : [];
    const r = assertRefused(`import.meta (${format})`, body, format, extra);
    assert.match(r.stderr, /import\.meta/);
  }
  // Verbatim esm keeps working — it really is a module.
  const dir = freshDir();
  const bin = makeKitBin(dir, body);
  assert.equal(runKit(bin, ['--format', 'esm', '--out', 'meta.esm.js'], dir).status, 0);
});

test('fail-closed: dynamic import() is NOT refused (legal in every emitted format)', () => {
  const dir = freshDir();
  const bin = makeKitBin(dir, "export const load = () => import('node:crypto');\n");
  for (const [format, extra] of [['cjs', []], ['global', ['--name', 'G']]]) {
    const out = `dyn.${format}.js`;
    const r = runKit(bin, ['--format', format, '--out', out, ...extra], dir);
    assert.equal(r.status, 0, `${format}: ${r.stderr}`);
    assert.equal(syntaxCheck(join(dir, out)).status, 0, `${format} output must parse`);
  }
});

test('tree-shaking: a dynamic import() stays verbatim, never resolved from the temp dir', () => {
  // Bare specifiers must not be bundle-resolved: resolution from the shake
  // temp dir walks up into /tmp/node_modules, a world-writable ancestor —
  // a planted module there would be inlined into a committed, shipped copy.
  const dir = freshDir();
  const bin = makeKitBin(dir,
    "export const load = () => import('some-lazy-pkg');\n" +
    'export function unrelated() {\n  return 1;\n}\n');
  const r = runKit(bin, ['--format', 'cjs', '--pick', 'load', '--out', 'dyn.cjs'], dir);
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(join(dir, 'dyn.cjs'), 'utf8');
  assert.match(out, /import\("some-lazy-pkg"\)/, 'the specifier survives verbatim');
  assert.ok(!out.includes('unrelated'), 'still narrowed');
});

test('control: a well-formed kit still generates its FULL surface in every format', async () => {
  // The regression the gate exists to prevent, from the other side: nothing
  // above may cost a well-formed kit any of its exports.
  const dir = freshDir();
  const bin = makeKitBin(
    dir,
    'export function greet(n) { return `hi ${n}`; }\n' +
      'export async function pull() { return 1; }\n' +
      'export const ANSWER = 42;\n' +
      'export let counter = 0;\n' +
      'export class Widget { constructor(id) { this.id = id; } }\n' +
      'function helper(x) { return x * 2; }\n' +
      'export { helper as helperAlias, ANSWER as THE_ANSWER };\n'
  );
  const all = ['greet', 'pull', 'ANSWER', 'counter', 'Widget', 'helperAlias', 'THE_ANSWER'];

  assert.equal(runKit(bin, ['--format', 'esm', '--out', 'c.esm.js'], dir).status, 0);
  const esm = readFileSync(join(dir, 'c.esm.js'), 'utf8');
  for (const n of all) assert.ok(esm.includes(n), `esm keeps ${n}`);

  const g = runKit(bin, ['--format', 'global', '--name', 'Ctl', '--out', 'c.global.js'], dir);
  assert.equal(g.status, 0, g.stderr);
  assert.match(g.stdout, new RegExp(`${all.length} of ${all.length} exports`));
  assert.equal(syntaxCheck(join(dir, 'c.global.js')).status, 0);
  assert.deepEqual(
    [...globalMapNames(readFileSync(join(dir, 'c.global.js'), 'utf8'), 'Ctl')].sort(),
    [...all].sort()
  );

  const c = runKit(bin, ['--format', 'cjs', '--out', 'c.cjs'], dir);
  assert.equal(c.status, 0, c.stderr);
  const { createRequire } = await import('node:module');
  const mod = createRequire(import.meta.url)(join(dir, 'c.cjs'));
  assert.deepEqual(Object.keys(mod).sort(), [...all].sort(), 'require() must expose every export');
  assert.equal(mod.greet('kit'), 'hi kit');
  assert.equal(mod.THE_ANSWER, 42);
  assert.equal(mod.helperAlias(21), 42);
});

// ------------------------------------------------------------ tree-shaking
// A narrowed --pick/--global surface must narrow the emitted BYTES too (the
// prerequisite for merging kits: otherwise a consumer that wants one escaper
// pays for the whole merged kit). The properties asserted here are the ones
// the family depends on: reachable code survives, unreachable code goes, a
// full surface is untouched, sanitizer-policy markers always survive, and the
// output is deterministic.

// Kit shaped like a real one: a picked export, its private helper, and a
// completely independent subsystem that the pick must not drag along.
const SHAKE_KIT =
  '// Kit preamble — documents the file, not any one declaration.\n' +
  '\n' +
  '// doc for SMALL\n' +
  'const SMALL = 2;\n' +
  '\n' +
  'function timesSmall(x) {\n' +
  '  return x * SMALL;\n' +
  '}\n' +
  '\n' +
  'export function reachable(x) {\n' +
  '  return timesSmall(x);\n' +
  '}\n' +
  '\n' +
  '// ---- the unrelated subsystem ----\n' +
  'const BIG_TABLE = { a: 1, b: 2 };\n' +
  '\n' +
  'function bigHelper(k) {\n' +
  '  return BIG_TABLE[k];\n' +
  '}\n' +
  '\n' +
  'export function unrelated(k) {\n' +
  '  return bigHelper(k);\n' +
  '}\n' +
  '\n' +
  'export { timesSmall as timesSmallAlias };\n';

test('tree-shaking: a picked surface keeps what it reaches and drops what it does not', async () => {
  const dir = freshDir();
  const bin = makeKitBin(dir, SHAKE_KIT);
  const r = runKit(bin, ['--format', 'cjs', '--pick', 'reachable', '--out', 'shaken.cjs'], dir);
  assert.equal(r.status, 0, r.stderr);
  const file = join(dir, 'shaken.cjs');
  const out = readFileSync(file, 'utf8');
  assert.equal(syntaxCheck(file).status, 0, 'shaken output must parse');

  assert.ok(out.includes('function reachable('), 'the picked export survives');
  assert.ok(out.includes('function timesSmall('), 'a helper it calls survives');
  assert.match(out, /(?:const|var) SMALL = 2;/, 'a constant that helper reads survives');
  assert.ok(out.includes('// Kit preamble'), 'the file preamble always survives');

  assert.ok(!out.includes('unrelated'), 'an unpicked export is dropped');
  assert.ok(!out.includes('bigHelper'), 'its private helper is dropped');
  assert.ok(!out.includes('BIG_TABLE'), 'its data is dropped');
  assert.ok(!out.includes('the unrelated subsystem'), "the dropped code's comments go with it");

  const { createRequire } = await import('node:module');
  const mod = createRequire(import.meta.url)(file);
  assert.deepEqual(Object.keys(mod), ['reachable']);
  assert.equal(mod.reachable(21), 42, 'the shaken body still works');
});

test('tree-shaking: an aggregate alias roots its LOCAL declaration', () => {
  const dir = freshDir();
  const bin = makeKitBin(dir, SHAKE_KIT);
  // `timesSmallAlias` is exported only via `export { timesSmall as … }`, so the
  // shake must root `timesSmall` (and, through it, SMALL) — not the alias name.
  const r = runKit(bin, ['--format', 'cjs', '--pick', 'timesSmallAlias', '--out', 'alias.cjs'], dir);
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(join(dir, 'alias.cjs'), 'utf8');
  assert.equal(syntaxCheck(join(dir, 'alias.cjs')).status, 0);
  assert.ok(out.includes('function timesSmall('));
  assert.match(out, /(?:const|var) SMALL = 2;/);
  assert.ok(!out.includes('function reachable('), 'the export that merely calls it is not a root');
  assert.match(out, /module\.exports = \{\n {2}timesSmallAlias: timesSmall,\n\};/);
});

test('tree-shaking: multi --global shakes to the UNION of the picks, over one body', () => {
  const dir = freshDir();
  const bin = makeKitBin(dir, SHAKE_KIT);
  const r = runKit(
    bin,
    ['--format', 'global', '--global', 'A:reachable', '--global', 'B:unrelated', '--out', 'union.js'],
    dir
  );
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(join(dir, 'union.js'), 'utf8');
  assert.equal(syntaxCheck(join(dir, 'union.js')).status, 0);
  for (const kept of ['function reachable(', 'function timesSmall(', 'function unrelated(', 'function bigHelper(']) {
    assert.ok(out.includes(kept), `union keeps ${kept}`);
  }
  assert.equal(out.split('function reachable(').length - 1, 1, 'still ONE shared body');
  (0, eval)(out);
  assert.equal(globalThis.A.reachable(21), 42);
  assert.equal(globalThis.B.unrelated('b'), 2);
  assert.equal(globalThis.A.unrelated, undefined);
  delete globalThis.A;
  delete globalThis.B;
});

test('tree-shaking: a FULL surface is not shaken — the body stays byte-identical', () => {
  const dir = freshDir();
  const bin = makeKitBin(dir, SHAKE_KIT);
  // Same transformation the generator applies to an unshaken body.
  const expectedBody = SHAKE_KIT.replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/^export\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n');

  assert.equal(runKit(bin, ['--format', 'cjs', '--out', 'full.cjs'], dir).status, 0);
  assert.ok(readFileSync(join(dir, 'full.cjs'), 'utf8').includes(expectedBody), 'no --pick: verbatim body');

  // …and an explicit pick list covering the whole surface is the same thing.
  const all = 'reachable,unrelated,timesSmallAlias';
  assert.equal(runKit(bin, ['--format', 'cjs', '--pick', all, '--out', 'all.cjs'], dir).status, 0);
  assert.ok(readFileSync(join(dir, 'all.cjs'), 'utf8').includes(expectedBody), 'full pick list: verbatim body');
});

test('tree-shaking: output is deterministic across runs', () => {
  const dir = freshDir();
  const bin = makeKitBin(dir, SHAKE_KIT);
  const args = ['--format', 'global', '--global', 'D:reachable', '--out'];
  assert.equal(runKit(bin, [...args, 'det1.js'], dir).status, 0);
  assert.equal(runKit(bin, [...args, 'det2.js'], dir).status, 0);
  assert.equal(readFileSync(join(dir, 'det1.js'), 'utf8'), readFileSync(join(dir, 'det2.js'), 'utf8'));
  // …which is what makes `vendor:check` on a shaken copy meaningful.
  assert.equal(runKit(bin, [...args, 'det1.js', '--check'], dir).status, 0);
});

// 0.20.0 contract: narrowed builds treat sanitizer-policy regions as
// ordinary code. Nothing downstream reads markers off a vendored copy anymore
// (the per-consumer policy checks were retired; the kit's own policy:check
// gates the SOURCE, and the generation-time gate below covers full-surface
// copies), so a pick that cannot reach the sanitizer drops the whole region —
// no dead policy bytes, no stray markers.
test('tree-shaking: an unreachable sanitizer-policy region is dropped, markers and all', () => {
  const dir = freshDir();
  const kitBody =
    'export function escape(s) {\n  return String(s);\n}\n' +
    '\n' +
    '// policy-managed constant, unreachable from `escape`\n' +
    'const BLOCKED = new Set([\n' +
    '  // @jfs-sanitizer-policy:blocked-tags:start case=upper quote=single\n' +
    '  // @jfs-sanitizer-policy:blocked-tags:end\n' +
    ']);\n' +
    '\n' +
    '// @jfs-sanitizer-policy:url-control-chars:start const=URL_CONTROL_CHARS\n' +
    '// @jfs-sanitizer-policy:url-control-chars:end\n' +
    '\n' +
    'export function sanitize(html) {\n' +
    '  return BLOCKED.has(html) ? "" : html.replace(URL_CONTROL_CHARS, "");\n' +
    '}\n';
  const bin = makeKitBin(dir, kitBody);
  const kitDir = join(dir, `kit-${badKitSeq - 1}`);

  // Fill the regions from the canonical policy, the way each kit does.
  const POLICY_BIN = join(KIT_DIR, '..', '..', 'bin', 'sanitizer-policy-sync.mjs');
  const filled = spawnSync(process.execPath, [POLICY_BIN, 'index.js'], { cwd: kitDir, encoding: 'utf8' });
  assert.equal(filled.status, 0, filled.stderr);

  const r = runKit(bin, ['--format', 'global', '--name', 'Esc', '--pick', 'escape', '--out', 'esc.js'], dir);
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(join(dir, 'esc.js'), 'utf8');
  assert.equal(syntaxCheck(join(dir, 'esc.js')).status, 0);
  assert.ok(!out.includes('function sanitize('), 'the unpicked sanitizer is dropped');
  assert.ok(!out.includes('@jfs-sanitizer-policy'), 'its markers go with it');
  assert.ok(!out.includes('BLOCKED'), 'and so do the policy constants themselves');
});

test('policy gate: a kit whose regions drifted from canonical policy is refused in every format', () => {
  // The generation-time policy gate (0.17.0): every emitted copy carrying a
  // marker is validated against family/sanitizer-policy.json, so a consumer's
  // vendor:check re-verifies canonical policy on every regeneration — no
  // separate consumer-side policy:check needed — and a pin to a kit commit
  // whose regions drifted is refused rather than vendored.
  const dir = freshDir();
  const kitBody =
    '// @jfs-sanitizer-policy:url-control-chars:start const=URL_CONTROL_CHARS\n' +
    '// @jfs-sanitizer-policy:url-control-chars:end\n' +
    '\n' +
    'export function strip(s) {\n' +
    '  return String(s).replace(URL_CONTROL_CHARS, "");\n' +
    '}\n';
  const bin = makeKitBin(dir, kitBody);
  const kitDir = join(dir, `kit-${badKitSeq - 1}`);
  const POLICY_BIN = join(KIT_DIR, '..', '..', 'bin', 'sanitizer-policy-sync.mjs');
  const filled = spawnSync(process.execPath, [POLICY_BIN, 'index.js'], { cwd: kitDir, encoding: 'utf8' });
  assert.equal(filled.status, 0, filled.stderr);

  // In sync with canonical: a full-surface copy generates.
  const ok = runKit(bin, ['--format', 'esm', '--out', 'ok.js'], dir);
  assert.equal(ok.status, 0, ok.stderr);

  // Drift the region's VALUE (keep the markers): every format refuses.
  const synced = readFileSync(join(kitDir, 'index.js'), 'utf8');
  const drifted = synced.replace('/g;', '/gi;');
  assert.notEqual(drifted, synced, 'the tamper must land');
  writeFileSync(join(kitDir, 'index.js'), drifted);
  for (const args of [
    ['--format', 'esm', '--out', 'a.js'],
    ['--format', 'global', '--name', 'G', '--out', 'b.js'],
    ['--format', 'cjs', '--out', 'c.cjs'],
  ]) {
    const r = runKit(bin, args, dir);
    assert.notEqual(r.status, 0, `${args.join(' ')} must refuse a drifted policy region`);
    assert.match(r.stderr, /disagree with the canonical/, args.join(' '));
    assert.ok(!existsSync(join(dir, args[args.length - 1])), 'nothing may be written');
  }
});

test('tree-shaking: a reachable policy region ships as working code, helpers included', async () => {
  // With the graft retired, a policy-marked declaration goes through esbuild
  // like any other code — which is exactly what makes the old failure class
  // (grafted text whose dependencies were shaken out from under it)
  // impossible by construction: esbuild keeps EXTRA_BLOCKED because the kept
  // sanitize() reaches it, values flow from the policy-synced source, and
  // the emitted copy must EVALUATE, not just parse.
  const dir = freshDir();
  const kitBody =
    'export function escape(s) {\n  return String(s);\n}\n' +
    '\n' +
    "const EXTRA_BLOCKED = ['jfs-extra'];\n" +
    '\n' +
    'const BLOCKED = new Set([\n' +
    '  // @jfs-sanitizer-policy:blocked-tags:start case=upper quote=single\n' +
    '  // @jfs-sanitizer-policy:blocked-tags:end\n' +
    '].concat(EXTRA_BLOCKED));\n' +
    '\n' +
    '// @jfs-sanitizer-policy:url-control-chars:start const=URL_CONTROL_CHARS\n' +
    '// @jfs-sanitizer-policy:url-control-chars:end\n' +
    '\n' +
    'export function sanitize(html) {\n' +
    '  return BLOCKED.has(html) ? "" : html.replace(URL_CONTROL_CHARS, "");\n' +
    '}\n';
  const bin = makeKitBin(dir, kitBody);
  const kitDir = join(dir, `kit-${badKitSeq - 1}`);
  const POLICY_BIN = join(KIT_DIR, '..', '..', 'bin', 'sanitizer-policy-sync.mjs');
  const filled = spawnSync(process.execPath, [POLICY_BIN, 'index.js'], { cwd: kitDir, encoding: 'utf8' });
  assert.equal(filled.status, 0, filled.stderr);

  const r = runKit(bin, ['--format', 'cjs', '--pick', 'sanitize', '--out', 'san.cjs'], dir);
  assert.equal(r.status, 0, r.stderr);
  const file = join(dir, 'san.cjs');
  const out = readFileSync(file, 'utf8');
  assert.match(out, /EXTRA_BLOCKED = \[/, "the policy declaration's helper survives");
  assert.ok(!out.includes('function escape('), 'the unpicked escaper is still dropped');
  // The real proof: the copy evaluates, and the canonical policy VALUES made
  // it through the reprint — the control-char strip actually strips.
  const { createRequire } = await import('node:module');
  const mod = createRequire(import.meta.url)(file);
  assert.equal(mod.sanitize('jfs-extra'), '', 'the baked blocked-list works');
  assert.equal(mod.sanitize('a\u0000b\u001Fc'), 'abc', 'the canonical control-char regex works');
});

test('tree-shaking: a kit with a top-level `$` export can be narrowed', async () => {
  // `$` is a legal identifier character and a regex metacharacter;
  // interpolated raw into the post-bundle gates it becomes an end-anchor
  // and the declared-locals gate refuses a legitimate kit.
  const dir = freshDir();
  const kitBody =
    'export const $ = (s) => `[${s}]`;\n' +
    '\n' +
    'export function unrelated() {\n  return 1;\n}\n';
  const bin = makeKitBin(dir, kitBody);
  const r = runKit(bin, ['--format', 'cjs', '--pick', '$', '--out', 'dollar.cjs'], dir);
  assert.equal(r.status, 0, r.stderr);
  const file = join(dir, 'dollar.cjs');
  assert.ok(!readFileSync(file, 'utf8').includes('unrelated'), 'still narrowed');
  const { createRequire } = await import('node:module');
  const mod = createRequire(import.meta.url)(file);
  assert.equal(mod.$('x'), '[x]');
});

test('policy gate: a marker the policy sync cannot recognize refuses generation', () => {
  // The entry guard matches the bare marker prefix, but the sync only
  // recognizes `[a-z-]+` region names — a misspelled name (digit or
  // uppercase) used to open zero regions and pass straight through,
  // silently disabling the gate for that copy.
  const dir = freshDir();
  const kitBody =
    '// @jfs-sanitizer-policy:blockedTags:start\n' +
    "const BLOCKED = ['script'];\n" +
    '// @jfs-sanitizer-policy:blockedTags:end\n' +
    '\n' +
    'export function sanitize(s) {\n  return BLOCKED.includes(s) ? "" : s;\n}\n';
  const bin = makeKitBin(dir, kitBody);
  const r = runKit(bin, ['--format', 'esm', '--out', 'bad.js'], dir);
  assert.notEqual(r.status, 0, 'generation must refuse');
  assert.match(r.stderr, /no marker the policy sync recognizes/);
  assert.ok(!existsSync(join(dir, 'bad.js')), 'nothing may be written');
});

test('tree-shaking: skipped (body kept whole) for a kit that does not declare sideEffects:false', () => {
  const dir = freshDir();
  const bin = makeKitBin(dir, SHAKE_KIT, { sideEffects: true });
  const r = runKit(bin, ['--format', 'cjs', '--pick', 'reachable', '--out', 'unshaken.cjs'], dir);
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(join(dir, 'unshaken.cjs'), 'utf8');
  assert.ok(out.includes('function unrelated('), 'no sideEffects:false means no shaking');
  assert.match(r.stderr, /sideEffects/);
  assert.doesNotMatch(r.stdout, /tree-shaken/);
});

test('fail-closed: a top-level statement the shaker cannot account for refuses the shake', () => {
  // A bare top-level statement may have side effects, and mis-measuring its
  // extent would drop or duplicate real code. Nothing is written.
  const body = 'export const A = 1;\nexport const B = 2;\nglobalThis.__installed = true;\n';
  const r = assertRefused('top-level expression statement', body, 'cjs', ['--pick', 'A']);
  assert.match(r.stderr, /not a declaration this generator can account for/);
  // …but the same kit still vendors fine at its FULL surface (no shake).
  const dir = freshDir();
  const bin = makeKitBin(dir, body);
  assert.equal(runKit(bin, ['--format', 'cjs', '--out', 'full.cjs'], dir).status, 0);
});

test('fail-closed: a declaration with no terminating semicolon refuses the shake', () => {
  // Both shapes ASI makes legal: a following declaration, and a following
  // expression statement (which would otherwise be swallowed into — and
  // dropped with — the declaration above it).
  for (const [label, body] of [
    ['next declaration', 'export const A = 1\nexport const B = 2;\n'],
    ['next expression statement', 'export const A = 1\nglobalThis.x = 1;\nexport const B = 2;\n'],
  ]) {
    const r = assertRefused(`missing semicolon (${label})`, body, 'cjs', ['--pick', 'B']);
    assert.match(r.stderr, /automatic semicolon insertion/);
  }

  // …but a declaration that genuinely continues onto the next line is fine:
  // the line break follows an operator, so nothing reads as complete yet.
  const dir = freshDir();
  const bin = makeKitBin(dir, 'export const A = 1 +\n  2;\nexport const B =\n  A;\nexport const C = 3;\n');
  const r = runKit(bin, ['--format', 'cjs', '--pick', 'B', '--out', 'cont.cjs'], dir);
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(join(dir, 'cont.cjs'), 'utf8');
  assert.equal(syntaxCheck(join(dir, 'cont.cjs')).status, 0);
  assert.match(out, /(?:const|var) A = 1 \+/, 'the multi-line declaration it reads survives');
  assert.ok(!/(?:const|var) C\b/.test(out), 'and the unreachable one still goes');
});

test('tree-shaking: template literals and regex literals do not confuse the scanner', () => {
  // The scanner has to know that `}`/`;`/identifiers inside a CSS template or a
  // regex are not statement structure — news-kit ships ~90 lines of CSS in a
  // template literal, and every kit is full of regex literals.
  const body =
    'const CSS = `\n' +
    '.card { color: red; }\n' +
    '@media (min-width: 40em) { .card { color: blue; } }\n' +
    '`;\n' +
    'const NAME_RE = /[/{};]+/g;\n' +
    'const dropped = 1;\n' +
    'export function styles(x) {\n' +
    '  return `${CSS}${String(x).replace(NAME_RE, "")}`;\n' +
    '}\n' +
    'export function other() {\n' +
    '  return dropped;\n' +
    '}\n';
  const dir = freshDir();
  const bin = makeKitBin(dir, body);
  const r = runKit(bin, ['--format', 'cjs', '--pick', 'styles', '--out', 'css.cjs'], dir);
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(join(dir, 'css.cjs'), 'utf8');
  assert.equal(syntaxCheck(join(dir, 'css.cjs')).status, 0);
  assert.match(out, /(?:const|var) CSS = `/, 'the template a pick reaches survives whole');
  assert.match(out, /(?:const|var) NAME_RE/, 'so does the regex it uses');
  assert.ok(!/(?:const|var) dropped\b/.test(out), 'and the unreachable declaration still goes');
});

// ------------------------------------------------ esm-format tree-shaking
// The esm copies are NOT bundler input in this family: the buildless
// consumers import the vendored file DIRECTLY in the browser (Art-Gallery
// caches it as a cache-first service-worker shell asset), so nothing
// downstream would ever shake it for them. `--pick` therefore narrows esm's
// bytes as well, re-expressing the picked surface as one aggregate
// `export { … }` line — the same role module.exports plays for cjs, and the
// only form that can carry an alias.

// `node --check` treats a .mjs file as an ES module, so the generated esm
// copies below are written with that extension and really are parsed as ESM.
const importFile = (file) => import(pathToFileURL(file).href);

test('esm format: --pick shakes the body and re-exports exactly the picks', async () => {
  const dir = freshDir();
  const bin = makeKitBin(dir, SHAKE_KIT);
  const r = runKit(bin, ['--format', 'esm', '--pick', 'reachable', '--out', 'shaken.mjs'], dir);
  assert.equal(r.status, 0, r.stderr);
  const file = join(dir, 'shaken.mjs');
  const out = readFileSync(file, 'utf8');
  assert.equal(syntaxCheck(file).status, 0, 'shaken esm output must parse as a module');
  assert.match(r.stdout, /tree-shaken/);

  assert.ok(out.includes('function reachable('), 'the picked export survives');
  assert.ok(out.includes('function timesSmall('), 'a helper it calls survives');
  assert.match(out, /(?:const|var) SMALL = 2;/, 'a constant that helper reads survives');
  assert.ok(out.includes('// Kit preamble'), 'the file preamble always survives');

  for (const gone of ['unrelated', 'bigHelper', 'BIG_TABLE', 'the unrelated subsystem']) {
    assert.ok(!out.includes(gone), `unreachable declaration dropped: ${gone}`);
  }
  // Exactly one export statement, and it is the aggregate line — no stray
  // `export` keyword may survive on a declaration (that would widen the
  // surface right back past the pick list).
  assert.equal(out.match(/^export\b/gm).length, 1, 'exactly one export statement');
  assert.match(out, /^export \{\n {2}reachable,\n\};\n$/m);

  const mod = await importFile(file);
  assert.deepEqual(Object.keys(mod), ['reachable'], 'only the picks are exported');
  assert.equal(mod.reachable(21), 42, 'the shaken body still works');
});

test('esm format: a picked alias exports the LOCAL declaration under its alias', async () => {
  const dir = freshDir();
  const bin = makeKitBin(dir, SHAKE_KIT);
  const r = runKit(bin, ['--format', 'esm', '--pick', 'timesSmallAlias', '--out', 'alias.mjs'], dir);
  assert.equal(r.status, 0, r.stderr);
  const file = join(dir, 'alias.mjs');
  const out = readFileSync(file, 'utf8');
  assert.equal(syntaxCheck(file).status, 0);
  assert.ok(out.includes('function timesSmall('), 'the alias roots its local declaration');
  assert.ok(!out.includes('function reachable('), 'the export that merely calls it is not a root');
  assert.match(out, /^export \{\n {2}timesSmall as timesSmallAlias,\n\};\n$/m);
  const mod = await importFile(file);
  assert.deepEqual(Object.keys(mod), ['timesSmallAlias']);
  assert.equal(mod.timesSmallAlias(21), 42);
});

test('esm format: without --pick (and with a full pick list) the source is verbatim', () => {
  const dir = freshDir();
  const bin = makeKitBin(dir, SHAKE_KIT);
  // The guarantee consumers' `vendor:check` diffs depend on: adding esm
  // shaking must not move a single byte of an unnarrowed esm copy.
  assert.equal(runKit(bin, ['--format', 'esm', '--out', 'full.mjs'], dir).status, 0);
  const full = readFileSync(join(dir, 'full.mjs'), 'utf8');
  assert.ok(full.endsWith(SHAKE_KIT), 'no --pick: the source is copied verbatim');
  assert.ok(full.includes('// The unit tests import this verbatim ESM copy.'));

  const all = 'reachable,unrelated,timesSmallAlias';
  assert.equal(runKit(bin, ['--format', 'esm', '--pick', all, '--out', 'all.mjs'], dir).status, 0);
  assert.equal(readFileSync(join(dir, 'all.mjs'), 'utf8'), full, 'a full pick list emits the same bytes');
});

test('esm format: shaken output is deterministic and --check-able', () => {
  const dir = freshDir();
  const bin = makeKitBin(dir, SHAKE_KIT);
  const args = ['--format', 'esm', '--pick', 'reachable', '--out'];
  assert.equal(runKit(bin, [...args, 'det1.mjs'], dir).status, 0);
  assert.equal(runKit(bin, [...args, 'det2.mjs'], dir).status, 0);
  assert.equal(readFileSync(join(dir, 'det1.mjs'), 'utf8'), readFileSync(join(dir, 'det2.mjs'), 'utf8'));
  assert.equal(runKit(bin, [...args, 'det1.mjs', '--check'], dir).status, 0, 'a fresh shaken esm copy is in sync');
  writeFileSync(join(dir, 'det1.mjs'), readFileSync(join(dir, 'det1.mjs'), 'utf8') + '\n// tampered\n');
  assert.notEqual(runKit(bin, [...args, 'det1.mjs', '--check'], dir).status, 0, 'drift must fail the check');
});

test('esm format: an unreachable sanitizer-policy region is dropped, markers and all', () => {
  const dir = freshDir();
  const kitBody =
    'export function escape(s) {\n  return String(s);\n}\n' +
    '\n' +
    '// policy-managed constant, unreachable from `escape`\n' +
    'const BLOCKED = new Set([\n' +
    '  // @jfs-sanitizer-policy:blocked-tags:start case=upper quote=single\n' +
    '  // @jfs-sanitizer-policy:blocked-tags:end\n' +
    ']);\n' +
    '\n' +
    '// @jfs-sanitizer-policy:url-control-chars:start const=URL_CONTROL_CHARS\n' +
    '// @jfs-sanitizer-policy:url-control-chars:end\n' +
    '\n' +
    'export function sanitize(html) {\n' +
    '  return BLOCKED.has(html) ? "" : html.replace(URL_CONTROL_CHARS, "");\n' +
    '}\n';
  const bin = makeKitBin(dir, kitBody);
  const kitDir = join(dir, `kit-${badKitSeq - 1}`);
  const POLICY_BIN = join(KIT_DIR, '..', '..', 'bin', 'sanitizer-policy-sync.mjs');
  assert.equal(spawnSync(process.execPath, [POLICY_BIN, 'index.js'], { cwd: kitDir, encoding: 'utf8' }).status, 0);

  const r = runKit(bin, ['--format', 'esm', '--pick', 'escape', '--out', 'esc.mjs'], dir);
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(join(dir, 'esc.mjs'), 'utf8');
  assert.equal(syntaxCheck(join(dir, 'esc.mjs')).status, 0);
  assert.ok(!out.includes('function sanitize('), 'the unpicked sanitizer is dropped');
  assert.ok(!out.includes('@jfs-sanitizer-policy'), 'its markers go with it');
});

test('esm format: no shaking without sideEffects:false — but the surface still narrows', async () => {
  const dir = freshDir();
  const bin = makeKitBin(dir, SHAKE_KIT, { sideEffects: true });
  const r = runKit(bin, ['--format', 'esm', '--pick', 'reachable', '--out', 'unshaken.mjs'], dir);
  assert.equal(r.status, 0, r.stderr);
  const file = join(dir, 'unshaken.mjs');
  const out = readFileSync(file, 'utf8');
  assert.equal(syntaxCheck(file).status, 0);
  assert.match(r.stderr, /sideEffects/);
  assert.doesNotMatch(r.stdout, /tree-shaken/);
  assert.ok(out.includes('function unrelated('), 'the whole body is kept');
  // …and the generated file SAYS so — these copies are committed and read, so
  // the header must not claim a shake that did not happen.
  assert.match(out, /it was not\n\/\/ tree-shaken, because the kit does not declare "sideEffects": false/);
  // The declaration survives, but unpicked — the module exports only the pick.
  const mod = await importFile(file);
  assert.deepEqual(Object.keys(mod), ['reachable']);
  assert.equal(mod.reachable(21), 42);
});

test('esm format: a static import in a shaken kit fails closed', () => {
  // esm is the one format that tolerates a static import — but the shaker
  // cannot account for one as a top-level declaration, so a narrowed esm
  // build refuses rather than guessing at its extent.
  const body = "import { createHash } from 'node:crypto';\n" +
    'export const A = () => createHash;\n' +
    'export const B = 2;\n';
  const r = assertRefused('static import + --pick (esm)', body, 'esm', ['--pick', 'B']);
  assert.match(r.stderr, /not a declaration this generator can account for/);
  // …and the same kit still vendors verbatim at its FULL esm surface.
  const dir = freshDir();
  const bin = makeKitBin(dir, body);
  assert.equal(runKit(bin, ['--format', 'esm', '--out', 'full.mjs'], dir).status, 0);
});

// ------------------------------------------ adversarial-audit regressions
// Every case below was a LATENT defect: the CLI exited 0 and wrote a plausible
// vendored file that would have thrown at load in a consumer's browser (or, for
// the indented-export case, failed to parse at all). `vendor:check` is blind to
// all of them by construction — the committed copy and the regenerated copy
// come from the same generator, so they agree. Each test therefore asserts the
// CORRECT outcome: the declaration retained, or a clean refusal — never a
// silently wrong emission.

// The body a format wraps, i.e. everything after the provenance header.
const bodyOf = (out) => out.slice(out.indexOf('\n\n') + 2);

// Whole-word identifiers in a generated body, found WITHOUT the generator's own
// lexer — the point being that this scanner does not share whatever mistake the
// generator might make about where code ends and a literal begins.
function identifiersIn(text) {
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  return new Set(noComments.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []);
}

// Generate `body` with `args` and return the emitted text (asserting success).
function generated(body, args, kitOpts = {}) {
  const dir = freshDir();
  const bin = makeKitBin(dir, body, kitOpts);
  const out = `gen.${args.includes('esm') ? 'mjs' : 'js'}`;
  const r = runKit(bin, [...args, '--out', out], dir);
  assert.equal(r.status, 0, r.stderr);
  const file = join(dir, out);
  assert.equal(syntaxCheck(file).status, 0, 'generated output must parse');
  return readFileSync(file, 'utf8');
}

test('lexer: a keyword-spelled PROPERTY does not open a phantom regex literal', () => {
  // `o.default` is a property access, not the `default` keyword, so the `/` is
  // division. Reading it as a regex opening swallowed everything up to the next
  // `/` on the line — a trailing `//` comment or a second division — hiding the
  // reference to TOTAL/SCALE, whose declaration was then dropped as unreachable.
  for (const [label, body, kept] of [
    [
      'closed by a trailing // comment',
      'const TOTAL = 4;\n' +
        'export function f(o) { return o.default / TOTAL; // normalized ratio\n}\n' +
        'export function g() { return 1; }\n',
      'const TOTAL = 4;',
    ],
    [
      'closed by a second division on the line',
      'const SCALE = 2;\nconst LIMIT = 3;\n' +
        'export function f(opts) { return opts.default / SCALE / LIMIT; }\n' +
        'export function g() { return 1; }\n',
      'const SCALE = 2;',
    ],
    [
      'optional chaining (`o?.in`)',
      'const N = 7;\nconst M = 8;\n' +
        'export function f(o) { return o?.in / N / M; }\n' +
        'export function g() { return 1; }\n',
      'const N = 7;',
    ],
    [
      'postfix ++ is an operand, so the `/` after it is division',
      'const N = 2;\nconst M = 3;\n' +
        'export function f(i) { return i++ / N / M; }\n' +
        'export function g() { return 1; }\n',
      'const N = 2;',
    ],
  ]) {
    const body_ = generated(body, ['--format', 'esm', '--pick', 'f']);
    assert.match(body_, new RegExp(kept.replace('const ', '(?:const|var) ')), `${label}: the divisor's declaration must survive`);
    assert.ok(!body_.includes('function g('), `${label}: the unpicked export still goes`);
  }
});

test("lexer: a '/' directly after a '}' is refused as ambiguous", () => {
  // `}` closes a block (statement position — a regex may follow) exactly as
  // readily as it closes an object literal / function expression (expression
  // position — `/` is division). Both readings mis-lex the other, and both can
  // mask a reference out of the reachability scan, so the scanner refuses
  // instead of guessing. It is the only `/` context it cannot decide.
  const body =
    'const N = 2;\nconst M = 3;\n' +
    'export function f() { return {a:1} / N / M; }\nexport function g() { return 1; }\n';
  const r = assertRefused("'/' after '}'", body, 'esm', ['--pick', 'f']);
  assert.match(r.stderr, /ambiguous/);
  // The same expression parenthesized is not ambiguous and shakes normally.
  const ok = generated(
    'const N = 2;\nconst M = 3;\n' +
      'export function f() { return ({a:1}).x / N / M; }\nexport function g() { return 1; }\n',
    ['--format', 'esm', '--pick', 'f']
  );
  assert.match(ok, /(?:const|var) N = 2;/);
  assert.match(ok, /(?:const|var) M = 3;/);
});

test('fail-closed: a comment between a semicolon-less declaration and the next one still refuses', () => {
  // `startsFreshLine` walked back over spaces and tabs only, so a comment in the
  // gap hid the line break: the two declarations were run together into ONE
  // statement, `declaredNames` registered only the first name, and a pick that
  // needed the second dropped the pair out from under the reference. The
  // un-commented spelling of the same hazard always refused; this one must too.
  for (const [label, body] of [
    ['block comment', 'const A = 1\n/* note */ const B = 2;\n'],
    ['line comment', 'const A = 1\n// note\nconst B = 2;\n'],
    ['multi-line block comment', 'const A = 1\n/* note\n   continues */\nconst B = 2;\n'],
  ]) {
    const full = `${body}export function useA() { return A; }\nexport function useB() { return B; }\n`;
    const r = assertRefused(`missing semicolon before a comment (${label})`, full, 'esm', ['--pick', 'useB']);
    assert.match(r.stderr, /automatic semicolon insertion/, label);
  }
  // …and a properly terminated pair with a comment between still shakes.
  const ok = generated(
    'const A = 1;\n/* note */\nconst B = 2;\n' +
      'export function useA() { return A; }\nexport function useB() { return B; }\n',
    ['--format', 'esm', '--pick', 'useB']
  );
  assert.match(ok, /(?:const|var) B = 2;/);
  assert.ok(!/(?:const|var) A = 1;/.test(ok));
});

test('fail-closed: a destructuring pattern in a later declarator is refused', () => {
  // STMT_HEAD_RE already refuses `const { a } = x` as a head form because the
  // scanner cannot enumerate the names a pattern binds. The same pattern in a
  // SECOND declarator used to be silently under-registered: only `NAME` was
  // recorded, so `parse`/`stringify` looked like free globals and the whole
  // declaration was dropped out from under the code that used them.
  for (const [label, decl] of [
    ['object pattern', "const NAME = 'x', { parse, stringify } = JSON;"],
    ['array pattern', "const NAME = 'x', [first, second] = [1, 2];"],
    ['pattern in a third declarator', "const NAME = 'x', OTHER = 2, { parse } = JSON;"],
  ]) {
    const body =
      `${decl}\nexport function a() { return NAME; }\n` +
      'export function b() { return typeof parse + typeof first + typeof second; }\n';
    const r = assertRefused(`destructuring declarator (${label})`, body, 'esm', ['--pick', 'b']);
    assert.match(r.stderr, /destructures in a later declarator/, label);
  }
  // Plain multi-declarator lists are unaffected — both names stay registered.
  const ok = generated(
    'const A = 1, B = 2;\nexport function useB() { return B; }\nexport function other() { return 9; }\n',
    ['--format', 'esm', '--pick', 'useB']
  );
  assert.match(ok, /(?:const|var) B = 2;/, 'the declarator a pick reaches survives');
  assert.ok(!/(?:const|var) A = 1/.test(ok), 'esbuild even drops the unused half of the list');
});

test('surface derivation: an `export` inside a comment or a template literal is not an export', () => {
  // The three derivation regexes scanned raw text, so a commented-out export
  // entered the surface (`globalThis.G = { gone: gone }` — a ReferenceError the
  // moment the classic script loads) and an `export` line inside a template
  // literal both entered the surface AND had the STRING'S OWN CONTENTS rewritten
  // by the export-stripping pass.
  const commented = generated('/*\nexport const gone = 2;\n*/\nexport const A = 1;\n', [
    '--format', 'global', '--name', 'G',
  ]);
  assert.ok(!/^ {2}gone: /m.test(commented), 'a commented-out export must not enter the surface');
  assert.ok(commented.includes('export const gone = 2;'), 'and the comment is emitted verbatim');
  (0, eval)(commented);
  assert.deepEqual(Object.keys(globalThis.G), ['A'], 'the global loads and exposes only the real export');
  delete globalThis.G;

  const templated = generated(
    'export const SNIPPET = `\nexport const inner = 1;\n`;\nexport const A = 1;\n',
    ['--format', 'global', '--name', 'G']
  );
  assert.ok(!/^ {2}inner: /m.test(templated), 'a template literal cannot contribute an export');
  assert.ok(
    templated.includes('export const inner = 1;'),
    "the template literal's own contents must not be rewritten by the export strip"
  );
  (0, eval)(templated);
  assert.deepEqual(Object.keys(globalThis.G).sort(), ['A', 'SNIPPET']);
  assert.equal(globalThis.G.SNIPPET.trim(), 'export const inner = 1;');
  delete globalThis.G;
});

test('fail-closed: an INDENTED top-level export is reported, not silently emitted', () => {
  // Invisible to the surface derivation, to the export-stripping pass, and —
  // while the orphan scan was anchored hard at `^` — to the fail-closed gate
  // too. It sailed through into the emitted IIFE as
  // `SyntaxError: Unexpected token 'export'`.
  const r = assertRefused(
    'indented top-level export',
    'export const A = 1;\n  export const B = 2;\n',
    'global',
    ['--name', 'G']
  );
  assert.match(r.stderr, /cannot derive/);
  assert.match(r.stderr, /line 2: export const B = 2;/);
});

test('tree-shaking: a `${…}` interpolation does not root a top-level `$`', () => {
  // The lexer marked the `$` of `${` as code, so the identifier collector read a
  // bare `$` out of every interpolation. Any kit exporting `$` therefore kept it
  // in every narrowed build that contained a template literal anywhere in the
  // reachable set — dead bytes in seven of the family's vendored copies.
  const body = generated(
    'export const $ = (s) => document.querySelector(s);\n' +
      'export const TPL = (x) => `a${x}b`;\n',
    ['--format', 'esm', '--pick', 'TPL']
  );
  assert.match(body, /(?:const|var) TPL =/, 'the picked export survives');
  assert.ok(!body.includes('querySelector'), 'the unreferenced `$` is dropped');
  // …and a REAL reference to `$` still roots it.
  const rooted = generated(
    'export const $ = (s) => document.querySelector(s);\n' +
      'export const TPL = (x) => `a${$(x)}b`;\n',
    ['--format', 'esm', '--pick', 'TPL']
  );
  assert.ok(rooted.includes('querySelector'), 'calling `$` still roots it');
});

test('comment attribution survives CRLF line endings', () => {
  // BLANK_LINE_RE was `/\n[ \t]*\n/`, which never matches `\r\n\r\n`. With a
  // CRLF kit every gap attached to the FOLLOWING declaration, so the file-top
  // preamble rode along with the first declaration and vanished with it.
  const lf =
    '// Kit preamble.\n\n// doc for A\nexport const A = 1;\n\n// doc for B\nexport const B = 2;\n';
  const crlf = generated(lf.replace(/\n/g, '\r\n'), ['--format', 'esm', '--pick', 'B']);
  assert.ok(crlf.includes('// Kit preamble.'), 'the preamble is always kept');
  assert.ok(!/(?:const|var) A = 1;/.test(crlf), 'the dropped declaration goes');
  // Same attribution as the LF spelling of the same file.
  const plain = generated(lf, ['--format', 'esm', '--pick', 'B']);
  assert.equal(bodyOf(crlf).replace(/\r/g, ''), bodyOf(plain));
});

test('tree-shaking: the emitted body never references a declaration it dropped', () => {
  // The invariant behind the whole pass, checked here with a scanner that does
  // NOT share the generator's lexer — so a future mistake about where code ends
  // and a literal begins shows up as a failing test rather than as a
  // ReferenceError in a consumer's browser. (The generator asserts the same
  // invariant internally before writing, and refuses if it does not hold.)
  const cases = [
    [SHAKE_KIT, ['--pick', 'reachable']],
    [SHAKE_KIT, ['--pick', 'timesSmallAlias']],
    [SHAKE_KIT, ['--pick', 'unrelated']],
    [
      'const TOTAL = 4;\nexport function f(o) { return o.default / TOTAL; // ratio\n}\n' +
        'export function g() { return 1; }\n',
      ['--pick', 'f'],
    ],
    [
      'const CSS = `.c { color: red }`;\nconst DROPPED = 1;\n' +
        'export function styles() { return `${CSS}`; }\nexport function other() { return DROPPED; }\n',
      ['--pick', 'styles'],
    ],
  ];
  for (const [kit, args] of cases) {
    const out = bodyOf(generated(kit, ['--format', 'esm', ...args]));
    // Every top-level name the SOURCE declares, minus the ones still emitted.
    const declared = [...kit.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z0-9_$]+)/gm)]
      .map((m) => m[1]);
    const emitted = new Set(
      [...out.matchAll(/^(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1])
    );
    const live = identifiersIn(out.replace(/^export \{[\s\S]*$/m, ''));
    for (const name of declared) {
      if (emitted.has(name)) continue;
      assert.ok(!live.has(name), `${args.join(' ')}: dropped "${name}" is still referenced by the emitted body`);
    }
  }
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
