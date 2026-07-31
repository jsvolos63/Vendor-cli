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
//              [--name <GlobalName>] [--pick a,b,c] \
//              [--global <Name[:a,b,c]> ...] [--check]
//
//   --format esm      verbatim ESM copy (unit tests import this)
//   --format global   classic-script IIFE exposing the public API on
//                     `globalThis.<Name>` (--name required) — for service
//                     workers via importScripts() and classic <script> pages
//   --global Name[:a,b,c]
//                     global format only; repeatable. Each occurrence adds a
//                     named global to the SAME emitted file, exposing the
//                     `:`-suffixed pick list (or the full surface without
//                     one). The kit body is emitted once and every global's
//                     surface map closes over it — the fix for consumers
//                     that shipped the whole bundle twice just to get two
//                     narrowed globals. Mutually exclusive with
//                     --name/--pick (the legacy single-global spelling;
//                     `--global X:a,b` ≡ `--name X --pick a,b`).
//   --format bare     `export`-stripped copy whose declarations become
//                     bundle-scoped when concatenated into a classic-script
//                     bundle (aggregate `export { a as b }` alias lines are
//                     dropped — aliases can't be expressed as declarations)
//   --format cjs      CommonJS transform (module.exports of the public API)
//                     for `require()` from CommonJS Netlify Functions
//   --pick a,b,c      global and cjs formats: expose just this subset (each
//                     name must exist in the derived surface — typos are an
//                     error). Narrows the exposed API (the global object /
//                     module.exports map) AND the shipped bytes: the body is
//                     tree-shaken down to the declarations the picks actually
//                     reach (see "tree-shaking" below). Use it to keep a
//                     consumer's coupling surface — and its payload —
//                     explicit.
//   --check           don't write; exit 1 if <dest> differs from what would
//                     be generated (consumers run this in CI as vendor:check)
//
// The exposed surface for global/cjs is DERIVED from the source's own
// top-level `export` declarations — never a hand-maintained list. A stale
// list would either omit a newly-added export (breaking the consumer at
// runtime) or reference a removed one (a ReferenceError that fails service
// worker install), and a drift check can't catch either because the committed
// copy and the regenerated one would share the same stale list.
//
// That derivation is regex-level, so it is deliberately FAIL-CLOSED: every
// `export` in the source must be one the derivation consumed, and static
// `import` / `import.meta` must be absent from the formats that can't express
// them. An export form the generator doesn't understand aborts generation
// (non-zero exit, nothing written) rather than producing a plausible artifact
// with a silently missing export.
//
// TREE-SHAKING (see the treeShakeKitSource section further down): a NARROWED
// surface also narrows the emitted body. Without it, merging two kits would
// tax every consumer that wants one helper from one of them with the whole
// other kit's bytes. The shaker is source-preserving — it drops whole
// top-level declarations and emits the surviving ones VERBATIM, so comments
// (including the `@jfs-sanitizer-policy` marker regions the family's policy
// gate checks in the vendored copies), formatting and readability survive, and
// the output is byte-deterministic. A full surface still emits the source
// unshaken, byte-for-byte as before.

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// The generation is staged as named, parameter-passing functions —
// parseVendorArgs → deriveKitSurface → resolveKitExposure →
// emitVendoredOutput → writeOrCheckOutput — with runVendorCli (at the end of
// this section) as a thin orchestrator. Every stage THROWS VendorCliError
// instead of exiting; runVendorCli catches it and routes the message through
// its fail(), so the CLI's stderr text and exit codes are unchanged.

class VendorCliError extends Error {}

function vendorFail(msg) {
  throw new VendorCliError(msg);
}

// ---------------------------------------------------------------- arguments

const FORMATS = ['esm', 'global', 'bare', 'cjs'];
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Parse + validate the CLI argv into { opts, globalSpecs }. Validation
// failures throw VendorCliError (they never exit), so the flag handling is
// testable in isolation.
export function parseVendorArgs(argv) {
  const args = argv;
  const opts = { check: false, pick: null, name: null, format: null, out: null, globals: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => {
      if (i + 1 >= args.length) vendorFail(`${a} requires a value`);
      return args[++i];
    };
    if (a === '--check') opts.check = true;
    else if (a === '--format') opts.format = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--name') opts.name = next();
    else if (a === '--pick') opts.pick = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--global') opts.globals.push(next());
    else vendorFail(`unknown argument: ${a}`);
  }

  if (!FORMATS.includes(opts.format)) vendorFail(`--format must be one of: ${FORMATS.join(', ')}`);
  if (!opts.out) vendorFail('--out <dest> is required');
  if (opts.globals.length && opts.format !== 'global') vendorFail('--global is only valid with --format global');
  if (opts.globals.length && (opts.name || opts.pick)) {
    vendorFail('--global cannot be combined with --name/--pick — use one --global <Name[:a,b,c]> per exposed global');
  }
  if (opts.format === 'global' && !opts.name && !opts.globals.length) {
    vendorFail('--format global requires --name <GlobalName> (or one --global <Name[:a,b,c]> per global)');
  }
  if (opts.name && !IDENT_RE.test(opts.name)) vendorFail(`--name must be a valid identifier, got: ${opts.name}`);
  if (opts.pick && opts.format !== 'global' && opts.format !== 'cjs') {
    vendorFail('--pick is only valid with --format global or cjs');
  }

  // Parse `--global Name[:a,b,c]` specs: name before the first `:`, an optional
  // pick list after it (no `:` = full surface, same as --name without --pick).
  const globalSpecs = opts.globals.map((spec) => {
    const idx = spec.indexOf(':');
    const name = idx === -1 ? spec : spec.slice(0, idx);
    if (!IDENT_RE.test(name)) vendorFail(`--global name must be a valid identifier, got: ${name || spec}`);
    const pick = idx === -1 ? null : spec.slice(idx + 1).split(',').map((s) => s.trim()).filter(Boolean);
    if (pick && pick.length === 0) vendorFail(`--global ${name}: empty pick list after ':'`);
    return { name, pick };
  });
  {
    const seen = new Set();
    for (const { name } of globalSpecs) {
      if (seen.has(name)) vendorFail(`--global ${name} given more than once`);
      seen.add(name);
    }
  }

  return { opts, globalSpecs };
}

// ------------------------------------------------------- derive the surface

// Ordered { exported, local } pairs from the source's own `export`
// declarations plus aggregate `export { a as b, c }` alias lines. The kits
// deliberately use only these forms (no default export, no re-export-from),
// which keeps this derivation exact.
//
// It also returns `accounted`: the source offset of every `export` keyword the
// derivation actually consumed. The gate below asserts that set covers EVERY
// top-level `export` in the file, so the CLI fails closed BY CONSTRUCTION — an
// export form this function doesn't understand (today's `export var` /
// `export function*` / `export const { a, b } = …`, or tomorrow's new syntax)
// stops the build instead of silently vanishing from the generated surface.
function deriveSurface(esm) {
  const surface = [];
  const accounted = new Set();
  const declRe = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/gm;
  let m;
  while ((m = declRe.exec(esm)) !== null) {
    surface.push({ exported: m[1], local: m[1] });
    accounted.add(m.index);
  }
  const aggRe = /^export\s*\{([^}]*)\}\s*;?\s*$/gm;
  while ((m = aggRe.exec(esm)) !== null) {
    accounted.add(m.index);
    for (const part of m[1].split(',')) {
      const spec = part.trim();
      if (!spec) continue;
      const alias = spec.match(/^([A-Za-z0-9_$]+)(?:\s+as\s+([A-Za-z0-9_$]+))?$/);
      if (!alias) vendorFail(`unparseable export specifier in aggregate export: "${spec}"`);
      surface.push({ exported: alias[2] || alias[1], local: alias[1] });
    }
  }
  return { surface, accounted };
}

// 1-based line number + trimmed line text for a source offset, so every
// refusal below can point at the offending line.
function lineInfo(source, index) {
  const line = source.slice(0, index).split('\n').length;
  const start = source.lastIndexOf('\n', index - 1) + 1;
  const end = source.indexOf('\n', index);
  return { line, text: source.slice(start, end === -1 ? source.length : end).trim() };
}

const SUPPORTED_FORMS =
  'the supported forms are `export [async] function|const|let|class NAME …` and ' +
  'aggregate `export { a as b, c }` lines. Anything else can be exported by ' +
  'declaring it normally and adding it to an aggregate line ' +
  '(e.g. `function* gen() {}` … `export { gen };`).';

// Derive the kit's exported surface and enforce every fail-closed gate:
// unsupported export forms, exports the derivation didn't consume, static
// imports / import.meta in formats that can't express them, and an empty
// surface. Returns the ordered surface array; every refusal throws.
function deriveKitSurface(source, opts, kitDir) {
  // The derivation (and the export-stripping in strippedBody) is only sound for
  // the forms the kits deliberately restrict themselves to. A default export or
  // a re-export-from would previously slip through both regexes and emit BROKEN
  // output — `export default x` strips to the syntax error `default x` (failing
  // service-worker install at the consumer), and `export { a } from './m'` /
  // `export * from './m'` silently vanish from the derived surface. Fail loudly
  // at generation time instead. (The catch-all gate below would also stop these;
  // this one is kept because it names the form.)
  {
    const unsupported = source.match(
      /^export\s+default\b|^export\s*\{[^}]*\}\s*from\b|^export\s*\*/m
    );
    if (unsupported) {
      vendorFail(
        `unsupported export form "${unsupported[0].trim()}…" in ${kitDir}/index.js — ` +
          'the kits use only top-level export declarations and aggregate `export { a as b }` ' +
          'lines (no default export, no re-export-from, no export *); the generated ' +
          'global/bare/cjs output would be broken or silently incomplete.'
      );
    }
  }

  const { surface, accounted } = deriveSurface(source);

  // ------------------------------------------------------------- fail closed
  // Enumerating bad forms can only ever cover the ones we thought of, and the
  // failure mode of a missed one is the worst kind: a plausible artifact, exit
  // code 0, and a reassuring log line — with `vendor:check` blind to it, because
  // the committed copy and the regenerated copy share the omission. So instead
  // of listing what's rejected, assert that the derivation ACCOUNTED FOR every
  // `export` in the source, and refuse otherwise.
  {
    const orphans = [];
    const exportRe = /^export\b/gm;
    let m;
    while ((m = exportRe.exec(source)) !== null) {
      if (!accounted.has(m.index)) orphans.push(lineInfo(source, m.index));
    }
    if (orphans.length) {
      vendorFail(
        `${orphans.length} export(s) in ${kitDir}/index.js that this generator cannot derive:\n` +
          orphans.map((o) => `  line ${o.line}: ${o.text}`).join('\n') +
          `\n${SUPPORTED_FORMS}\n` +
          'Generating anyway would drop these from the global/cjs surface (or emit ' +
          'broken classic-script syntax) with a passing exit code, so nothing was written.'
      );
    }
  }

  // Static `import` / `import.meta` are ES-module-only syntax. The bare, global
  // and cjs builds are a classic script / a CommonJS module, so either one is a
  // hard syntax error there (a service worker importScripts()-ing such a file
  // fails install) — and a RELATIVE import means a multi-file kit, which no
  // single-file vendored copy can represent in ANY format. Both used to be
  // copied through verbatim with exit code 0.
  {
    const statics = [];
    // Matches `import …` / `import{…}` / `import '…'`, but not the dynamic
    // `import(…)` (legal in classic scripts and CJS) nor `import.meta`.
    const importRe = /^[ \t]*import\b(?![ \t]*[(.])/gm;
    let m;
    while ((m = importRe.exec(source)) !== null) {
      const stmt = source.slice(m.index, m.index + 400).split(';')[0];
      const spec = stmt.match(/from\s*['"]([^'"]+)['"]/) || stmt.match(/^[ \t]*import\s*['"]([^'"]+)['"]/);
      statics.push({ ...lineInfo(source, m.index), spec: spec ? spec[1] : null });
    }

    const relative = statics.find((s) => s.spec && /^[.\/]/.test(s.spec));
    if (relative) {
      vendorFail(
        `relative import "${relative.spec}" at ${kitDir}/index.js:${relative.line} — a kit is ` +
          'vendored as ONE file, so the imported module would be missing wherever the ' +
          'generated copy lands. Inline the dependency into index.js.'
      );
    }

    if (opts.format !== 'esm') {
      if (statics.length) {
        const s = statics[0];
        vendorFail(
          `static import at ${kitDir}/index.js:${s.line} (\`${s.text}\`) cannot be emitted in ` +
            `--format ${opts.format}: that build is a classic script / CommonJS module, where a ` +
            'static import is a syntax error (it would fail service-worker install or require() ' +
            'at the consumer). Inline the dependency, or vendor this kit as --format esm only.'
        );
      }
      const meta = source.search(/\bimport\s*\.\s*meta\b/);
      if (meta !== -1) {
        const s = lineInfo(source, meta);
        vendorFail(
          `\`import.meta\` at ${kitDir}/index.js:${s.line} (\`${s.text}\`) cannot be emitted in ` +
            `--format ${opts.format}: it is only valid inside an ES module, so the generated ` +
            'classic-script/CommonJS file would be a syntax error.'
        );
      }
    }
  }

  if (surface.length === 0) {
    vendorFail(`found no top-level exports in ${kitDir}/index.js — refusing to generate an empty surface.`);
  }

  return surface;
}

// --pick / --global pick lists must name real exports — a typo is an error,
// never a silently narrower surface.
function resolveExposed(surface, pick, flag, pkgName) {
  if (!pick) return surface;
  const known = new Set(surface.map((s) => s.exported));
  const unknown = pick.filter((n) => !known.has(n));
  if (unknown.length) {
    vendorFail(`${flag} names not exported by ${pkgName}: ${unknown.join(', ')} (available: ${[...known].join(', ')})`);
  }
  return surface.filter((s) => pick.includes(s.exported));
}

// Resolve what the emitted file exposes: the (possibly --pick-narrowed)
// surface, the per-global surfaces for the global format, and the exposed
// count the log lines report. Returns { exposed, globals, exposedCount }.
function resolveKitExposure(surface, opts, globalSpecs, pkgName) {
  const exposed = resolveExposed(surface, opts.pick, '--pick', pkgName);

  // For the global format: the ordered list of { name, exposed } globals the
  // emitted file assigns. The legacy `--name X [--pick a,b]` spelling is exactly
  // one entry, so `--global X:a,b` and `--name X --pick a,b` emit identical
  // bytes; each additional --global adds another surface map over the SAME
  // (single) kit body.
  const globals =
    opts.format === 'global'
      ? opts.name
        ? [{ name: opts.name, exposed }]
        : globalSpecs.map((g) => ({ name: g.name, exposed: resolveExposed(surface, g.pick, `--global ${g.name}`, pkgName) }))
      : null;

  // What the file as a whole exposes — for the log lines. With several globals
  // that's the union of their pick lists.
  const exposedCount = globals
    ? new Set(globals.flatMap((g) => g.exposed.map((s) => s.exported))).size
    : exposed.length;

  return { exposed, globals, exposedCount };
}

// ------------------------------------------------------------ tree-shaking
//
// `--pick` / `--global Name:picks` used to narrow only the exposed API — the
// body was shipped whole. That was tolerable while each kit was small and
// single-purpose; it stops being tolerable the moment kits merge, because then
// a consumer that wants one escaper pays for a whole news-river renderer.
//
// So a narrowed surface now narrows the BYTES too. The kits are single-file,
// import-free ES modules whose top level is nothing but declarations (the
// derivation gates above already refuse anything else), which makes reachability
// the whole of the analysis: root at the picked exports' local bindings, keep
// every top-level declaration they transitively name, drop the rest.
//
// Three properties are load-bearing, and each is a design constraint here:
//
//   READABLE   — vendored copies are committed and code-reviewed. The shaker
//                never reprints code: surviving declarations are emitted as
//                exact source slices, with their attached comments. (This is
//                also why esbuild is not used: it would reprint every kit,
//                erase every comment, and make each vendored copy a diff
//                against nothing recognizable.)
//   MARKERS    — the `@jfs-sanitizer-policy:<region>:start/:end` comments must
//                reach the vendored copy: six consumers run
//                `jfs-sanitizer-policy-sync --check` against the GENERATED
//                file. Comments ride along with their declaration, and any
//                declaration carrying a policy region is a shaking ROOT, so a
//                pick that doesn't reach the sanitizer still can't disarm the
//                family's drift gate.
//   DETERMINISM— `vendor:check` diffs a regeneration against the committed
//                copy, so the same (source, picks) must give the same bytes.
//                The output is a pure function of those two: original order,
//                original text, fixed joining.
//
// FAIL-CLOSED, like everything else here: the scanner below refuses to shake
// anything it cannot account for byte-for-byte (see the head-form check and
// the tiling assertion, both in sliceTopLevel), and the whole
// pass is skipped — emitting today's whole body — for a kit that doesn't
// declare `"sideEffects": false`, i.e. one whose author has NOT asserted that
// dropping an unreferenced top-level declaration is safe.

// Per-character classification produced by lexKitSource.
const M_CODE = 0;
const M_COMMENT = 1;
const M_LITERAL = 2;

// A `/` opens a regex literal only where the previous significant token cannot
// end an expression. Word tokens are the ambiguous case, so keep the exact set
// of keywords after which a regex is legal.
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do',
  'else', 'yield', 'await', 'throw', 'case', 'default',
]);

// One pass over the kit source producing, per character, what it IS (code /
// comment / string-or-regex-or-template text) and the bracket depth it sits at.
// Everything downstream — statement segmentation, identifier collection — reads
// these two arrays instead of re-guessing lexical context, which is what makes
// it safe to look for a `;` or an identifier without tripping over the CSS
// living inside news-kit's template literals.
function lexKitSource(src, fail) {
  const n = src.length;
  const mask = new Uint8Array(n);
  const depth = new Int32Array(n);
  const stack = []; // template-literal / `${}`-interpolation frames
  let d = 0;
  let i = 0;
  let prev = null; // last significant code token: { endsExpr }
  const span = (from, to, m) => {
    for (let k = from; k < to; k++) {
      mask[k] = m;
      depth[k] = d;
    }
  };
  const top = () => (stack.length ? stack[stack.length - 1] : null);
  const at = (idx) => `offset ${idx} (line ${src.slice(0, idx).split('\n').length})`;

  while (i < n) {
    if (top() && top().kind === 'template') {
      const start = i;
      while (i < n) {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '`' || (c === '$' && src[i + 1] === '{')) break;
        i++;
      }
      span(start, Math.min(i, n), M_LITERAL);
      if (i >= n) fail(`unterminated template literal at ${at(start)}`);
      if (src[i] === '`') {
        span(i, i + 1, M_LITERAL);
        i++;
        stack.pop();
        prev = { endsExpr: true };
        continue;
      }
      span(i, i + 2, M_CODE); // `${` — code resumes inside the interpolation
      stack.push({ kind: 'interp', depth: d });
      d++;
      i += 2;
      prev = null;
      continue;
    }

    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i);
      if (j === -1) j = n;
      span(i, j, M_COMMENT);
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      if (j === -1) fail(`unterminated block comment at ${at(i)}`);
      span(i, j + 2, M_COMMENT);
      i = j + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '\n') fail(`unterminated string literal at ${at(i)}`);
        j++;
      }
      if (j >= n) fail(`unterminated string literal at ${at(i)}`);
      span(i, j + 1, M_LITERAL);
      i = j + 1;
      prev = { endsExpr: true };
      continue;
    }
    if (c === '`') {
      span(i, i + 1, M_LITERAL);
      i++;
      stack.push({ kind: 'template' });
      continue;
    }
    if (c === '/' && (!prev || !prev.endsExpr)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '\n') fail(`unterminated regex literal at ${at(i)}`);
        if (inClass) { if (ch === ']') inClass = false; }
        else if (ch === '[') inClass = true;
        else if (ch === '/') break;
        j++;
      }
      if (j >= n) fail(`unterminated regex literal at ${at(i)}`);
      j++;
      while (j < n && /[a-z]/.test(src[j])) j++; // flags
      span(i, j, M_LITERAL);
      i = j;
      prev = { endsExpr: true };
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      mask[i] = M_CODE;
      depth[i] = d;
      d++;
      i++;
      prev = { endsExpr: false };
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      // The `}` that closes a `${…}` hands control back to the template text.
      if (c === '}' && top() && top().kind === 'interp' && d === top().depth + 1) {
        d--;
        mask[i] = M_CODE;
        depth[i] = d;
        i++;
        stack.pop();
        prev = null;
        continue;
      }
      d--;
      if (d < 0) fail(`unbalanced '${c}' at ${at(i)}`);
      mask[i] = M_CODE;
      depth[i] = d;
      i++;
      // `}` can close a block (statement position — a regex may follow); `)`
      // and `]` always end an expression.
      prev = { endsExpr: c !== '}' };
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      span(i, j, M_CODE);
      prev = { endsExpr: !REGEX_AFTER_WORD.has(src.slice(i, j)) };
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9a-zA-Z_.]/.test(src[j])) j++; // 0x1f, 1e9, 4_000_000, 8.64e15
      span(i, j, M_CODE);
      i = j;
      prev = { endsExpr: true };
      continue;
    }
    mask[i] = M_CODE;
    depth[i] = d;
    if (!/\s/.test(c)) prev = { endsExpr: false };
    i++;
  }

  if (d !== 0 || stack.length) {
    fail('brackets/quotes do not balance across the file — the scanner lost track of lexical context, so nothing was shaken.');
  }
  return { mask, depth };
}

// The top-level statement forms the shaker understands. Anything else at depth
// 0 aborts the shake (it could be a side-effecting statement, and dropping —
// or misjudging the extent of — one is exactly the unsound move).
const STMT_HEAD_RE =
  /^(?:export[\s]+)?(?:async[\s]+)?(function[\s]*\*?|class|const|let|var)[\s]+([A-Za-z0-9_$]+)/;
const EXPORT_BRACE_HEAD_RE = /^export[\s]*\{/;
const POLICY_MARKER_TEXT = '@jfs-sanitizer-policy:';

// True when only whitespace separates `idx` from the start of its line.
function startsFreshLine(src, idx) {
  let k = idx - 1;
  while (k >= 0 && (src[k] === ' ' || src[k] === '\t')) k--;
  return k < 0 || src[k] === '\n';
}

// True when the last significant thing before `idx` closes an operand (a value,
// a `)`/`]`/`}`) rather than leaving an expression open (an operator, a comma,
// an opening bracket) — i.e. when the statement so far already reads complete.
const OPERATOR_CHARS = /[-+*/%=<>!&|^~?:,.([{]/;
function endsOperand(src, mask, idx, floor) {
  let k = idx - 1;
  while (k >= floor && (mask[k] === M_COMMENT || /\s/.test(src[k]))) k--;
  if (k < floor) return false;
  if (mask[k] !== M_CODE) return true; // a string / template / regex literal
  return !OPERATOR_CHARS.test(src[k]);
}

// Split the source into ordered top-level statements. Returns the statement
// spans only; the text BETWEEN them (comments, blank lines) is attributed by
// buildShakeChunks below.
function sliceTopLevel(src, mask, depth, fail) {
  const n = src.length;
  const stmts = [];
  const isTopCode = (k) => mask[k] === M_CODE && depth[k] === 0;
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;
  let i = 0;

  while (i < n) {
    // Skip the gap: whitespace and comments carry no statement of their own.
    while (i < n && (mask[i] === M_COMMENT || /\s/.test(src[i]))) i++;
    if (i >= n) break;

    const start = i;
    const head = src.slice(start, start + 200);
    const decl = STMT_HEAD_RE.exec(head);
    const isExportBrace = !decl && EXPORT_BRACE_HEAD_RE.test(head);
    if (!decl && !isExportBrace) {
      fail(
        `top-level statement at line ${lineOf(start)} (\`${head.split('\n')[0].slice(0, 60)}\`) is not a ` +
          'declaration this generator can account for. Tree-shaking a narrowed --pick/--global surface ' +
          'requires every top-level statement to be a declaration (it may otherwise have side effects ' +
          'that dropping — or mis-measuring — would lose), so nothing was written.'
      );
    }
    const kind = isExportBrace ? 'exportBrace' : decl[1].startsWith('function') ? 'function' : decl[1];
    const blockForm = kind === 'function' || kind === 'class' || kind === 'exportBrace';

    // Find the end: the depth-0 `}` that closes a function/class/export body,
    // or the depth-0 `;` that terminates a variable declaration.
    let j = start;
    let end = -1;
    for (; j < n; j++) {
      if (!isTopCode(j)) continue;
      const c = src[j];
      if (c === ';') { end = j + 1; break; }
      if (blockForm && c === '}') {
        let k = j + 1;
        while (k < n && /[ \t]/.test(src[k])) k++;
        end = isTopCode(k) && src[k] === ';' ? k + 1 : j + 1;
        break;
      }
      // A `const` with no terminating `;` would swallow whatever follows it,
      // and the ASI rules that make that legal are exactly what a scanner this
      // size must not pretend to implement. The tell: a fresh line starting a
      // new identifier while the declaration already reads as complete (the
      // last thing before it ends an operand, rather than being an operator
      // that a continuation line would follow).
      if (!blockForm && j > start && startsFreshLine(src, j) && /[A-Za-z_$]/.test(src[j]) && endsOperand(src, mask, j, start)) {
        fail(
          `the declaration at line ${lineOf(start)} has no terminating \`;\` before what looks like a new ` +
            `statement at line ${lineOf(j)} — the shaker will not guess at automatic semicolon insertion.`
        );
      }
    }
    if (end === -1) {
      fail(`could not find the end of the top-level statement starting at line ${lineOf(start)}.`);
    }

    stmts.push({ start, end, kind });
    i = end;
  }

  if (!stmts.length) fail('found no top-level declarations to shake.');
  // Tiling assertion: statements are disjoint, in order, and everything not
  // covered by one is whitespace or comment. A scanner that lost its place
  // would break this before it could drop the wrong bytes.
  let cursor = 0;
  for (const s of stmts) {
    if (s.start < cursor || s.end <= s.start) fail('statement spans overlap — refusing to shake.');
    for (let k = cursor; k < s.start; k++) {
      if (mask[k] !== M_COMMENT && !/\s/.test(src[k])) {
        fail(`unaccounted top-level text at line ${lineOf(k)} — refusing to shake.`);
      }
    }
    cursor = s.end;
  }
  return stmts;
}

// Every identifier a statement READS, over-approximated on purpose: a false
// positive only keeps a declaration that could have been dropped, while a false
// negative would drop one that is still needed. Property names (`x.foo`) are
// excluded because they are never a top-level binding reference; comments and
// string/regex text are excluded via the lexer mask.
function collectIdentifiers(src, mask, from, to) {
  const names = new Set();
  for (let i = from; i < to; i++) {
    if (mask[i] !== M_CODE || !/[A-Za-z_$]/.test(src[i])) continue;
    if (i > from && mask[i - 1] === M_CODE && /[A-Za-z0-9_$]/.test(src[i - 1])) continue;
    let j = i + 1;
    while (j < to && /[A-Za-z0-9_$]/.test(src[j])) j++;
    let k = i - 1;
    while (k >= from && mask[k] === M_CODE && /\s/.test(src[k])) k--;
    // `x.foo` / `x?.foo` is a property name, never a binding — but `...foo`
    // ends in a dot too and IS a reference (spreading a top-level binding).
    const isMember =
      k >= from && mask[k] === M_CODE && src[k] === '.' && !(k - 1 >= 0 && src[k - 1] === '.');
    if (!isMember) names.add(src.slice(i, j));
    i = j - 1;
  }
  return names;
}

// The names a declaration BINDS. Multi-declarator `const a = 1, b = 2;` binds
// both, so take the head name plus any identifier that follows a depth-0 comma
// inside the statement — otherwise `b` would look like a free global and its
// declaration could be dropped out from under a reference to it.
function declaredNames(src, mask, depth, stmt) {
  if (stmt.kind === 'exportBrace') return [];
  const names = [];
  const head = STMT_HEAD_RE.exec(src.slice(stmt.start, stmt.start + 200));
  if (head) names.push(head[2]);
  if (stmt.kind === 'const' || stmt.kind === 'let' || stmt.kind === 'var') {
    for (let i = stmt.start; i < stmt.end; i++) {
      if (mask[i] !== M_CODE || depth[i] !== 0 || src[i] !== ',') continue;
      let j = i + 1;
      while (j < stmt.end && /\s/.test(src[j])) j++;
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(j, stmt.end));
      if (m) names.push(m[0]);
    }
  }
  return names;
}

// Comment attribution. A gap between two declarations splits at its FIRST
// blank line: comments sitting directly under a declaration are ITS trailing
// comments (this is what carries a `@jfs-sanitizer-policy:…:end` marker along
// with the constant it closes), everything after the blank line documents the
// declaration that follows. The gap at the top of the file splits at its LAST
// blank line instead — everything above that is the kit's preamble, which
// documents the file rather than any one declaration and is always kept.
const BLANK_LINE_RE = /\n[ \t]*\n/;

function splitAtFirstBlank(gap) {
  const m = BLANK_LINE_RE.exec(gap);
  return m ? [gap.slice(0, m.index), gap.slice(m.index)] : ['', gap];
}

function splitAtLastBlank(gap) {
  const re = new RegExp(BLANK_LINE_RE.source, 'g');
  let idx = -1;
  let m;
  while ((m = re.exec(gap)) !== null) {
    idx = m.index;
    re.lastIndex = m.index + 1;
  }
  return idx === -1 ? ['', gap] : [gap.slice(0, idx), gap.slice(idx)];
}

// Turn the statement spans into shakeable chunks: each carries the text that
// will be emitted (its attached comments plus the statement itself), what it
// declares, what it references, and whether it holds a sanitizer-policy marker.
function buildShakeChunks(src, mask, depth, stmts, fail) {
  const heads = [];
  const tails = [];
  let preamble = '';
  for (let n = 0; n <= stmts.length; n++) {
    const from = n === 0 ? 0 : stmts[n - 1].end;
    const to = n === stmts.length ? src.length : stmts[n].start;
    const gap = src.slice(from, to);
    const [before, after] = n === 0 ? splitAtLastBlank(gap) : splitAtFirstBlank(gap);
    if (n === 0) preamble = before.trim();
    else tails[n - 1] = before;
    if (n < stmts.length) heads[n] = after;
    else if (after.trim()) {
      // Prose after the LAST declaration has no following statement to
      // document, so it rides with the one above it rather than being dropped.
      tails[stmts.length - 1] = `${tails[stmts.length - 1] || ''}${after}`;
    }
  }

  const chunks = stmts.map((stmt, n) => {
    const text = `${heads[n] || ''}${src.slice(stmt.start, stmt.end)}${tails[n] || ''}`;
    return {
      text: text.trim(),
      kind: stmt.kind,
      declares: declaredNames(src, mask, depth, stmt),
      refs: collectIdentifiers(src, mask, stmt.start, stmt.end),
      hasPolicyRegion: text.includes(POLICY_MARKER_TEXT),
    };
  });
  if (!chunks.length) fail('nothing to emit after chunking — refusing to shake.');
  return { preamble, chunks };
}

// Drop every top-level declaration the picked surface cannot reach.
// `rootLocals` are the LOCAL binding names behind the exposed exports (an
// aggregate alias exposes `helperAlias` but roots `internalHelper`).
// `exportOffsets` is the set of `export` keyword offsets the surface derivation
// consumed — used as an independent cross-check that this scanner agrees with
// it about where top-level statements begin.
export function treeShakeKitSource(source, rootLocals, { fail = vendorFail, exportOffsets = null } = {}) {
  const { mask, depth } = lexKitSource(source, fail);
  const stmts = sliceTopLevel(source, mask, depth, fail);

  if (exportOffsets) {
    const starts = new Set(stmts.map((s) => s.start));
    for (const off of exportOffsets) {
      if (!starts.has(off)) {
        fail(
          `internal disagreement: the surface derivation found an export at offset ${off} that the ` +
            'tree-shaker does not see as a top-level statement start. Refusing to shake.'
        );
      }
    }
  }

  const { preamble, chunks } = buildShakeChunks(source, mask, depth, stmts, fail);

  const declaredBy = new Map();
  chunks.forEach((chunk, idx) => {
    for (const name of chunk.declares) {
      if (declaredBy.has(name)) {
        fail(`top-level name "${name}" is declared twice — refusing to shake.`);
      }
      declaredBy.set(name, idx);
    }
  });

  for (const name of rootLocals) {
    if (!declaredBy.has(name)) {
      fail(`picked export "${name}" has no top-level declaration the tree-shaker can find — refusing to shake.`);
    }
  }

  // Roots: the picked exports' locals, plus every declaration carrying a
  // sanitizer-policy marker — six consumers run the policy check against their
  // GENERATED copy, so a pick that doesn't reach the sanitizer must not be able
  // to strip the markers (and with them, silently, the family's drift gate).
  const keep = new Set();
  const queue = [];
  const root = (idx) => {
    if (idx === undefined || keep.has(idx)) return;
    keep.add(idx);
    queue.push(idx);
  };
  for (const name of rootLocals) root(declaredBy.get(name));
  chunks.forEach((chunk, idx) => {
    if (chunk.hasPolicyRegion) root(idx);
  });

  while (queue.length) {
    const chunk = chunks[queue.shift()];
    for (const ref of chunk.refs) root(declaredBy.get(ref));
  }

  // Aggregate `export { a as b }` lines are re-expressed as the surface map in
  // every format this runs for, and stripped from the body — never emit them.
  const body = chunks
    .filter((chunk, idx) => keep.has(idx) && chunk.kind !== 'exportBrace')
    .map((chunk) => chunk.text);

  const out = `${(preamble ? [preamble, ...body] : body).join('\n\n')}\n`;

  // Belt and braces on the marker guarantee above: every policy marker in the
  // source must be in the output. If comment attribution ever changes shape,
  // this fails the generation rather than quietly disarming the policy gate.
  const markers = (text) => text.split(POLICY_MARKER_TEXT).length - 1;
  if (markers(out) !== markers(source)) {
    fail(
      `tree-shaking would emit ${markers(out)} of the source's ${markers(source)} ` +
        `\`${POLICY_MARKER_TEXT}\` markers — the vendored copy must keep them all so ` +
        '`jfs-sanitizer-policy-sync --check` still gates it. Refusing to shake.'
    );
  }
  return out;
}

// Decide whether this generation shakes, and do it. Returns the body the
// formats below emit. Unshaken (verbatim source) whenever:
//   * the format keeps the source as-is (esm) or has no narrowed surface,
//   * the picks cover the whole surface — today's bytes, unchanged, so
//     existing full-surface vendored copies don't move, or
//   * the kit has not declared `"sideEffects": false`, i.e. its author has not
//     asserted that dropping an unreferenced top-level declaration is safe.
function narrowKitBody(source, format, { exposed, globals }, surface, pkg) {
  if (format !== 'global' && format !== 'cjs') return { body: source, shaken: false };

  const rootLocals = new Set(
    (globals ? globals.flatMap((g) => g.exposed) : exposed).map((s) => s.local)
  );
  const allLocals = new Set(surface.map((s) => s.local));
  if ([...allLocals].every((name) => rootLocals.has(name))) return { body: source, shaken: false };

  if (pkg.sideEffects !== false) {
    return {
      body: source,
      shaken: false,
      note:
        `${pkg.name} does not declare "sideEffects": false, so the narrowed surface was NOT tree-shaken ` +
        '(dropping an unreferenced top-level declaration could drop a module-level side effect).',
    };
  }

  const { accounted } = deriveSurface(source);
  return { body: treeShakeKitSource(source, rootLocals, { exportOffsets: accounted }), shaken: true };
}

// -------------------------------------------------------------- generation

function vendorHeader(pkg, repo, extra) {
  // The provenance values land inside a // comment in a file consumers commit
  // and ship; a stray newline in a malformed package.json field would break
  // out of the comment into code. Collapse any line break defensively.
  const oneLine = (v) => String(v).replace(/[\r\n]+/g, ' ');
  return (
    `// VENDORED from ${oneLine(pkg.name)} v${oneLine(pkg.version)} (github:${oneLine(repo)}), pinned in package.json.\n` +
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

// Emit the generated file for one format. Pure string-in/string-out: the
// four formats stay a switch, but behind a seam that takes everything it
// needs as parameters.
function emitVendoredOutput(format, source, { exposed, globals }, pkg, repo) {
  const header = (extra) => vendorHeader(pkg, repo, extra);
  const mapOf = (list) => list.map((s) => `  ${s.exported}: ${s.local},`).join('\n');
  const surfaceMap = mapOf(exposed);
  switch (format) {
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
    case 'global': {
      // One shared body, then one surface-map assignment per global. With the
      // single legacy --name spelling this emits exactly the pre---global
      // bytes, so committed vendored copies stay in sync.
      const globalList = globals.map((g) => `globalThis.${g.name}`).join(', ');
      const maps = globals
        .map((g) => `globalThis.${g.name} = {\n${mapOf(g.exposed)}\n};`)
        .join('\n');
      return (
        header(
          '// Classic-script IIFE build for importScripts()/<script> consumers;\n' +
          `// exposes the public API on ${globalList}.`
        ) +
        '(function () {\n' +
        '"use strict";\n' +
        strippedBody(source) +
        `\n${maps}\n` +
        '}());\n'
      );
    }
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

// -------------------------------------------------------------- write/check
// --check compares the destination against the freshly generated bytes and
// throws on a missing or drifted copy (vendor:check in consumer CI); otherwise
// write the file. `surfaceCount` is the full derived surface size for the
// "<n> of <m> exports" log lines.
function writeOrCheckOutput(expected, opts, { pkgName, exposedCount, surfaceCount, globals, shaken }) {
  const dest = resolve(process.cwd(), opts.out);

  if (opts.check) {
    let current = '';
    try {
      current = readFileSync(dest, 'utf8');
    } catch {
      vendorFail(`${opts.out} missing — run \`npm run vendor:sync\`.`);
    }
    if (current !== expected) {
      vendorFail(`${opts.out} is out of sync with the pinned ${pkgName}.\nRun \`npm install && npm run vendor:sync\` and commit the result.`);
    }
    console.log(`${pkgName} vendor: ${opts.out} is in sync (${exposedCount} of ${surfaceCount} exports exposed).`);
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, expected);
    const shape = globals && globals.length > 1 ? `${globals.length} globals, ` : '';
    const shape2 = shaken ? ', tree-shaken to the reachable body' : '';
    console.log(`${pkgName} vendor: wrote ${opts.out} (format ${opts.format}, ${shape}${exposedCount} of ${surfaceCount} exports${shape2}).`);
  }
}

// ------------------------------------------------------------- orchestrator

export function runVendorCli(kitDir, argv = process.argv.slice(2)) {
  const pkg = JSON.parse(readFileSync(`${kitDir}/package.json`, 'utf8'));
  const source = readFileSync(`${kitDir}/index.js`, 'utf8');

  const repoMatch = String(pkg.repository?.url || '').match(
    /github\.com[/:]([^/]+\/[^/.]+)/
  );
  const repo = repoMatch ? repoMatch[1] : pkg.name;

  function fail(msg) {
    console.error(`${pkg.name} vendor: ${msg}`);
    process.exit(1);
  }

  try {
    const { opts, globalSpecs } = parseVendorArgs(argv);
    const surface = deriveKitSurface(source, opts, kitDir);
    const exposure = resolveKitExposure(surface, opts, globalSpecs, pkg.name);
    const narrowed = narrowKitBody(source, opts.format, exposure, surface, pkg);
    if (narrowed.note) console.warn(`${pkg.name} vendor: ${narrowed.note}`);
    const expected = emitVendoredOutput(opts.format, narrowed.body, exposure, pkg, repo);
    writeOrCheckOutput(expected, opts, {
      pkgName: pkg.name,
      exposedCount: exposure.exposedCount,
      surfaceCount: surface.length,
      globals: exposure.globals,
      shaken: narrowed.shaken,
    });
  } catch (err) {
    // Only the CLI's own refusals become the classic stderr line + exit 1;
    // anything else (unreadable kit dir, JSON parse) propagates unchanged.
    if (err instanceof VendorCliError) fail(err.message);
    else throw err;
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
//
// Resolution is GIT-FIRST (`git ls-remote <url> HEAD`) with the GitHub REST
// API kept as the fallback. The API path used to be the only path, and it is
// dead in every git-proxy-based environment (Claude Code remote sessions and
// similar): the ambient credential there is scoped to the git transport, not
// to api.github.com, so `commits/HEAD` answers 401 authenticated and 403
// unauthenticated for these private repos and the bin died before bumping
// anything. `git` reaches the same repos through whatever transport the
// environment already has configured. The API path stays because it DOES work
// in GitHub Actions (where `GITHUB_TOKEN` is API-scoped) and covers a git
// binary that is missing or blocked.
// ---------------------------------------------------------------------------
const KIT_PIN_RE = /^github:(jsvolos63\/[A-Za-z0-9._-]+)#([0-9a-f]{40})$/;
const REPO_RE = /^jsvolos63\/[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

// Bound each GitHub API call: these bins run unattended in CI workflows, and
// a fetch with no signal can hang until the job's own timeout kills it with
// nothing in the log. 30s is generous for a metadata GET.
const GITHUB_API_TIMEOUT_MS = 30_000;
// The git subprocesses get the same bound, for the same reason: a git sitting
// on a credential prompt or a dead proxy must not wedge an unattended job.
const GIT_TIMEOUT_MS = GITHUB_API_TIMEOUT_MS;

// A repo name here already matched KIT_PIN_RE, but it ends up in a subprocess
// argv and a URL — re-assert the shape at the boundary rather than trusting
// the caller.
function gitRepoUrl(repo) {
  if (!REPO_RE.test(repo)) {
    throw new Error(`refusing to run git for unexpected repo name "${String(repo).slice(0, 60)}"`);
  }
  return `https://github.com/${repo}`;
}

// Always an argument ARRAY, never a shell string, so nothing in a repo name or
// SHA can reach a shell. GIT_TERMINAL_PROMPT=0 (plus a no-op askpass) keeps a
// credential-less environment from blocking on an interactive prompt.
function runGit(args, opts = {}) {
  return spawnSync('git', args, {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
    ...opts,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'true',
      GCM_INTERACTIVE: 'never',
      ...(opts.env || {}),
    },
  });
}

function gitFailureReason(res) {
  if (res.error) return res.error.message;
  if (res.signal) return `git killed by ${res.signal} (timeout ${GIT_TIMEOUT_MS}ms)`;
  const last = String(res.stderr || '').trim().split('\n').filter(Boolean).pop();
  return last || `git exited ${res.status}`;
}

// -> { sha } on success, { error } when git could not answer.
function gitHeadSha(repo, run = runGit) {
  let res;
  try {
    res = run(['ls-remote', gitRepoUrl(repo), 'HEAD']);
  } catch (err) {
    return { error: err?.message || String(err) };
  }
  if (!res || res.error || res.status !== 0) return { error: res ? gitFailureReason(res) : 'git produced no result' };
  const first = String(res.stdout || '').trim().split('\n')[0] || '';
  const sha = first.split(/\s+/)[0];
  if (!SHA_RE.test(sha)) return { error: `unexpected ls-remote output "${first.slice(0, 60)}"` };
  return { sha };
}

async function apiHeadSha(repo) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/HEAD`, {
    headers: {
      accept: 'application/vnd.github.sha',
      'user-agent': 'kit-pin-bump',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${repo}: GitHub API returned HTTP ${res.status}`);
  const sha = (await res.text()).trim();
  if (!SHA_RE.test(sha)) {
    throw new Error(`${repo}: unexpected HEAD response "${sha.slice(0, 60)}"`);
  }
  return sha;
}

// Exported for tests only: `run` stands in for runGit so the git path can be
// exercised (both branches) without a network.
export async function _fetchHeadSha(repo, { run = runGit } = {}) {
  // Assert the shape once, up front: `repo` reaches both a subprocess argv and
  // a URL, and neither transport should ever see an unvalidated name.
  if (!REPO_RE.test(repo)) {
    throw new Error(`refusing to resolve unexpected repo name "${String(repo).slice(0, 60)}"`);
  }
  const viaGit = gitHeadSha(repo, run);
  if (viaGit.sha) return viaGit.sha;
  try {
    return await apiHeadSha(repo);
  } catch (apiErr) {
    // Both transports failed. Name each failure in one line so the log doesn't
    // just read "HTTP 401" and send the reader off to the API docs.
    throw new Error(
      `${repo}: could not resolve HEAD — git ls-remote failed (${viaGit.error}); ` +
        `GitHub API fallback failed (${apiErr?.message || apiErr})`
    );
  }
}

const fetchHeadSha = (repo) => _fetchHeadSha(repo);

// Explicit `--pin <kit>=<sha>` overrides: validate the SHA shape AND that the
// named kit is really pinned in this package.json, so a typo fails with a
// clear message instead of writing a package.json npm can't install.
function resolveExplicitPins(explicit, pins) {
  const overrides = new Map(); // pin object -> sha
  for (const [rawName, rawSha] of Object.entries(explicit || {})) {
    const sha = String(rawSha ?? '').trim().toLowerCase();
    if (!SHA_RE.test(sha)) {
      throw new Error(
        `--pin ${rawName}: "${String(rawSha ?? '').slice(0, 60)}" is not a 40-character hex commit SHA`
      );
    }
    const match = pins.find(
      (p) => p.names.has(rawName) || p.repo === rawName || p.repo.split('/')[1] === rawName
    );
    if (!match) {
      const known = pins.map((p) => [...p.names][0]).join(', ') || 'none';
      throw new Error(`--pin ${rawName}: no kit pinned as "${rawName}" in package.json (pinned kits: ${known})`);
    }
    overrides.set(match, sha);
  }
  return overrides;
}

// Parse the `jfs-bump-kit-pins` argv. Exported so the bin stays a thin shim and
// the flag handling is testable without spawning anything.
export function parseBumpKitPinsArgs(argv = []) {
  const pins = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let spec;
    if (arg === '--pin') {
      spec = argv[++i];
      if (spec === undefined) throw new Error('--pin requires a <kit>=<sha> argument');
    } else if (arg.startsWith('--pin=')) {
      spec = arg.slice('--pin='.length);
    } else {
      throw new Error(`unknown argument "${arg}" (usage: jfs-bump-kit-pins [--pin <kit>=<sha>]...)`);
    }
    const eq = spec.indexOf('=');
    if (eq <= 0) throw new Error(`--pin ${spec}: expected <kit>=<sha>`);
    pins[spec.slice(0, eq)] = spec.slice(eq + 1);
  }
  return { pins };
}

export async function bumpKitPins(
  rootDir = process.cwd(),
  { resolveHead = fetchHeadSha, pins: explicitPins = null } = {}
) {
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
      dup.names.add(name); // …but every alias can still name it in a --pin
      return;
    }
    const pin = { name, repo: m[1], pinned: m[2], vendored, names: new Set([name]) };
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

  // Explicit pins are validated up front — before ANY resolution — so a typo'd
  // SHA or an unknown kit name fails immediately instead of after a round of
  // network calls (and never half-writes package.json).
  const overrides = resolveExplicitPins(explicitPins, pins);

  let out = raw;
  let changed = false;
  let vendoredChanged = false;
  for (const pin of pins) {
    const { name, repo, pinned, vendored } = pin;
    const explicit = overrides.get(pin);
    // An explicit pin skips resolution for that kit entirely — that is the
    // point of the flag (pin to a known-good older commit, or bump without any
    // remote access at all).
    const head = explicit ?? (await resolveHead(repo));
    const how = explicit ? ' (explicit --pin)' : '';
    if (head === pinned) {
      console.log(`${name}: up to date at ${pinned.slice(0, 7)}${how}`);
      continue;
    }
    out = out.replaceAll(`github:${repo}#${pinned}`, `github:${repo}#${head}`);
    changed = true;
    if (vendored) vendoredChanged = true;
    console.log(`${name}: ${pinned.slice(0, 7)} -> ${head.slice(0, 7)}${how}`);
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
// one-line "pin X#<sha> does not exist" and fails fast. `checkExists` is
// injectable so tests never hit the network. Scans the same sections and pin
// format as `bumpKitPins`, so the two stay symmetric. Throws on any missing
// pin (or an inconclusive check); returns the number of pins verified.
//
// Existence is GIT-FIRST for the same reason HEAD resolution is (see above):
// `git fetch --depth=1 <url> <sha>` into a throwaway bare repo, with the API
// as the fallback. `git ls-remote` alone would NOT do — pins routinely point
// at commits that are no longer at any ref tip, and ls-remote only lists tips.
// A depth-1 fetch of the exact SHA succeeds for a real historical commit and
// fails with "upload-pack: not our ref" for one that does not exist, which is
// exactly the distinction this pre-flight needs.
//
// FAIL-CLOSED CONTRACT (do not relax): only a positive "the remote says this
// ref is not ours" answer counts as missing, and only a clean fetch counts as
// present. Everything else — no git binary, transport error, timeout, an API
// 403/5xx — is INCONCLUSIVE and must throw, never quietly pass. A network
// outage turning this check green is the one failure mode that would make the
// whole pre-flight worthless.
// ---------------------------------------------------------------------------

// Remote answers that positively mean "that commit is not on this repo".
const GIT_MISSING_REF_RE =
  /(upload-pack: not our ref|not our ref|couldn't find remote ref|no such remote ref|unadvertised object|did not send all necessary objects)/i;

// -> { result: true|false } when git answered definitively, { error } when it
// could not answer at all.
function gitCommitExists(repo, sha, run = runGit) {
  if (!SHA_RE.test(sha)) return { result: false }; // malformed pin can't exist
  let url;
  try {
    url = gitRepoUrl(repo);
  } catch (err) {
    return { error: err?.message || String(err) };
  }
  let dir = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'jfs-kit-pin-'));
    const init = run(['init', '--quiet', '--bare', dir]);
    if (!init || init.error || init.status !== 0) {
      return { error: init ? gitFailureReason(init) : 'git produced no result' };
    }
    const res = run(['fetch', '--quiet', '--depth=1', url, sha], { cwd: dir });
    if (!res) return { error: 'git produced no result' };
    if (!res.error && res.status === 0) return { result: true };
    const text = `${res.stderr || ''}\n${res.error?.message || ''}`;
    if (!res.error && GIT_MISSING_REF_RE.test(text)) return { result: false };
    return { error: gitFailureReason(res) };
  } catch (err) {
    return { error: err?.message || String(err) };
  } finally {
    // Clean up on every path, including a throw — these are bare repos in the
    // system temp dir and an unattended CI job may run this many times.
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort: a temp-dir removal failure must not mask the result.
      }
    }
  }
}

async function apiCommitExists(repo, sha) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}`, {
    headers: {
      accept: 'application/vnd.github.sha',
      'user-agent': 'kit-pin-check',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (res.status === 200) return true;
  // 404 (unknown repo/commit) and 422 (malformed sha) both mean "not a real
  // pin"; anything else (403 rate-limit, 5xx) is inconclusive, not "missing".
  if (res.status === 404 || res.status === 422) return false;
  throw new Error(`${repo}@${sha.slice(0, 7)}: GitHub API returned HTTP ${res.status}`);
}

// Exported for tests only: `run` stands in for runGit so both branches can be
// exercised without a network.
export async function _commitExists(repo, sha, { run = runGit } = {}) {
  if (!REPO_RE.test(repo)) {
    throw new Error(`refusing to check unexpected repo name "${String(repo).slice(0, 60)}"`);
  }
  const viaGit = gitCommitExists(repo, sha, run);
  if (viaGit.result !== undefined) return viaGit.result;
  try {
    return await apiCommitExists(repo, sha);
  } catch (apiErr) {
    // Inconclusive on BOTH transports -> throw. verifyKitPins turns this into
    // a non-zero exit; it must never be read as "the pin is fine".
    throw new Error(
      `${repo}@${sha.slice(0, 7)}: could not verify pin — git fetch failed (${viaGit.error}); ` +
        `GitHub API fallback failed (${apiErr?.message || apiErr})`
    );
  }
}

const commitExists = (repo, sha) => _commitExists(repo, sha);

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
//
// With `{ "packageVersion": true }` the lockfile is stamped too — see
// stampLockfile below.
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
    let src;
    try {
      src = readFileSync(resolve(rootDir, p), 'utf8');
    } catch (e) {
      return failStamp(`cannot read versionStamp.source.fromFile ${p}: ${e.message}`);
    }
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

// ---------------------------------------------------------------------------
// package-lock.json carries the package's own version in two structural places
// — the root object's `version` and `packages[""].version` — and npm only
// resyncs them on an `npm install`. `npm ci` accepts a stale pair silently and
// does NOT rewrite the file, so a version bump committed without a local
// install leaves the committed lockfile behind, invisibly, until some unrelated
// install mops it up (which is how a "kit pin bump" PR ends up being nothing
// but two lockfile version lines). When package.json's `version` is the source
// of truth, treat those two values as stamp targets so `--check` catches the
// drift in CI like any other target.
//
// Deliberately textual, not JSON.parse → JSON.stringify: lockfiles run to
// thousands of lines and npm's exact serialization must survive, so we splice
// only the two version strings and leave every other byte alone. Both patterns
// are anchored so they cannot reach a dependency's `version`: the root one must
// sit at top-level indentation (npm indents package entries by 4+ spaces), and
// the packages one must be inside the `""` entry that opens the `packages`
// object, with `[^{}]` forbidding the match from crossing into a nested entry.
// ---------------------------------------------------------------------------
const LOCKFILE = 'package-lock.json';
const LOCK_TARGETS = [
  { what: 'version', re: /(^\{[\s\S]*?\n[ \t]{1,2}"version"[ \t]*:[ \t]*")([^"\n]*)(")/ },
  {
    what: 'packages[""].version',
    re: /("packages"[ \t]*:[ \t]*\{\s*""[ \t]*:[ \t]*\{[^{}]*?"version"[ \t]*:[ \t]*")([^"\n]*)(")/,
  },
];

// Returns true when `check` found drift. Any shape it does not recognise —
// missing file, a lockfile with no version fields (npm omits them when
// package.json has none) — is a clean no-op, never an error: Weather
// gitignores its lockfile and BearsMockDraft's package.json has no version.
function stampLockfile(rootDir, version, check) {
  const dest = resolve(rootDir, LOCKFILE);
  let src;
  try {
    src = readFileSync(dest, 'utf8');
  } catch {
    return false; // no lockfile in this repo — nothing to keep in lockstep
  }

  let next = src;
  const stale = [];
  for (const { what, re } of LOCK_TARGETS) {
    const m = next.match(re);
    if (!m) continue; // this lockfile shape doesn't carry that version
    if (m[2] === version) continue;
    stale.push(`${what}: ${m[2]}`);
    // Function replacer so `$`-sequences in the version can't be interpolated;
    // the non-global regex rewrites exactly the one anchored occurrence.
    next = next.replace(re, (_all, pre, _old, post) => pre + version + post);
  }

  if (!stale.length) return false;
  if (check) {
    console.error(
      `version-stamp: ${LOCKFILE} is out of date (expected ${version}; found ${stale.join(', ')})`
    );
    return true;
  }
  writeFileSync(dest, next);
  console.log(`version-stamp: stamped ${version} into ${LOCKFILE} (${stale.length} field(s))`);
  return false;
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
    let src;
    try {
      src = readFileSync(dest, 'utf8');
    } catch (e) {
      // A typo'd/renamed edit target should fail with the file named cleanly,
      // not an unhandled ENOENT stack out of the bin.
      return failStamp(`cannot read ${file}: ${e.message}`);
    }
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

  // Only when package.json's own `version` is the source of truth: a repo that
  // sources its version from elsewhere (a JS constant, a deploy id) has no
  // reason for its lockfile to carry that value.
  if (config.source?.packageVersion && typeof pkg.version === 'string') {
    if (stampLockfile(rootDir, version, check)) drift = true;
  }

  if (check && drift) failStamp('run `npm run version:stamp` and commit the result.');
  if (check) console.log(`version-stamp: all files in sync at ${version}.`);
}

// ---------------------------------------------------------------------------
// jfs-claude-md-sync — the CLAUDE.md family-conventions synchronizer.
//
// Every consumer's CLAUDE.md used to end with a hand-copied "Pull requests"
// section; seventeen copies of instructions that steer automated sessions is
// exactly the drift the vendoring flow exists to prevent, applied to the one
// artifact that wasn't covered. The canonical text now lives once, in
// family/family-conventions.md here, and each consumer carries it between two
// marker comments that this tool rewrites wholesale. Family CI runs the
// --check mode from a bare checkout of this repo, so no consumer needs
// @jfs/vendor-cli installed for the gate to hold.

const FAMILY_START =
  '<!-- jfs-family-conventions:start — managed by jfs-claude-md-sync; edit family/family-conventions.md in @jfs/vendor-cli -->';
const FAMILY_END = '<!-- jfs-family-conventions:end -->';

export function familyConventionsBlock() {
  const body = readFileSync(
    new URL('./family/family-conventions.md', import.meta.url),
    'utf8'
  ).trim();
  return `${FAMILY_START}\n\n${body}\n\n${FAMILY_END}`;
}

export function claudeMdSync(rootDir = process.cwd(), argv = []) {
  const check = argv.includes('--check');
  const fail = (msg) => {
    console.error(`claude-md-sync: ${msg}`);
    process.exit(1);
  };
  const target = resolve(rootDir, 'CLAUDE.md');
  let src;
  try {
    src = readFileSync(target, 'utf8');
  } catch (e) {
    return fail(`cannot read CLAUDE.md: ${e.message}`);
  }
  const block = familyConventionsBlock();
  const start = src.indexOf(FAMILY_START);
  const end = src.indexOf(FAMILY_END);
  let next;
  if (start === -1 && end === -1) {
    // No block yet: append it (sync) — a repo adopting the family flow.
    if (check) return fail('CLAUDE.md has no family-conventions block — run `jfs-claude-md-sync` and commit the result.');
    next = src.replace(/\s*$/, '') + '\n\n' + block + '\n';
  } else if (start === -1 || end === -1 || end < start) {
    // Half a block (or end-before-start) means a hand edit mangled a marker;
    // rewriting around it would duplicate or eat prose, so stop either way.
    return fail('family-conventions markers are mangled (missing or out-of-order) — restore both markers, then re-run `jfs-claude-md-sync`.');
  } else {
    next = src.slice(0, start) + block + src.slice(end + FAMILY_END.length);
  }
  if (next === src) {
    console.log('claude-md-sync: CLAUDE.md family conventions in sync.');
    return;
  }
  if (check) return fail('CLAUDE.md family-conventions block is out of date — run `jfs-claude-md-sync` and commit the result.');
  writeFileSync(target, next);
  console.log('claude-md-sync: updated the CLAUDE.md family-conventions block.');
}

// ---------------------------------------------------------------------------
// jfs-sanitizer-policy-sync — the sanitizer-policy constants synchronizer.
//
// dom-kit's `_BLOCKED_TAGS` and news-kit's `DEFAULT_BLOCKED` are the same
// security-critical tag list, and the URL control-character strip regex
// existed three times across the two kits. A comment asserted the mirror and
// it still drifted (MATH was blocked in one kit and not the other) — exactly
// the failure jfs-claude-md-sync exists to prevent, applied to sanitizer
// policy. The canonical data now lives once, in family/sanitizer-policy.json
// here; each kit carries the constants between per-region marker comments
// that this tool rewrites wholesale:
//
//   // @jfs-sanitizer-policy:blocked-tags:start case=lower quote=double
//   "script", "style", ...
//   // @jfs-sanitizer-policy:blocked-tags:end
//
// Start-marker params drive a small per-region template, so each kit keeps
// its own formatting (dom-kit lowercase double-quoted, news-kit UPPERCASE
// single-quoted) while the VALUES can't drift. `--check` fails with a
// diff-style message instead of writing — each kit's CI runs that.

const POLICY_START_RE = /^([ \t]*)\/\/ @jfs-sanitizer-policy:([a-z-]+):start\b(.*)$/;
const POLICY_MARKER_RE = /@jfs-sanitizer-policy:[a-z-]+:(start|end)\b/;

export function sanitizerPolicy() {
  return JSON.parse(
    readFileSync(new URL('./family/sanitizer-policy.json', import.meta.url), 'utf8')
  );
}

// Render one blocked-tags item line-set: quoted, comma-separated, greedily
// wrapped at 80 columns at the marker's own indentation, so the output is
// deterministic (byte-stable) for a given policy + params.
function renderBlockedTags(policy, params, indent, bad) {
  const casing = params.case ?? 'lower';
  const quote = params.quote ?? 'single';
  for (const key of Object.keys(params)) {
    if (key !== 'case' && key !== 'quote') bad(`unknown param '${key}' for blocked-tags (allowed: case, quote)`);
  }
  if (casing !== 'lower' && casing !== 'upper') bad(`param case=${casing} must be 'lower' or 'upper'`);
  if (quote !== 'single' && quote !== 'double') bad(`param quote=${quote} must be 'single' or 'double'`);
  const q = quote === 'double' ? '"' : "'";
  const items = policy.blockedTags.map(
    (t) => `${q}${casing === 'upper' ? t.toUpperCase() : t}${q},`
  );
  const lines = [];
  let line = '';
  for (const item of items) {
    const candidate = line ? `${line} ${item}` : indent + item;
    if (line && candidate.length > 80) {
      lines.push(line);
      line = indent + item;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Render the URL control-character strip regex as a complete const
// declaration (the const NAME is the per-kit knob).
function renderUrlControlChars(policy, params, indent, bad) {
  for (const key of Object.keys(params)) {
    if (key !== 'const') bad(`unknown param '${key}' for url-control-chars (allowed: const)`);
  }
  const name = params.const;
  if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) {
    bad(`url-control-chars needs const=<identifier> (got '${name ?? ''}')`);
  }
  const { source, flags } = policy.urlControlChars;
  return [`${indent}const ${name} = /${source}/${flags};`];
}

const POLICY_REGIONS = {
  'blocked-tags': renderBlockedTags,
  'url-control-chars': renderUrlControlChars,
};

export function sanitizerPolicySync(rootDir = process.cwd(), argv = []) {
  const check = argv.includes('--check');
  const fail = (msg) => {
    console.error(`sanitizer-policy-sync: ${msg}`);
    process.exit(1);
  };
  const unknownFlag = argv.find((a) => a.startsWith('--') && a !== '--check');
  if (unknownFlag) return fail(`unknown flag ${unknownFlag}`);
  const targets = argv.filter((a) => !a.startsWith('--'));
  if (targets.length === 0) {
    return fail('usage: jfs-sanitizer-policy-sync [--check] <file> …');
  }
  const policy = sanitizerPolicy();
  let drift = false;
  for (const file of targets) {
    const path = resolve(rootDir, file);
    let src;
    try {
      src = readFileSync(path, 'utf8');
    } catch (e) {
      return fail(`cannot read ${file}: ${e.message}`);
    }
    const lines = src.split('\n');
    const out = [];
    let regions = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = POLICY_START_RE.exec(lines[i]);
      if (!m) {
        // A stray end marker outside a region means a hand edit mangled its
        // start; rewriting around it would eat or duplicate code, so stop.
        if (POLICY_MARKER_RE.test(lines[i])) {
          return fail(`${file}:${i + 1}: sanitizer-policy markers are mangled (end without start, or a malformed start marker) — restore the marker pair, then re-run.`);
        }
        out.push(lines[i]);
        continue;
      }
      const [, indent, region, rawParams] = m;
      const render = POLICY_REGIONS[region];
      if (!render) {
        return fail(`${file}:${i + 1}: unknown region '${region}' (known: ${Object.keys(POLICY_REGIONS).join(', ')})`);
      }
      const endMarker = `@jfs-sanitizer-policy:${region}:end`;
      let j = i + 1;
      while (j < lines.length && !lines[j].includes(endMarker)) {
        if (POLICY_MARKER_RE.test(lines[j])) {
          return fail(`${file}:${j + 1}: sanitizer-policy markers are mangled (nested or mismatched marker inside region '${region}') — restore the marker pair, then re-run.`);
        }
        j++;
      }
      if (j === lines.length) {
        return fail(`${file}:${i + 1}: region '${region}' has no end marker — restore it, then re-run.`);
      }
      const params = {};
      for (const tok of rawParams.trim().split(/\s+/).filter(Boolean)) {
        const pm = /^([a-z]+)=(\S+)$/.exec(tok);
        if (!pm) return fail(`${file}:${i + 1}: malformed param '${tok}' in region '${region}' (expected key=value)`);
        params[pm[1]] = pm[2];
      }
      const bad = (msg) => fail(`${file}:${i + 1}: ${msg}`);
      const body = render(policy, params, indent, bad);
      const current = lines.slice(i + 1, j);
      if (current.join('\n') !== body.join('\n')) {
        drift = true;
        if (check) {
          console.error(`sanitizer-policy-sync: ${file} region '${region}' is out of date:`);
          for (const l of current) console.error(`- ${l}`);
          for (const l of body) console.error(`+ ${l}`);
        }
      }
      out.push(lines[i], ...body, lines[j]);
      i = j;
      regions++;
    }
    if (regions === 0) {
      // A target with no regions is a misconfiguration, not "clean": passing
      // silently would let a deleted marker disable the gate.
      return fail(`${file}: no @jfs-sanitizer-policy regions found — add the start/end markers first.`);
    }
    const next = out.join('\n');
    if (next === src) {
      console.log(`sanitizer-policy-sync: ${file} in sync (${regions} region${regions === 1 ? '' : 's'}).`);
    } else if (!check) {
      writeFileSync(path, next);
      console.log(`sanitizer-policy-sync: updated ${file}.`);
    }
  }
  if (check && drift) {
    return fail('sanitizer-policy regions are out of date — run `jfs-sanitizer-policy-sync <file>` and commit the result.');
  }
  if (check) console.log('sanitizer-policy-sync: all regions in sync.');
}
