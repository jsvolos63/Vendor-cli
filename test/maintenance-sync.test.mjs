// Tests for maintenanceSync (the jfs-maintenance-sync bin): appending the
// family-maintenance block to a MAINTENANCE.md that lacks it, rewriting a
// stale block in place, idempotence, and the --check / mangled-marker paths.
// Happy paths call the export directly against a temp dir; failure paths spawn
// the bin since maintenanceSync exits the process on failure.
//
// The case that matters most here is the last one. Unlike its CLAUDE.md twin
// this tool must REFUSE to create the file it owns: MAINTENANCE.md is half
// canonical and half repo-specific, so a file holding only the family block
// would satisfy the gate while saying nothing about the repo — the hollow pass
// the protocol's own "do not let a check pass quietly" rule forbids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'maintenance-sync.mjs');
const { maintenanceSync, familyMaintenanceBlock, familyConventionsBlock } = await import(
  pathToFileURL(join(ROOT, 'index.mjs'))
);

function freshDir(maintenanceMd) {
  const dir = mkdtempSync(join(tmpdir(), 'maintenance-sync-test-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  if (maintenanceMd !== undefined) writeFileSync(join(dir, 'MAINTENANCE.md'), maintenanceMd);
  return dir;
}

function runBin(cwd, args = []) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
}

test('familyMaintenanceBlock wraps the canonical text in its own markers', () => {
  const block = familyMaintenanceBlock();
  assert.ok(block.startsWith('<!-- jfs-family-maintenance:start'));
  assert.ok(block.endsWith('<!-- jfs-family-maintenance:end -->'));
  assert.match(block, /## Family maintenance protocol/);
  assert.match(block, /Who watches the watchers/);
  assert.match(block, /Major-bump triage/);
  assert.match(block, /Green CI is not delivered/);
});

test('the two canonical blocks cannot be confused for one another', () => {
  // Both tools rewrite "the block between two markers" in a Markdown file in
  // the same repo. If either marker pair were a substring of the other, one
  // sync would find the other's block and eat it.
  const conventions = familyConventionsBlock();
  const maintenance = familyMaintenanceBlock();
  assert.ok(!conventions.includes('jfs-family-maintenance:'));
  assert.ok(!maintenance.includes('jfs-family-conventions:'));
});

test('sync appends the block to a MAINTENANCE.md without one, then is idempotent', () => {
  const dir = freshDir('# Maintaining Some App\n\nThe repo-specific half.\n');
  maintenanceSync(dir, []);
  const first = readFileSync(join(dir, 'MAINTENANCE.md'), 'utf8');
  assert.ok(first.startsWith('# Maintaining Some App\n\nThe repo-specific half.\n\n'));
  assert.ok(first.trimEnd().endsWith('<!-- jfs-family-maintenance:end -->'));
  assert.match(first, /Who watches the watchers/);
  maintenanceSync(dir, []);
  assert.equal(readFileSync(join(dir, 'MAINTENANCE.md'), 'utf8'), first);
});

test('sync rewrites a stale block in place, preserving surrounding prose', () => {
  const stale = familyMaintenanceBlock().replace('Who watches the watchers', 'Nobody watches anything');
  const dir = freshDir(`# Repo\n\nIntro.\n\n${stale}\n\n## Run log\n\nKept.\n`);
  maintenanceSync(dir, []);
  const out = readFileSync(join(dir, 'MAINTENANCE.md'), 'utf8');
  assert.match(out, /Who watches the watchers/);
  assert.doesNotMatch(out, /Nobody watches anything/);
  assert.match(out, /## Run log\n\nKept\./);
});

test('--check passes on a synced file', () => {
  const dir = freshDir('# Repo\n');
  maintenanceSync(dir, []);
  const res = runBin(dir, ['--check']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /in sync/);
});

test('--check fails when the block is missing', () => {
  const res = runBin(freshDir('# Repo\n\nNo block here.\n'), ['--check']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no family-maintenance block/);
});

test('--check fails when the block is stale', () => {
  const dir = freshDir('# Repo\n');
  maintenanceSync(dir, []);
  const path = join(dir, 'MAINTENANCE.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('Who watches the watchers', 'Who watches nothing'));
  const res = runBin(dir, ['--check']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /out of date/);
});

test('a mangled marker fails both modes rather than rewriting around it', () => {
  const half = '# Repo\n\n<!-- jfs-family-maintenance:end -->\n';
  for (const args of [[], ['--check']]) {
    const res = runBin(freshDir(half), args);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /mangled/);
  }
});

test('an absent MAINTENANCE.md is refused, not created, in BOTH modes', () => {
  for (const args of [[], ['--check']]) {
    const dir = freshDir();
    const res = runBin(dir, args);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /no MAINTENANCE\.md/);
    assert.match(res.stderr, /repo-specific half first/);
    // The refusal must leave nothing behind: a hollow file created here would
    // pass every later --check while documenting nothing.
    assert.equal(existsSync(join(dir, 'MAINTENANCE.md')), false);
  }
});

test('the sync does not disturb a CLAUDE.md sitting beside it', () => {
  const dir = freshDir('# Repo\n\nMaintenance.\n');
  const claudeMd = join(dir, 'CLAUDE.md');
  writeFileSync(claudeMd, `# Notes\n\n${familyConventionsBlock()}\n`);
  const before = readFileSync(claudeMd, 'utf8');
  maintenanceSync(dir, []);
  assert.equal(readFileSync(claudeMd, 'utf8'), before);
});
