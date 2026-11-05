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
  "pr merge") echo "merge $*" >> "$FAKE_LOG"; exit "\${FAKE_MERGE_EXIT:-0}" ;;
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
  env: extra = {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dependabot-merge-'));
  try {
    const gh = join(dir, 'gh');
    writeFileSync(gh, FAKE_GH);
    chmodSync(gh, 0o755);
    const log = join(dir, 'log');
    const summary = join(dir, 'summary');
    const output = join(dir, 'output');
    const r = spawnSync('bash', ['-c', SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_TOKEN: 'x',
        GITHUB_REPOSITORY: 'jsvolos63/example',
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_OUTPUT: output,
        HEAD_BRANCH: branch,
        HEAD_SHA: SHA,
        ALLOW_MAJOR: String(allowMajor),
        HOLD_PRODUCTION: String(holdProduction),
        FAKE_PR: JSON.stringify({ number: 77, author: { login: author }, headRefOid: SHA, title, body }),
        FAKE_COMMIT_BODIES: commits,
        FAKE_LOG: log,
        ...extra,
      },
    });
    return {
      status: r.status,
      out: r.stdout + r.stderr,
      merged: existsSync(log) ? readFileSync(log, 'utf8') : '',
      summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '',
      output: existsSync(output) ? readFileSync(output, 'utf8') : '',
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

// ---------- why a PR was held, for the digest step ----------

test('the merge step records why it held a PR, and records nothing when it merges', () => {
  const prod = runStep({ commits: meta(['"@netlify/blobs"', 'direct:production'], ['jsdom', 'direct:development']) });
  assert.equal(prod.output, 'held=production\nnumber=77\n');
  const major = runStep({ title: 'Bump x from 1.0.0 to 2.0.0', body: 'Bumps x from 1.0.0 to 2.0.0.', commits: ungrouped(['x', 'direct:development']) });
  assert.equal(major.output, 'held=major\nnumber=77\n');
  const unreadable = runStep({ commits: 'no metadata at all' });
  assert.equal(unreadable.output, 'held=unreadable\nnumber=77\n');
  const merged = runStep({ commits: meta(['jsdom', 'direct:development']) });
  assert.match(merged.merged, /--match-head-commit/);
  assert.equal(merged.output, '', 'a merged PR gets no digest');
});

// ---------- the review digest on a held PR ----------

const DIGEST = WF.jobs.merge.steps.find((s) => /review digest/.test(s.name || ''));

// gh answers `pr view` with $FAKE_PR_VIEW and records `pr comment` bodies;
// npm answers `npm view <spec> …` from the JSON map in $FAKE_NPM (a spec it
// lacks exits 1, like a registry miss) and logs every spec it was asked for.
const DIGEST_GH = `#!/usr/bin/env bash
case "$1 $2" in
  "pr view") printf '%s\\n' "$FAKE_PR_VIEW" ;;
  "pr comment") { echo "--- comment $3"; cat; } >> "$FAKE_LOG" ;;
  *) echo "fake gh: unexpected: $*" >&2; exit 64 ;;
esac
`;
const DIGEST_NPM = `#!/usr/bin/env node
const spec = process.argv[3];
require('fs').appendFileSync(process.env.FAKE_NPM_LOG, spec + '\\n');
const map = JSON.parse(process.env.FAKE_NPM || '{}');
if (!(spec in map)) process.exit(1);
process.stdout.write(JSON.stringify(map[spec]));
`;

const REG = {
  '@netlify/blobs@11.1.1': { version: '11.1.1', time: { '11.1.1': '2026-09-20T00:00:00.000Z' }, maintainers: ['netlify-bot <bot@example.invalid>'], scripts: {}, dependencies: { a: '^1.0.0', b: '^2.0.0' } },
  '@netlify/blobs@11.1.6': { version: '11.1.6', time: { '11.1.6': '2026-10-21T14:35:08.086Z' }, maintainers: ['netlify-bot <bot@example.invalid>', 'newcomer <new@example.invalid>'], scripts: { postinstall: 'node setup.js', test: 'vitest' }, dependencies: { a: '^1.1.0', c: '^3.0.0' } },
  'imapflow@2.1.2': { version: '2.1.2', time: { '2.9.1': '2026-10-22T16:19:21.770Z' }, maintainers: [{ name: 'andris', email: 'andris@example.invalid' }], scripts: { prepare: 'npm run build' }, dependencies: { libqp: '2.1.2' } },
  'imapflow@2.9.1': { version: '2.9.1', time: { '2.9.1': '2026-10-22T16:19:21.770Z' }, maintainers: [{ name: 'andris', email: 'andris@example.invalid' }], scripts: { prepare: 'npm run build' }, dependencies: { libqp: '3.0.1' } },
};

function runDigest({
  branch = 'dependabot/npm_and_yarn/runtime-1a2b3c',
  title = 'Bump the runtime group across 1 directory with 2 updates',
  body = 'Updates `@netlify/blobs` from 11.1.1 to 11.1.6\nUpdates `imapflow` from 2.1.2 to 2.9.1',
  comments = [],
  registry = REG,
  number = '77',
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dependabot-digest-'));
  try {
    for (const [name, text] of [['gh', DIGEST_GH], ['npm', DIGEST_NPM]]) {
      writeFileSync(join(dir, name), text);
      chmodSync(join(dir, name), 0o755);
    }
    const log = join(dir, 'log');
    const npmLog = join(dir, 'npm-log');
    const r = spawnSync('bash', ['-c', DIGEST.run], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_TOKEN: 'x',
        GITHUB_REPOSITORY: 'jsvolos63/example',
        PR_NUMBER: number,
        HELD: 'production',
        FAKE_PR_VIEW: JSON.stringify({ title, body, comments, headRefName: branch }),
        FAKE_NPM: JSON.stringify(registry),
        FAKE_LOG: log,
        FAKE_NPM_LOG: npmLog,
      },
    });
    return {
      status: r.status,
      out: r.stdout + r.stderr,
      comment: existsSync(log) ? readFileSync(log, 'utf8') : '',
      asked: existsSync(npmLog) ? readFileSync(npmLog, 'utf8').split('\n').filter(Boolean) : [],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the digest step runs only on a held PR, never fails the run, and posts with the PR token', () => {
  assert.ok(DIGEST, 'digest step not found');
  assert.equal(DIGEST.if, "steps.merge.outputs.held != ''");
  assert.equal(DIGEST['continue-on-error'], true);
  assert.equal(DIGEST.env.PR_NUMBER, '${{ steps.merge.outputs.number }}');
  assert.ok(WF.jobs.merge.steps.indexOf(DIGEST) > WF.jobs.merge.steps.indexOf(STEP), 'it runs after the merge decision');
});

test('a held grouped update gets one comment with each package\'s registry facts', () => {
  const r = runDigest();
  assert.equal(r.status, 0, r.out);
  assert.match(r.comment, /^--- comment 77$/m);
  assert.match(r.comment, /<!-- jfs-dependabot-digest: @netlify\/blobs@11\.1\.6,imapflow@2\.9\.1 -->/);
  assert.match(r.comment, /- `@netlify\/blobs` `11\.1\.1` → `11\.1\.6` · https:\/\/www\.npmjs\.com\/package\/@netlify\/blobs\/v\/11\.1\.6/);
  assert.match(r.comment, /published 2026-10-21 \(\d+ days ago\)/);
  assert.match(r.comment, /⚠ install-time scripts: postinstall `node setup\.js` \(new or changed\)/);
  assert.match(r.comment, /⚠ maintainers changed: added `newcomer`; removed none/);
  assert.match(r.comment, /dependencies: added `c`; dropped `b`; 1 range\(s\) moved/);
  assert.match(r.comment, /- `imapflow` `2\.1\.2` → `2\.9\.1`[\s\S]*no install-time scripts[\s\S]*same maintainers/,
    'prepare is not an install-time script for a registry install');
  assert.doesNotMatch(r.comment, /example\.invalid/, 'no maintainer email reaches the comment');
  // Every @scope sits inside a code span or a URL, so nothing mentions a team.
  const prose = r.comment.replace(/`[^`]*`/g, '').replace(/https:\/\/\S+/g, '').replace(/<!--[\s\S]*?-->/, '');
  assert.doesNotMatch(prose, /@\w/);
  assert.deepEqual(r.asked.sort(), ['@netlify/blobs@11.1.1', '@netlify/blobs@11.1.6', 'imapflow@2.1.2', 'imapflow@2.9.1']);
});

test('the same versions are never digested twice; new versions are', () => {
  const first = runDigest();
  const marker = /<!-- jfs-dependabot-digest: [^>]* -->/.exec(first.comment)[0];
  const again = runDigest({ comments: [{ body: `${marker}\nolder digest` }] });
  assert.equal(again.status, 0, again.out);
  assert.equal(again.comment, '', 'a rebase of the same versions posts nothing');
  assert.match(again.out, /already posted/);
  const newer = runDigest({ comments: [{ body: '<!-- jfs-dependabot-digest: @netlify/blobs@11.1.5,imapflow@2.9.1 -->' }] });
  assert.match(newer.comment, /--- comment 77/, 'a new version set gets its own digest');
});

test('a single-package update reads the name out of Dependabot\'s markdown link', () => {
  const r = runDigest({
    branch: 'dependabot/npm_and_yarn/netlify/blobs-11.1.6',
    title: 'Bump @netlify/blobs from 11.1.1 to 11.1.6',
    body: 'Bumps [@netlify/blobs](https://github.com/netlify/primitives/tree/HEAD/packages/blobs) from 11.1.1 to 11.1.6.',
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.comment, /jfs-dependabot-digest: @netlify\/blobs@11\.1\.6 -->/);
});

test('a registry miss still posts, saying what to check by hand', () => {
  const r = runDigest({ registry: {} });
  assert.equal(r.status, 0, r.out);
  assert.match(r.comment, /registry metadata unavailable: check it by hand/);
});

test('nothing but a validated name and version ever reaches npm, and no shell sees them', () => {
  const r = runDigest({
    title: 'Bump things',
    body: 'Updates `$(touch pwned)` from 1.0.0 to 1.0.1\nUpdates `x;id` from 1.0.0 to 1.0.1\nUpdates `ok-pkg` from 1.0.0 to latest',
  });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.asked, [], 'no invalid name or version was looked up');
  assert.equal(r.comment, '');
  assert.match(r.out, /no readable bumps/);
});

test('no digest for a non-npm update or a missing PR number', () => {
  assert.equal(runDigest({ branch: 'dependabot/github_actions/actions/checkout-5' }).comment, '');
  const none = runDigest({ number: '' });
  assert.equal(none.status, 0, none.out);
  assert.equal(none.comment, '');
});

// ------------------------------------------------------------ the family App
//
// Since 2026-11-02 GitHub refuses every merge the default token makes under
// the family branch protection. Where the repo holds the family GitHub App's
// two secrets the merge is made as the App, with the same token land-bot-pr
// mints. The private key can mint a token for every repo the App is
// installed on, so where it may appear and what the token may do are pinned.

const JOB = WF.jobs.merge;
const APP_CHECK = JOB.steps.find((s) => /half-configured family App/.test(s.name || ''));
const MINT = JOB.steps.find((s) => s.id === 'app');
const LAND = parse(readFileSync(join(ROOT, '.github', 'actions', 'land-bot-pr', 'action.yml'), 'utf8'));
const LAND_MINT = LAND.runs.steps.find((s) => s.id === 'app');

// The step conditions, evaluated as GitHub does for these shapes: the job env
// holds 'true' / 'false' strings, compared as strings.
const evalIf = (expr, env) => Function('env', `"use strict"; return (${expr.replace(/==/g, '===').replace(/!===/g, '!==').replace(/'([^']*)'/g, (_, v) => JSON.stringify(v))});`)(env);

test("the family App's secrets are optional, and only their presence reaches a condition", () => {
  const secrets = WF.on.workflow_call.secrets;
  assert.deepEqual(Object.keys(secrets).sort(), ['FAMILY_BOT_APP_ID', 'FAMILY_BOT_PRIVATE_KEY']);
  for (const [name, sec] of Object.entries(secrets)) assert.equal(sec.required, false, `${name} must be optional`);
  assert.deepEqual(JOB.env, {
    FAMILY_APP_ID_SET: "${{ secrets.FAMILY_BOT_APP_ID != '' }}",
    FAMILY_APP_KEY_SET: "${{ secrets.FAMILY_BOT_PRIVATE_KEY != '' }}",
  }, 'the job env carries whether each secret is set, never its value');
  const cases = [
    { id: 'false', key: 'false', check: false, mint: false },
    { id: 'true', key: 'true', check: false, mint: true },
    { id: 'true', key: 'false', check: true, mint: false },
    { id: 'false', key: 'true', check: true, mint: false },
  ];
  for (const c of cases) {
    const env = { FAMILY_APP_ID_SET: c.id, FAMILY_APP_KEY_SET: c.key };
    assert.equal(evalIf(APP_CHECK.if, env), c.check, `half-config guard for ${JSON.stringify(env)}`);
    assert.equal(evalIf(MINT.if, env), c.mint, `mint for ${JSON.stringify(env)}`);
  }
  const r = spawnSync('bash', ['-c', APP_CHECK.run], { encoding: 'utf8' });
  assert.equal(r.status, 1, 'half a configuration fails the job');
  assert.match(r.stdout, /^::error::.*FAMILY_BOT_APP_ID.*FAMILY_BOT_PRIVATE_KEY/m);
  const order = JOB.steps.map((s) => s.id || s.name);
  assert.ok(order.indexOf(APP_CHECK.id || APP_CHECK.name) < order.indexOf('app') && order.indexOf('app') < order.indexOf('merge'), 'guard, then mint, then merge');
});

test("the merge's token is land-bot-pr's token: this repo only, contents and pull-requests write, nothing more", () => {
  assert.equal(MINT.uses, LAND_MINT.uses);
  assert.equal(MINT.uses, 'actions/create-github-app-token@v3');
  const normalise = (w) => JSON.stringify(w)
    .replace('${{ secrets.FAMILY_BOT_APP_ID }}', 'ID').replace('${{ inputs.app-id }}', 'ID')
    .replace('${{ secrets.FAMILY_BOT_PRIVATE_KEY }}', 'KEY').replace('${{ inputs.app-private-key }}', 'KEY');
  assert.equal(normalise(MINT.with), normalise(LAND_MINT.with), 'the two mints must ask for the same token');
  assert.deepEqual(Object.keys(MINT.with).sort(), ['client-id', 'permission-contents', 'permission-pull-requests', 'private-key']);
});

test('the key reaches the mint step and nothing else, in a job that runs nothing from the repository', () => {
  const naming = JOB.steps.filter((s) => /secrets\.FAMILY_BOT_PRIVATE_KEY/.test(JSON.stringify(s))).map((s) => s.id);
  assert.deepEqual(naming, ['app']);
  for (const s of JOB.steps) {
    assert.doesNotMatch(JSON.stringify(s.env ?? {}), /secrets\./, `"${s.name}" puts a secret in a shell's environment`);
    assert.ok(!s.uses || s.uses === 'actions/create-github-app-token@v3', `"${s.name}" uses ${s.uses}: this job runs no other action`);
    assert.doesNotMatch(String(s.run ?? ''), /\bnpm (ci|install|i|run|exec|test)\b|\bnpx\b|actions\/checkout/, `"${s.name}" runs code from the repository`);
  }
  assert.equal(STEP.env.GH_TOKEN, '${{ steps.app.outputs.token || github.token }}', 'the merge uses the App when it was minted');
  assert.equal(STEP.env.IDENTITY, "${{ steps.app.outcome == 'success' && 'app' || 'default' }}");
  assert.equal(DIGEST.env.GH_TOKEN, '${{ github.token }}', 'the digest comment keeps the default token');
});

test('the merge says which identity made it, and a refusal says why', () => {
  const asApp = runStep({ commits: meta(['jsdom', 'direct:development']), env: { IDENTITY: 'app' } });
  assert.equal(asApp.status, 0, asApp.out);
  assert.match(asApp.out, /^Merged Dependabot PR #77\nMerged as the family App\.$/m);
  const asDefault = runStep({ commits: meta(['jsdom', 'direct:development']), env: { IDENTITY: 'default' } });
  assert.match(asDefault.out, /Merged with the default token: no family App secrets reached this workflow\./);
  const refusedApp = runStep({ commits: meta(['jsdom', 'direct:development']), env: { IDENTITY: 'app', FAKE_MERGE_EXIT: '1' } });
  assert.equal(refusedApp.status, 1);
  assert.match(refusedApp.out, /::error::The family App's merge of Dependabot PR #77 was refused/);
  assert.doesNotMatch(refusedApp.out, /^Merged/m);
  const refusedDefault = runStep({ commits: meta(['jsdom', 'direct:development']), env: { IDENTITY: 'default', FAKE_MERGE_EXIT: '1' } });
  assert.equal(refusedDefault.status, 1);
  assert.match(refusedDefault.out, /::error::.*no family App secrets reached this workflow.*FAMILY_BOT_APP_ID and FAMILY_BOT_PRIVATE_KEY/);
});

test("this repo's own caller passes the two secrets by name", () => {
  const self = parse(readFileSync(join(ROOT, '.github', 'workflows', 'dependabot-merge-self.yml'), 'utf8'));
  assert.deepEqual(self.jobs.merge.secrets, {
    FAMILY_BOT_APP_ID: '${{ secrets.FAMILY_BOT_APP_ID }}',
    FAMILY_BOT_PRIVATE_KEY: '${{ secrets.FAMILY_BOT_PRIVATE_KEY }}',
  });
});
