// The module-graph helper's own suite.
//
// This helper is a GATE, so the property that matters most is that it still
// fails on a broken graph. A linker that reported ok:true for everything would
// satisfy every assertion in all five consumer repos at once, so the failure
// modes are tested here first-hand rather than only through linkProbe.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    LINKER_PATH,
    linkGraph,
    linkGraphs,
    linkProbe,
    listModuleFiles,
    findOrphans,
    outsideModules,
    dynamicImportTargets
} from '../module-graph/index.mjs';

function scratch(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jfs-mg-test-'));
    for (const [name, source] of Object.entries(files)) {
        const target = path.join(dir, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, source);
    }
    return dir;
}

test('the linker file ships and is spawnable', () => {
    assert.ok(fs.existsSync(LINKER_PATH), `${LINKER_PATH} is missing from the package`);
});

test('links a graph whose imports all resolve', () => {
    const r = linkProbe({
        'entry.js': "import { present } from './dep.js';\nexport { present };\n",
        'dep.js': 'export const present = 1;\n'
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.modules.length, 2);
});

test('FAILS on a specifier that resolves to no file', () => {
    const r = linkProbe({ 'entry.js': "import './does-not-exist.js';\n" });
    assert.equal(r.ok, false);
    assert.match(r.error, /unresolved import/);
});

test('FAILS on a named import the source module does not export', () => {
    const r = linkProbe({
        'entry.js': "import { imaginary } from './dep.js';\nexport { imaginary };\n",
        'dep.js': 'export const real = 1;\n'
    });
    assert.equal(r.ok, false);
    // The wording is V8's; match the part that identifies the failure.
    assert.match(r.error, /does not provide an export named/);
});

test('FAILS on a bare specifier — the browser would 404 it', () => {
    const r = linkProbe({ 'entry.js': "import x from 'some-package';\nexport { x };\n" });
    assert.equal(r.ok, false);
    assert.match(r.error, /bare specifier/);
});

test('FAILS on a syntax error rather than reporting a linked graph', () => {
    const r = linkProbe({ 'entry.js': 'export const = ;\n' });
    assert.equal(r.ok, false);
    assert.ok(r.error.length > 0);
});

test('reports a missing entry point as a link failure, not a throw', () => {
    const r = linkGraph(path.join(os.tmpdir(), 'jfs-mg-nope', 'entry.js'));
    assert.equal(r.ok, false);
    assert.match(r.error, /does not exist/);
});

test('linkGraphs unions several entries and de-duplicates the shared tail', () => {
    const dir = scratch({
        'a.js': "import { s } from './shared.js';\nexport { s };\n",
        'b.js': "import { s } from './shared.js';\nexport const t = s;\n",
        'shared.js': 'export const s = 1;\n'
    });
    try {
        const r = linkGraphs({ entries: ['a.js', 'b.js'], cwd: dir });
        assert.equal(r.ok, true, r.error);
        assert.equal(r.modules.length, 3, 'shared.js must appear once, not twice');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('linkGraphs reports which entry failed, and keeps going', () => {
    const dir = scratch({
        'good.js': 'export const ok = 1;\n',
        'bad.js': "import './missing.js';\n"
    });
    try {
        const r = linkGraphs({ entries: ['good.js', 'bad.js'], cwd: dir });
        assert.equal(r.ok, false);
        assert.equal(r.failures.length, 1);
        assert.equal(r.failures[0].entry, path.join(dir, 'bad.js'));
        assert.match(r.error, /bad\.js/);
        // good.js still linked, so a caller can report partial context.
        assert.ok(r.modules.includes(path.join(dir, 'good.js')));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('linkGraphs refuses an empty entry list rather than passing vacuously', () => {
    const r = linkGraphs({ entries: [] });
    assert.equal(r.ok, false);
    assert.match(r.error, /no entries/);
});

test('followDynamic reaches a lazily-imported subgraph — and is off by default', () => {
    const dir = scratch({
        'entry.js': "export function open() { return import('./lazy.js'); }\n",
        'lazy.js': "import { helper } from './helper.js';\nexport { helper };\n",
        'helper.js': 'export const helper = 1;\n'
    });
    try {
        const off = linkGraphs({ entries: ['entry.js'], cwd: dir });
        assert.equal(off.modules.length, 1, 'a static link cannot see import()');

        const on = linkGraphs({ entries: ['entry.js'], cwd: dir, followDynamic: true });
        assert.equal(on.ok, true, on.error);
        assert.equal(on.modules.length, 3, 'lazy.js and its own import must be reached');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('followDynamic surfaces a dynamic import whose target is missing', () => {
    const dir = scratch({ 'entry.js': "export const go = () => import('./gone.js');\n" });
    try {
        const r = linkGraphs({ entries: ['entry.js'], cwd: dir, followDynamic: true });
        assert.equal(r.ok, false);
        assert.match(r.error, /does not exist/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('dynamicImportTargets finds relative literals and ignores bare ones', () => {
    const dir = scratch({
        'm.js': "const a = import('./x.js'); const b = import(\"../y.js\"); const c = import('pkg');\n"
    });
    try {
        const found = dynamicImportTargets(path.join(dir, 'm.js')).map((p) => path.basename(p));
        assert.deepEqual(found.sort(), ['x.js', 'y.js']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('listModuleFiles walks recursively and honours file AND directory excludes', () => {
    const dir = scratch({
        'js/app.js': '',
        'js/lib/util.js': '',
        'js/vendor/kit.global.js': '',
        'js/classic.js': '',
        'js/notes.md': ''
    });
    try {
        const files = listModuleFiles({
            root: dir,
            dirs: ['js'],
            exclude: ['js/vendor', 'js/classic.js']
        }).map((p) => path.relative(dir, p).split(path.sep).join('/'));
        assert.deepEqual(files, ['js/app.js', 'js/lib/util.js']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('listModuleFiles refuses a directory that does not exist', () => {
    // A renamed or mistyped `dirs` entry must fail the gate, not turn the
    // orphan check into a vacuous pass.
    const dir = scratch({ 'js/app.js': '' });
    try {
        assert.throws(
            () => listModuleFiles({ root: dir, dirs: ['src'] }),
            /no such directory/
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('findOrphans names the file nothing imports', () => {
    const dir = scratch({
        'js/app.js': "import './used.js';\n",
        'js/used.js': 'export const a = 1;\n',
        'js/stray.js': 'export const b = 2;\n'
    });
    try {
        const r = linkGraphs({ entries: ['js/app.js'], cwd: dir });
        assert.equal(r.ok, true, r.error);
        const orphans = findOrphans({ root: dir, dirs: ['js'], reached: r.modules });
        assert.deepEqual(orphans, ['js/stray.js']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('outsideModules reports only what escapes the named directories', () => {
    const dir = scratch({
        'js/app.js': "import './lib.js';\nimport '../shared/psp.js';\n",
        'js/lib.js': 'export const a = 1;\n',
        'shared/psp.js': 'export const b = 2;\n'
    });
    try {
        const r = linkGraphs({ entries: ['js/app.js'], cwd: dir });
        assert.equal(r.ok, true, r.error);
        assert.deepEqual(outsideModules({ root: dir, within: ['js'], reached: r.modules }),
            ['shared/psp.js']);
        assert.deepEqual(outsideModules({ root: dir, within: ['js', 'shared'], reached: r.modules }),
            []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('paths come back POSIX-separated, so consumer assertions are portable', () => {
    const dir = scratch({
        'js/app.js': 'export const a = 1;\n',
        'js/deep/nested/orphan.js': 'export const b = 2;\n'
    });
    try {
        const r = linkGraphs({ entries: ['js/app.js'], cwd: dir });
        const orphans = findOrphans({ root: dir, dirs: ['js'], reached: r.modules });
        assert.deepEqual(orphans, ['js/deep/nested/orphan.js']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
