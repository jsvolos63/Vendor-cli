// The buildless-module-graph gate, shared.
//
// An app that ships `<script type="module">` with no build step has no
// compile-time check on its own import graph: the BROWSER resolves it, and a
// specifier that resolves to nothing — or an `import { x }` naming an export
// its source doesn't have — makes the browser instantiate NOTHING. Blank page,
// no partial render, and the service worker re-serves the same broken shell
// from cache. ESLint parses each module in isolation and never resolves a
// specifier; vitest transforms ESM through esbuild, so a missing named import
// arrives as `undefined` rather than a link error. Both stay green.
//
// This module drives `link-module-graph.mjs` (V8's own resolver via
// `vm.SourceTextModule`, stopped before Evaluate() so no module body runs and
// no DOM is needed) and supplies the assertions the consumers were each
// hand-rolling around it: orphan detection, the outside-the-directory check,
// and a probe helper so every consumer can keep proving the linker still fails
// on a genuinely broken graph.
//
// It lives here rather than in a kit because it is DEV tooling — every repo
// already carries @jfs/vendor-cli as a devDependency, and a sixth kit for a
// test helper would not clear the family's extraction bar.
//
// Typical use (node --test or vitest alike):
//
//   import { linkGraphs, findOrphans } from '@jfs/vendor-cli/module-graph';
//   const { ok, error, modules } = linkGraphs({ entries: ['js/app.js'], cwd: ROOT });
//   assert.equal(ok, true, error);
//   assert.deepEqual(findOrphans({ reached: modules, dirs: ['js'], root: ROOT }), []);

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

/** Absolute path to the child-process linker. Spawn it yourself only if this
 *  module's API can't express what you need — pass it `--experimental-vm-modules`. */
export const LINKER_PATH = path.join(
    path.dirname(url.fileURLToPath(import.meta.url)),
    'link-module-graph.mjs'
);

/**
 * Link ONE entry point's graph.
 * @param {string} entry absolute path, or relative to `cwd`
 * @param {{cwd?: string}} [options]
 * @returns {{ok: boolean, modules?: string[], error?: string, stack?: string|null}}
 *   `modules` is every absolute file path in the graph, entry included.
 */
export function linkGraph(entry, options = {}) {
    const cwd = options.cwd || process.cwd();
    const abs = path.resolve(cwd, entry);
    let stdout;
    try {
        stdout = execFileSync(
            process.execPath,
            ['--experimental-vm-modules', '--no-warnings', LINKER_PATH, abs],
            { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        );
    } catch (e) {
        // The linker reports its own failures as ok:false on stdout, so getting
        // here means the PROCESS died — a Node without SourceTextModule, an OOM,
        // a bad spawn. Surface it as a link failure rather than throwing, so a
        // consumer's assertion message carries it.
        return {
            ok: false,
            error: `the linker process failed for ${abs}: ${String((e && e.message) || e)}`
                + ((e && e.stderr) ? `\n${e.stderr}` : ''),
            stack: (e && e.stack) || null
        };
    }
    try {
        return JSON.parse(stdout);
    } catch {
        return { ok: false, error: `the linker wrote unparseable output for ${abs}: ${stdout}`, stack: null };
    }
}

/** Relative dynamic-import literals — `import('./x.js')` — in one file's source.
 *  Static linking cannot see these, so a lazily-imported subgraph is its own entry. */
export function dynamicImportTargets(file) {
    const source = fs.readFileSync(file, 'utf8');
    const out = [];
    const re = /import\(\s*['"`](\.[^'"`]+)['"`]\s*\)/g;
    for (let m; (m = re.exec(source));) out.push(path.resolve(path.dirname(file), m[1]));
    return out;
}

/**
 * Link one or more entry points, optionally following dynamic imports to a
 * fixpoint, and return the union of everything reached.
 *
 * @param {Object} options
 * @param {string[]} options.entries entry paths (absolute, or relative to cwd)
 * @param {string} [options.cwd]
 * @param {boolean} [options.followDynamic=false] treat every `import('./x.js')`
 *   found in a reached module as an additional entry. Off by default: it can
 *   only ADD reached modules, which loosens an orphan check and tightens an
 *   outside check, so it is the caller's call rather than a silent default.
 * @returns {{ok: boolean, modules: string[], error: string|null, failures: Array<{entry: string, error: string}>}}
 *   `modules` is sorted and de-duplicated; on failure it holds whatever linked
 *   before the first failure, so a caller can still report partial context.
 */
export function linkGraphs(options = {}) {
    const cwd = options.cwd || process.cwd();
    const followDynamic = options.followDynamic === true;
    const queue = (options.entries || []).map((e) => path.resolve(cwd, e));
    if (queue.length === 0) {
        return { ok: false, modules: [], error: 'linkGraphs was given no entries', failures: [] };
    }

    const reached = new Set();
    const linked = new Set();
    const failures = [];

    while (queue.length) {
        const entry = queue.shift();
        if (linked.has(entry)) continue;
        linked.add(entry);

        if (!fs.existsSync(entry)) {
            failures.push({ entry, error: `entry point does not exist: ${entry}` });
            continue;
        }
        const result = linkGraph(entry, { cwd });
        if (!result.ok) {
            failures.push({ entry, error: result.error || 'unknown link failure' });
            continue;
        }
        for (const mod of result.modules) {
            reached.add(path.resolve(mod));
            if (followDynamic) {
                for (const target of dynamicImportTargets(mod)) {
                    if (!linked.has(target)) queue.push(target);
                }
            }
        }
    }

    return {
        ok: failures.length === 0,
        modules: [...reached].sort(),
        error: failures.length
            ? failures.map((f) => `${path.relative(cwd, f.entry)}: ${f.error}`).join('\n')
            : null,
        failures
    };
}

// Does `file` sit at, or under, one of `roots`?
function isUnder(file, roots) {
    return roots.some((root) => {
        if (file === root) return true;
        const rel = path.relative(root, file);
        return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
}

/**
 * Every `.js`/`.mjs` file under `dirs`, recursively, minus `exclude`.
 * @param {Object} options
 * @param {string[]} options.dirs directories to walk (absolute, or relative to root)
 * @param {string} [options.root] base for relative dirs/excludes (default cwd)
 * @param {string[]} [options.exclude] files OR directories to skip — a vendored
 *   kit build loaded by its own <script> tag, a classic script, a fixture dir
 * @param {string[]} [options.extensions=['.js','.mjs']]
 * @returns {string[]} absolute paths, sorted
 */
export function listModuleFiles(options = {}) {
    const root = options.root || process.cwd();
    const exts = options.extensions || ['.js', '.mjs'];
    const exclude = (options.exclude || []).map((p) => path.resolve(root, p));
    const out = [];

    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (isUnder(full, exclude)) continue;
            if (e.isDirectory()) walk(full);
            else if (e.isFile() && exts.includes(path.extname(e.name))) out.push(full);
        }
    };
    for (const dir of options.dirs || []) {
        const abs = path.resolve(root, dir);
        if (fs.existsSync(abs)) walk(abs);
    }
    return out.sort();
}

/**
 * Modules that exist on disk but no entry reaches — a dead file, or a
 * forgotten import. The converse of the link check, and the reason the gate
 * catches deletions as well as renames.
 * @returns {string[]} repo-relative, POSIX-separated, sorted
 */
export function findOrphans(options = {}) {
    const root = options.root || process.cwd();
    const reached = new Set((options.reached || []).map((p) => path.resolve(p)));
    return listModuleFiles(options)
        .filter((f) => !reached.has(f))
        .map((f) => relPosix(root, f))
        .sort();
}

/**
 * Reached modules that live OUTSIDE the given directories — files the deploy
 * may not expect to ship as modules, or (where reaching out is deliberate) the
 * exact shared set a service worker also has to precache.
 * @returns {string[]} repo-relative, POSIX-separated, sorted
 */
export function outsideModules(options = {}) {
    const root = options.root || process.cwd();
    const within = (options.within || []).map((d) => path.resolve(root, d));
    return (options.reached || [])
        .map((p) => path.resolve(p))
        .filter((f) => !isUnder(f, within))
        .map((f) => relPosix(root, f))
        .sort();
}

function relPosix(root, file) {
    return path.relative(root, file).split(path.sep).join('/');
}

/**
 * Link a throwaway graph written from `files` in a temp directory.
 *
 * This exists so every consumer can cheaply keep the meta-tests that prove the
 * linker still FAILS on a broken graph — without them, a linker that reported
 * `ok: true` for everything would satisfy every other assertion in the suite.
 *
 * @param {Record<string,string>} files filename → source; one must be the entry
 * @param {{entry?: string}} [options] entry filename (default 'entry.js')
 * @returns {{ok: boolean, modules?: string[], error?: string}}
 */
export function linkProbe(files, options = {}) {
    const entryName = options.entry || 'entry.js';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jfs-linkprobe-'));
    try {
        for (const [name, source] of Object.entries(files)) {
            const target = path.join(dir, name);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, source);
        }
        return linkGraph(path.join(dir, entryName), { cwd: dir });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
