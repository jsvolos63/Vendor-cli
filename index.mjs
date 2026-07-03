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
//   --pick a,b,c      global format only: expose just this subset (each name
//                     must exist in the derived surface — typos are an error)
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
import { fileURLToPath } from 'node:url';

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
if (opts.pick && opts.format !== 'global') fail('--pick is only valid with --format global');

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
