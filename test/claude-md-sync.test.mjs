// Tests for claudeMdSync (the jfs-claude-md-sync bin): appending the
// family-conventions block to a CLAUDE.md that lacks it, rewriting a stale
// block in place, idempotence, and the --check / mangled-marker failure paths.
// Happy paths call the export directly against a temp dir; failure paths spawn
// the bin since claudeMdSync exits the process on failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'claude-md-sync.mjs');
const { claudeMdSync, familyConventionsBlock } = await import(
  pathToFileURL(join(ROOT, 'index.mjs'))
);

function freshDir(claudeMd) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-md-sync-test-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  if (claudeMd !== undefined) writeFileSync(join(dir, 'CLAUDE.md'), claudeMd);
  return dir;
}

function runBin(cwd, args = []) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
}

test('familyConventionsBlock wraps the canonical text in the markers', () => {
  const block = familyConventionsBlock();
  assert.ok(block.startsWith('<!-- jfs-family-conventions:start'));
  assert.ok(block.endsWith('<!-- jfs-family-conventions:end -->'));
  assert.match(block, /## Family conventions/);
  assert.match(block, /never as drafts/);
  assert.match(block, /Kit extraction bar/);
});

test('sync appends the block to a CLAUDE.md without one, then is idempotent', () => {
  const dir = freshDir('# Some repo — notes\n\nBody text.\n');
  claudeMdSync(dir, []);
  const first = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
  assert.ok(first.startsWith('# Some repo — notes\n\nBody text.\n\n'));
  assert.ok(first.trimEnd().endsWith('<!-- jfs-family-conventions:end -->'));
  assert.match(first, /never as drafts/);
  claudeMdSync(dir, []);
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), first);
});

test('sync rewrites a stale block in place, preserving surrounding prose', () => {
  const block = familyConventionsBlock();
  const stale = block.replace('never as drafts', 'ALWAYS as drafts');
  const dir = freshDir(`# Repo\n\nIntro.\n\n${stale}\n\n## Local section\n\nKept.\n`);
  claudeMdSync(dir, []);
  const out = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(out, /never as drafts/);
  assert.doesNotMatch(out, /ALWAYS as drafts/);
  assert.match(out, /## Local section\n\nKept\./);
});

test('--check passes on a synced file', () => {
  const dir = freshDir('# Repo\n');
  claudeMdSync(dir, []);
  const res = runBin(dir, ['--check']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /in sync/);
});

test('--check fails when the block is missing', () => {
  const res = runBin(freshDir('# Repo\n\nNo block here.\n'), ['--check']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no family-conventions block/);
});

test('--check fails when the block is stale', () => {
  const dir = freshDir('# Repo\n');
  claudeMdSync(dir, []);
  const path = join(dir, 'CLAUDE.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('never as drafts', 'sometimes as drafts'));
  const res = runBin(dir, ['--check']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /out of date/);
});

test('a mangled marker fails both modes rather than rewriting around it', () => {
  const half = '# Repo\n\n<!-- jfs-family-conventions:end -->\n';
  for (const args of [[], ['--check']]) {
    const res = runBin(freshDir(half), args);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /mangled/);
  }
});

test('a missing CLAUDE.md fails cleanly', () => {
  const res = runBin(freshDir(), []);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /cannot read CLAUDE\.md/);
});
