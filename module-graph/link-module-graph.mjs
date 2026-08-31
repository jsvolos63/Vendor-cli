// Static link of an ES module graph — no DOM, no bundler, no evaluation.
//
//   node --experimental-vm-modules link-module-graph.mjs <entry.js>
//
// Writes one JSON object to stdout:
//   { ok: true,  modules: ["/abs/path.js", …] }   // every file in the graph
//   { ok: false, error: "…", stack: "…" }
//
// Run as a CHILD PROCESS, because the only way to *link* modules without
// running their bodies is `vm.SourceTextModule`, which needs
// `--experimental-vm-modules` set at process start — neither `node --test` nor
// vitest sets it. `module-graph/index.mjs` spawns this for you.
//
// Why it exists: an app whose browser module graph has no build step gets no
// compile-time check at all. `<script type="module">` makes the BROWSER resolve
// the graph, and if any link fails it instantiates NOTHING — blank page, no
// partial render, and a service worker will happily serve the same broken shell
// from cache. Nothing else in a typical CI run sees that: ESLint parses each
// module in isolation and never resolves a specifier, and vitest transforms ESM
// through esbuild, so a missing named import arrives as `undefined` rather than
// a link error.
//
// Linking (rather than importing) is what catches BOTH failure modes:
//   * a specifier that resolves to no file  (the linker callback throws), and
//   * `import { x }` where the source module has no such export
//     (V8 throws "does not provide an export named 'x'" during link),
// and with no new dependency. It stops short of Evaluate(), so module bodies —
// which touch document, window and import.meta — never run.
//
// Only relative and absolute specifiers resolve: the browser loads these files
// directly, so a bare specifier would 404 there and is an error here.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

const modules = new Map(); // absolute path -> vm.SourceTextModule
// Bodies are never evaluated, so an empty context is enough.
const context = vm.createContext({});

function load(file) {
    const existing = modules.get(file);
    if (existing) return existing;
    const source = fs.readFileSync(file, 'utf8');
    const mod = new vm.SourceTextModule(source, {
        identifier: url.pathToFileURL(file).href,
        context,
        // Never called — we stop before Evaluate() — but supplying it keeps a
        // module that reads `import.meta.url` (to locate a sibling data dir,
        // say) from being a special case if that ever changes.
        initializeImportMeta(meta) { meta.url = url.pathToFileURL(file).href; }
    });
    modules.set(file, mod);
    return mod;
}

function linker(specifier, referencingModule) {
    const from = url.fileURLToPath(referencingModule.identifier);
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        throw new Error(
            `bare specifier ${JSON.stringify(specifier)} imported from ${from} — the browser `
            + 'loads these files directly, so only relative specifiers resolve'
        );
    }
    const resolved = path.resolve(path.dirname(from), specifier);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error(
            `unresolved import ${JSON.stringify(specifier)} from ${from} — no file at ${resolved}`
        );
    }
    return load(resolved);
}

let result;
try {
    if (typeof vm.SourceTextModule !== 'function') {
        throw new Error(
            'vm.SourceTextModule is unavailable — this Node build no longer supports '
            + '--experimental-vm-modules. Rework this helper rather than dropping the check: '
            + 'a buildless module graph has no other gate, and it is the one part of such a '
            + 'repo with no compile step to catch a bad import.'
        );
    }
    const entry = path.resolve(process.argv[2] || '');
    if (!fs.existsSync(entry)) throw new Error(`entry point does not exist: ${entry}`);

    const root = load(entry);
    await root.link(linker);
    result = { ok: true, modules: [...modules.keys()] };
} catch (e) {
    result = { ok: false, error: String((e && e.message) || e), stack: (e && e.stack) || null };
}

// One write, no process.exit() — let the stream flush on its own so the parent
// can never read a truncated payload.
process.stdout.write(JSON.stringify(result));
