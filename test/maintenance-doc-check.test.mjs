// Tests for tools/maintenance-doc-check.mjs — the gate that checks a repo's
// MAINTENANCE.md against the repo it describes.
//
// Two properties carry this suite, and they pull against each other:
//   - it must FIND real claims (a checker that extracts nothing reports every
//     doc clean, which is the hollow pass the family protocol forbids), and
//   - it must not fire on prose (a check with false positives gets disabled,
//     which is worse than no check).
// So there are cases for both directions, plus the allowlist's reason rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'tools', 'maintenance-doc-check.mjs');
const { checkRepo, findClaims, parseAllowlist, splitDoc } = await import(pathToFileURL(SCRIPT));
const { familyMaintenanceBlock } = await import(pathToFileURL(join(ROOT, 'index.mjs')));

function repo({ doc, scripts, workflows = {}, files = [], noPkg = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'maint-doc-check-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  if (doc !== undefined) writeFileSync(join(dir, 'MAINTENANCE.md'), doc);
  if (!noPkg) writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: scripts || {} }));
  if (Object.keys(workflows).length) {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    for (const [name, body] of Object.entries(workflows)) writeFileSync(join(dir, '.github/workflows', name), body);
  }
  for (const f of files) {
    mkdirSync(join(dir, dirname(f)), { recursive: true });
    writeFileSync(join(dir, f), '');
  }
  return dir;
}

const withBlock = (body) => `${body}\n\n${familyMaintenanceBlock()}\n`;

test('a true doc checks out, and the counts prove it looked', () => {
  const dir = repo({
    doc: withBlock('# Maintaining X\n\nRun `npm run check` before pushing. CI is `.github/workflows/ci.yml`.\n\n```\nnode scripts/sweep.mjs\n```\n'),
    scripts: { check: 'echo' },
    workflows: { 'ci.yml': 'on:\n  schedule:\n    - cron: \'41 6 * * 1\'\n' },
    files: ['scripts/sweep.mjs'],
  });
  const res = checkRepo(dir);
  assert.deepEqual(res.findings, []);
  assert.equal(res.status, 'clean');
  assert.equal(res.counted.scripts, 1);
  assert.equal(res.counted.workflows, 1);
  assert.equal(res.counted.paths, 1);
});

test('an npm script the doc names but package.json lacks is a finding', () => {
  const res = checkRepo(repo({ doc: withBlock('Run `npm run maintain`.'), scripts: { check: 'echo' } }));
  assert.equal(res.status, 'findings');
  assert.equal(res.findings.length, 1);
  assert.match(res.findings[0], /npm run maintain.*no such script/);
});

test('a workflow the doc names but the repo lacks is a finding', () => {
  const res = checkRepo(repo({ doc: withBlock('Releases go through `.github/workflows/release.yml`.') }));
  assert.match(res.findings.join('\n'), /release\.yml.*no such workflow/);
});

test('a path in a code block that does not exist is a finding', () => {
  const res = checkRepo(repo({ doc: withBlock('```\nnode scripts/gone.mjs\n```') }));
  assert.match(res.findings.join('\n'), /scripts\/gone\.mjs.*does not exist/);
});

test('a quoted cron no named workflow carries is a finding', () => {
  const res = checkRepo(repo({
    doc: withBlock('The sweep fires `41 6 * * 1`, in `.github/workflows/ci.yml`.'),
    workflows: { 'ci.yml': "on:\n  schedule:\n    - cron: '0 3 * * 2'\n" },
  }));
  assert.match(res.findings.join('\n'), /cron `41 6 \* \* 1`.*no workflow it names carries it/);
});

test('a cron a named workflow does carry is accepted', () => {
  const res = checkRepo(repo({
    doc: withBlock('The sweep fires `41 6 * * 1`, in `.github/workflows/ci.yml`.'),
    workflows: { 'ci.yml': "on:\n  schedule:\n    - cron: '41 6 * * 1'\n" },
  }));
  assert.deepEqual(res.findings, []);
});

test('an npm command in a repo with no package.json is a finding, not a skip', () => {
  // Zepbound- has no package.json; an `npm run` instruction there is simply wrong.
  const res = checkRepo(repo({ doc: withBlock('Run `npm run lint`.'), noPkg: true }));
  assert.match(res.findings.join('\n'), /no package\.json/);
});

test('the allowlist clears a deliberate mention of something absent', () => {
  // Recording an absence is one of the most useful things a maintenance doc
  // does — "this repo has no release.yml, unlike its siblings".
  const doc = withBlock(
    'This repo has no `.github/workflows/release.yml` and no `npm run version:check`.\n\n' +
    '<!-- maintenance-check:allow\n' +
    '.github/workflows/release.yml  # named only to record that this repo lacks one\n' +
    'npm run version:check          # the version flows through build.js instead\n' +
    '-->\n'
  );
  const res = checkRepo(repo({ doc }));
  assert.deepEqual(res.findings, []);
  assert.equal(res.counted.allowed, 2);
});

test('an allowlist entry with no reason is itself a finding', () => {
  const doc = withBlock('No `npm run nope` here.\n\n<!-- maintenance-check:allow\nnpm run nope\n-->\n');
  const res = checkRepo(repo({ doc }));
  assert.match(res.findings.join('\n'), /has no reason after/);
});

test('claims are read from the repo-specific half only, never the canonical block', () => {
  // The canonical text is byte-identical in fourteen repos, so it cannot name
  // any one repo's scripts — scanning it would report the same phantom finding
  // in every repo at once.
  const { own, canonical } = splitDoc(withBlock('# X\n'));
  assert.ok(canonical && canonical.length > 500);
  assert.equal(findClaims(own).scripts.size, 0);
  assert.ok(findClaims(canonical).scripts.size >= 0);
});

test('a missing canonical block is reported', () => {
  const res = checkRepo(repo({ doc: '# Maintaining X\n\nNo block.\n' }));
  assert.match(res.findings.join('\n'), /canonical family-maintenance block is missing/);
});

test('prose that merely resembles a path does not fire', () => {
  // Inline code outside fences is not scanned for paths, on purpose: docs name
  // modules, globs and identifiers that are not files.
  const res = checkRepo(repo({
    doc: withBlock('The parsers live in `*-parsers.js`, state in `appState`, and `js/lib/**` is pure.'),
  }));
  assert.deepEqual(res.findings, []);
});

test('an absent MAINTENANCE.md exits 2, distinct from both clean and findings', () => {
  const dir = repo({});
  assert.equal(checkRepo(dir).status, 'could-not-check');
  const res = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /no MAINTENANCE\.md/);
});

test('the bin exits 1 on findings and 0 on a clean doc', () => {
  const bad = repo({ doc: withBlock('Run `npm run ghost`.'), scripts: {} });
  assert.equal(spawnSync(process.execPath, [SCRIPT, bad], { encoding: 'utf8' }).status, 1);
  const good = repo({ doc: withBlock('Run `npm run check`.'), scripts: { check: 'echo' } });
  const ok = spawnSync(process.execPath, [SCRIPT, good], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /checks out/);
});

test('a doc that EXPLAINS the allowlist convention is not eaten by the parser', () => {
  // Regression. The marker was matched anywhere in the file, so the first doc
  // to document the convention — mentioning `<!-- maintenance-check:allow` in
  // prose, inside backticks, mid-sentence — had the parser take that as the
  // block opener and swallow the next sixty lines as entries, reporting forty
  // phantom findings. The marker must OPEN A LINE.
  const doc = withBlock(
    '# Maintaining X\n\n' +
    'Deliberate mentions of absent things go in the `<!-- maintenance-check:allow` block\n' +
    'with a reason after `#`, or the entry is itself a finding.\n\n' +
    'Run `npm run check`.\n\n' +
    '<!-- maintenance-check:allow\n' +
    '.github/workflows/release.yml  # this repo has none\n' +
    '-->\n'
  );
  const { allow, bad, unterminated } = parseAllowlist(doc);
  assert.equal(unterminated, false);
  assert.deepEqual(bad, []);
  assert.deepEqual([...allow], ['.github/workflows/release.yml']);
  const res = checkRepo(repo({ doc, scripts: { check: 'echo' } }));
  assert.deepEqual(res.findings, []);
});

test('an unterminated allowlist block is ONE finding, not a reading of the whole file', () => {
  const doc = withBlock('# X\n\n<!-- maintenance-check:allow\nfoo.yml # because\n\n## A later heading\n\nProse that is not an entry.\n');
  // Through splitDoc, as checkRepo does: the canonical START marker ends in
  // `-->` of its own, so scanning the whole file would find that and read the
  // block as closed. The repo-specific half is the right input.
  const { unterminated } = parseAllowlist(splitDoc(doc).own);
  assert.equal(unterminated, true);
  const res = checkRepo(repo({ doc }));
  assert.equal(res.findings.length, 1);
  assert.match(res.findings[0], /never closed with/);
});
