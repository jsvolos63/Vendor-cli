// Runs dependabot-merge.yml's merge step — the real script, read out of the
// workflow — against a fake `gh`, and asserts what it merges and what it leaves.
//
// The workflow is called @main by every repo in the family, so a slip in this
// shell is a family-wide change in what lands unreviewed. test/workflows.test.mjs
// proves the file's shape (inputs declared, references resolve); this proves its
// DECISIONS, the part only a run could show — and a real run needs a live
// Dependabot PR, which no session can conjure on demand.
//
// What is held, and why it matters (FAM-4 of the family security audit): a
// minor/patch bump of a direct PRODUCTION dependency is left open for a session,
// because a merge to main deploys it into the functions that hold every key and
// the suites fake the network, so a green run says nothing about what the release
// does. Development dependencies still merge on green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WF = parse(readFileSync(join(ROOT, '.github', 'workflows', 'dependabot-merge.yml'), 'utf8'));
const STEP = WF.jobs.merge.steps.find((s) => /Merge the green Dependabot PR/.test(s.name));
const SCRIPT = STEP.run;
const SHA = 'a'.repeat(40);

// The fake answers the two reads the script makes and logs the one write.
// `gh pr list … --jq '.[0]'` prints the PR object; `gh pr view … --json
// commits --jq …` prints the joined commit bodies; `gh pr merge` is recorded.
const FAKE_GH = `#!/usr/bin/env bash
case "$1 $2" in
  "pr list") printf '%s\\n' "$FAKE_PR" ;;
  "pr view") printf '%s\\n' "$FAKE_COMMIT_BODIES" ;;
  "pr merge") echo "merge $*" >> "$FAKE_LOG" ;;
  *) echo "fake gh: unexpected: $*" >&2; exit 64 ;;
esac
`;

// Dependabot's commit metadata. A grouped version update carries a
// `dependency-group:` per dependency; an ungrouped PR (a security update, in a
// family that groups every minor/patch version update) carries none.
const metaIn = (group, ...deps) => [
  group ? `Bumps the ${group} group with some updates.` : 'Bumps a dependency.',
  '',
  '---',
  'updated-dependencies:',
  ...deps.flatMap(([name, type, update = 'version-update:semver-patch']) => [
    `- dependency-name: ${name}`,
    '  dependency-version: 1.2.4',
    `  dependency-type: ${type}`,
    `  update-type: ${update}`,
    ...(group ? [`  dependency-group: ${group}`] : []),
  ]),
  '...',
  '',
  'Signed-off-by: dependabot[bot] <support@github.com>',
].join('\n');
const meta = (...deps) => metaIn('minor-and-patch', ...deps);
const ungrouped = (...deps) => metaIn(null, ...deps);

function runStep({
  branch = 'dependabot/npm_and_yarn/minor-and-patch-1a2b3c',
  author = 'app/dependabot',
  title = 'Bump the minor-and-patch group with 2 updates',
  body = 'Updates `jsdom` from 30.1.0 to 30.1.1\nUpdates `@netlify/blobs` from 11.1.0 to 11.1.1',
  commits = meta(['jsdom', 'direct:development']),
  allowMajor = false,
  holdProduction = true,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dependabot-merge-'));
  try {
    const gh = join(dir, 'gh');
    writeFileSync(gh, FAKE_GH);
    chmodSync(gh, 0o755);
    const log = join(dir, 'log');
    const summary = join(dir, 'summary');
    const r = spawnSync('bash', ['-c', SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_TOKEN: 'x',
        GITHUB_REPOSITORY: 'jsvolos63/example',
        GITHUB_STEP_SUMMARY: summary,
        HEAD_BRANCH: branch,
        HEAD_SHA: SHA,
        ALLOW_MAJOR: String(allowMajor),
        HOLD_PRODUCTION: String(holdProduction),
        FAKE_PR: JSON.stringify({ number: 77, author: { login: author }, headRefOid: SHA, title, body }),
        FAKE_COMMIT_BODIES: commits,
        FAKE_LOG: log,
      },
    });
    return {
      status: r.status,
      out: r.stdout + r.stderr,
      merged: existsSync(log) ? readFileSync(log, 'utf8') : '',
      summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the step under test is the real one, with the hold wired to its input', () => {
  assert.ok(STEP, 'merge step not found in dependabot-merge.yml');
  assert.equal(STEP.env.HOLD_PRODUCTION, '${{ inputs.hold-production }}');
  const input = WF.on.workflow_call.inputs['hold-production'];
  assert.equal(input.type, 'boolean');
  assert.equal(input.default, true, 'production dependencies must be held unless a caller opts out');
});

test('a minor/patch bump of development dependencies only is merged, bound to the validated SHA', () => {
  const r = runStep({ commits: meta(['jsdom', 'direct:development'], ['vitest', 'direct:development']) });
  assert.equal(r.status, 0, r.out);
  assert.match(r.merged, /merge pr merge --squash --delete-branch --match-head-commit a{40} /);
  assert.match(r.merged, / 77$/m);
  assert.equal(r.summary, '');
});

test('a grouped update carrying ONE direct production dependency is held whole, and says which', () => {
  const r = runStep({
    commits: meta(['"@netlify/blobs"', 'direct:production'], ['jsdom', 'direct:development']),
  });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.merged, '', 'a production bump must not merge on green CI alone');
  assert.match(r.out, /PR #77 bumps a production dependency \(@netlify\/blobs\)/);
  assert.match(r.summary, /held: production dependency/);
  assert.match(r.summary, /@netlify\/blobs/);
});

test('every production dependency in the group is named', () => {
  const r = runStep({
    commits: meta(['cheerio', 'direct:production'], ['jsdom', 'direct:development'], ['yahoo-finance2', 'direct:production']),
  });
  assert.equal(r.merged, '');
  assert.match(r.out, /\(cheerio,yahoo-finance2\)/);
});

test('an indirect (lockfile-only) bump is merged — the metadata cannot place it under production', () => {
  const r = runStep({
    title: 'Bump brace-expansion from 1.1.18 to 1.1.21',
    body: 'Bumps [brace-expansion](https://example.invalid) from 1.1.18 to 1.1.21.',
    commits: ungrouped(['brace-expansion', 'indirect']),
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.merged, /--match-head-commit/);
});

test('an npm PR with no readable Dependabot metadata is held, as an unreadable body is', () => {
  const r = runStep({ commits: 'Bump things\n\nno metadata block here' });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.merged, '');
  assert.match(r.out, /no readable Dependabot metadata/);
});

test('hold-production: false restores merging a production minor/patch bump', () => {
  const r = runStep({ holdProduction: false, commits: meta(['"@netlify/blobs"', 'direct:production']) });
  assert.equal(r.status, 0, r.out);
  assert.match(r.merged, /--match-head-commit/);
});

test('a GitHub Actions bump is not npm and is not held, whatever its dependency-type says', () => {
  // Dependabot labels an action `direct:production`; it deploys nothing.
  const r = runStep({
    branch: 'dependabot/github_actions/peter-evans/create-pull-request-8.1.2',
    title: 'Bump peter-evans/create-pull-request from 8.1.1 to 8.1.2',
    body: 'Bumps [peter-evans/create-pull-request](https://example.invalid) from 8.1.1 to 8.1.2.',
    commits: meta(['peter-evans/create-pull-request', 'direct:production']),
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.merged, /--match-head-commit/);
});

test('a major is still left open before the production question is asked', () => {
  const r = runStep({
    title: 'Bump jsdom from 30.1.1 to 31.0.0',
    body: 'Bumps [jsdom](https://example.invalid) from 30.1.1 to 31.0.0.',
    commits: meta(['jsdom', 'direct:development', 'version-update:semver-major']),
  });
  assert.equal(r.merged, '');
  assert.match(r.out, /carries a major bump/);
});

test("a person's PR on a Dependabot-named branch is left alone", () => {
  const r = runStep({ author: 'someone' });
  assert.equal(r.merged, '');
  assert.match(r.out, /not Dependabot — leaving it/);
});

test('an UNGROUPED production bump is a security update and merges on green', () => {
  // The family groups every minor/patch version update, so Dependabot opens a
  // production dependency's minor/patch outside a group only for an advisory —
  // and a published fix should not wait on a session (John's News's rule too).
  const r = runStep({
    title: 'Bump imapflow from 2.0.7 to 2.0.8',
    body: 'Bumps [imapflow](https://example.invalid) from 2.0.7 to 2.0.8.',
    commits: ungrouped(['imapflow', 'direct:production']),
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /outside any group — a security update/);
  assert.match(r.merged, /--match-head-commit/);
});

test('a production-only GROUP (a repo that splits its groups by type) is held', () => {
  const r = runStep({
    title: 'Bump the runtime group with 2 updates',
    commits: metaIn('runtime', ['imapflow', 'direct:production'], ['dotenv', 'direct:production']),
  });
  assert.equal(r.merged, '');
  assert.match(r.out, /\(dotenv,imapflow\)/);
});

test('a held major RETARGETED as a patch after a manual upgrade is still held', () => {
  // Surf-Tracker #291, 2026-10-07: the ungrouped @netlify/blobs 8 → 11 major
  // was held; a session landed 11.1.1 by hand; Dependabot rebased the same PR
  // into "from 11.1.1 to 11.1.2" with its metadata still semver-major, and the
  // title-only major check plus the ungrouped = security-update rule merged
  // a production version update no session had read.
  const r = runStep({
    branch: 'dependabot/npm_and_yarn/netlify/blobs-11.1.1',
    title: 'Bump @netlify/blobs from 11.1.1 to 11.1.2',
    body: 'Bumps [@netlify/blobs](https://example.invalid) from 11.1.1 to 11.1.2.',
    commits: ungrouped(['"@netlify/blobs"', 'direct:production', 'version-update:semver-major']),
  });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.merged, '', 'a retargeted major must not merge as a security update');
  assert.match(r.out, /carries a major bump/);
});

test('allow-major: true still merges a retargeted development major on green', () => {
  const r = runStep({
    allowMajor: true,
    branch: 'dependabot/npm_and_yarn/jsdom-31.0.0',
    title: 'Bump jsdom from 31.0.0 to 31.0.1',
    body: 'Bumps [jsdom](https://example.invalid) from 31.0.0 to 31.0.1.',
    commits: ungrouped(['jsdom', 'direct:development', 'version-update:semver-major']),
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.merged, /--match-head-commit/);
});
