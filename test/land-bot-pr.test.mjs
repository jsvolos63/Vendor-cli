// Runs the land-bot-pr action's CI and merge steps (the real scripts, read out
// of .github/actions/land-bot-pr/action.yml) against a fake `gh`, and asserts
// what they dispatch, how long they wait, and what they merge. The action is
// the one copy of these steps; kit-pin-bump.yml and BearsMockDraft's refresh
// crons call it.
//
// Why these steps exist (2026-11-02): main is branch-protected and requires
// the family-ci checks, and a PR opened with the default GITHUB_TOKEN gets no
// pull_request CI, so a bot PR carried no checks and its merge was refused.
// workflow_dispatch is the one event that token may still fire; the run it
// starts puts the required checks on the PR's head commit. A slip here
// either strands every family repo's monthly bump (dispatch the wrong file,
// never see the run) or, worse, merges a tree CI never passed, so each
// branch of the decision is pinned below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WF = parse(readFileSync(join(ROOT, '.github', 'workflows', 'kit-pin-bump.yml'), 'utf8'));
const ACTION = parse(readFileSync(join(ROOT, '.github', 'actions', 'land-bot-pr', 'action.yml'), 'utf8'));
const STEPS = ACTION.runs.steps;
const CI = STEPS.find((s) => s.id === 'ci');
const MERGE = STEPS.find((s) => s.id === 'merge');
const HEAD = 'c'.repeat(40);
const PR_URL = 'https://github.com/jsvolos63/example/pull/9';
const hasJq = spawnSync('jq', ['--version']).status === 0;

// `gh pr view` prints $FAKE_HEAD; `gh workflow run` and `gh pr merge` are
// logged; `gh api …/runs` answers with the next file of $FAKE_RUNS_DIR
// (0.json, 1.json, … — the last one repeats), passed through the --jq
// expression the script supplies, exactly as gh would.
const FAKE_GH = `#!/usr/bin/env bash
case "$1 $2" in
  "pr view")
    if printf '%s\\n' "$@" | grep -qx mergeCommit; then printf '%s\\n' "$FAKE_MERGE_SHA"; else printf '%s\\n' "$FAKE_HEAD"; fi ;;
  "workflow run") echo "dispatch $*" >> "$FAKE_LOG" ;;
  "pr merge") echo "merge $*" >> "$FAKE_LOG"; exit "\${FAKE_MERGE_EXIT:-0}" ;;
  api*)
    echo "api $2" >> "$FAKE_LOG"
    n=$(cat "$FAKE_RUNS_DIR/n" 2>/dev/null || echo 0)
    f="$FAKE_RUNS_DIR/$n.json"; [ -f "$f" ] || f=$(ls "$FAKE_RUNS_DIR"/*.json | sort -V | tail -1)
    echo $((n + 1)) > "$FAKE_RUNS_DIR/n"
    jqexpr=''; while [ $# -gt 0 ]; do [ "$1" = "--jq" ] && { jqexpr="$2"; shift; }; shift; done
    jq -r "$jqexpr" "$f" ;;
  *) echo "fake gh: unexpected: $*" >&2; exit 64 ;;
esac
`;

const FAMILY_CI = (name = 'CI') => `name: ${name}\non:\n  push:\n  pull_request:\n  workflow_dispatch:\njobs:\n  family-ci:\n    uses: jsvolos63/vendor-cli/.github/workflows/family-ci.yml@main\n`;
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const ago = (s) => new Date(Date.now() - s * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const run = (id, status, conclusion = null, created = now()) => ({ id, status, conclusion, created_at: created, html_url: `https://github.com/jsvolos63/example/actions/runs/${id}` });

function setup({ workflows = { 'ci.yml': FAMILY_CI(), 'kit-pin-bump.yml': 'on: workflow_dispatch\n' }, runs = [[]] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'land-bot-pr-'));
  mkdirSync(join(dir, 'repo', '.github', 'workflows'), { recursive: true });
  for (const [f, text] of Object.entries(workflows)) writeFileSync(join(dir, 'repo', '.github', 'workflows', f), text);
  writeFileSync(join(dir, 'gh'), FAKE_GH);
  chmodSync(join(dir, 'gh'), 0o755);
  mkdirSync(join(dir, 'runs'));
  runs.forEach((r, i) => writeFileSync(join(dir, 'runs', `${i}.json`), JSON.stringify({ workflow_runs: r })));
  return dir;
}

function exec(script, dir, env) {
  const output = join(dir, 'output');
  const r = spawnSync('bash', ['-c', script], {
    cwd: join(dir, 'repo'),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      GH_TOKEN: 'x',
      GITHUB_REPOSITORY: 'jsvolos63/example',
      GITHUB_OUTPUT: output,
      FAKE_LOG: join(dir, 'log'),
      FAKE_RUNS_DIR: join(dir, 'runs'),
      FAKE_HEAD: HEAD,
      ...env,
    },
  });
  const outputs = Object.fromEntries((existsSync(output) ? readFileSync(output, 'utf8') : '').split('\n').filter(Boolean).map((l) => l.split('=')));
  return { status: r.status, out: r.stdout + r.stderr, log: existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8') : '', outputs };
}

const ciEnv = (over = {}) => ({ PR_URL, BRANCH: 'auto/kit-pin-bump', CI_WORKFLOW: '', WAIT_MINUTES: '1', AUTO_MERGE: 'true', SOFT_FAIL: 'false', POLL_SECONDS: '0', ...over });
function runCi(setupOpts, env) {
  const dir = setup(setupOpts);
  try { return exec(CI.run, dir, ciEnv(env)); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the CI step sits between the PR and the merge, and the bump job may dispatch', () => {
  assert.equal(ACTION.runs.using, 'composite');
  assert.deepEqual(STEPS.map((s) => s.id), ['app-check', 'app', 'identity', 'cpr', 'ci', 'merge']);
  for (const s of STEPS.filter((x) => x.run)) assert.equal(s.shell, 'bash', `${s.id}: a composite run step must name its shell`);
  assert.equal(CI.if, "steps.cpr.outputs.pull-request-number != ''");
  const cpr = STEPS.find((s) => s.id === 'cpr');
  assert.equal(CI.env.BRANCH, '${{ inputs.branch }}', 'CI runs on the branch create-pull-request pushes');
  assert.equal(cpr.with.branch, CI.env.BRANCH);
  assert.equal(MERGE.env.CI_GREEN, '${{ steps.ci.outputs.green }}');
  assert.equal(MERGE.env.HEAD_SHA, '${{ steps.ci.outputs.head-sha }}');
  assert.match(MERGE.run, /gh pr merge --squash --delete-branch --match-head-commit "\$HEAD_SHA" "\$PR_URL"/);
  // The bump: the action is its last step, on its own branch, in the one job
  // that holds the write token and actions: write.
  const land = WF.jobs.bump.steps.at(-1);
  assert.equal(land.uses, 'jsvolos63/vendor-cli/.github/actions/land-bot-pr@main');
  assert.equal(land.with.branch, 'auto/kit-pin-bump');
  assert.equal(WF.permissions.actions, 'write', 'the workflow must ask for actions: write');
  assert.equal(WF.jobs.bump.permissions.actions, 'write', 'the bump job dispatches, so it needs actions: write');
  assert.equal(WF.jobs.prepare.permissions.actions, undefined, 'the untrusted job never gets it');
  assert.ok(WF.jobs.bump['timeout-minutes'] > WF.on.workflow_call.inputs['ci-wait-minutes'].default, 'the job outlives its own CI wait');
});

test('it finds the CI workflow, dispatches it on the bump branch, and waits for success on the head commit', { skip: !hasJq && 'jq not installed' }, () => {
  const r = runCi({ runs: [[], [run(7, 'queued')], [run(7, 'in_progress')], [run(7, 'completed', 'success')]] });
  assert.equal(r.status, 0, r.out);
  assert.match(r.log, /^dispatch workflow run ci\.yml --repo jsvolos63\/example --ref auto\/kit-pin-bump$/m);
  assert.equal((r.log.match(/^api /gm) || []).length, 4, 'it polled until the run completed');
  assert.match(r.log, new RegExp(`runs\\?head_sha=${HEAD}&event=workflow_dispatch`), 'runs are read for the head commit only');
  assert.deepEqual(r.outputs, { 'head-sha': HEAD, green: 'true' });
});

test('a red CI run fails the step and the PR is left open', { skip: !hasJq && 'jq not installed' }, () => {
  const r = runCi({ runs: [[run(8, 'completed', 'failure')]] });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /::error::CI \(ci\.yml\) concluded 'failure'.*actions\/runs\/8.*left open/);
  assert.equal(r.outputs.green, undefined);
  for (const conclusion of ['cancelled', 'timed_out', 'action_required', 'skipped']) {
    assert.equal(runCi({ runs: [[run(8, 'completed', conclusion)]] }).status, 1, `${conclusion} is not green`);
  }
});

test('soft-fail turns a red or unfinished run into a warning that still does not merge', { skip: !hasJq && 'jq not installed' }, () => {
  const red = runCi({ runs: [[run(8, 'completed', 'failure')]] }, { SOFT_FAIL: 'true' });
  assert.equal(red.status, 0, red.out);
  assert.match(red.out, /::warning::CI \(ci\.yml\) concluded 'failure'/);
  assert.equal(red.outputs.green, 'false');
});

test('a run that never finishes inside ci-wait-minutes is a red step, not a merge', { skip: !hasJq && 'jq not installed' }, () => {
  const r = runCi({ runs: [[run(9, 'in_progress')]] }, { WAIT_MINUTES: '0' });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /did not finish within 0 minutes \(last seen: in_progress, .*runs\/9\)/);
  const never = runCi({ runs: [[]] }, { WAIT_MINUTES: '0' });
  assert.equal(never.status, 1, never.out);
  assert.match(never.out, /did not finish within 0 minutes; /, 'no run ever appeared');
});

test('an older run on the same commit is not mistaken for this dispatch', { skip: !hasJq && 'jq not installed' }, () => {
  // A red run from an earlier attempt, created well before this dispatch,
  // must not end the wait; the new run's success decides.
  const old = run(5, 'completed', 'failure', ago(3600));
  const r = runCi({ runs: [[old], [old, run(6, 'in_progress')], [old, run(6, 'completed', 'success')]] });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.outputs.green, 'true');
});

test('with auto-merge off it dispatches (so a human finds the checks) and does not wait', () => {
  const r = runCi({ runs: [[]] }, { AUTO_MERGE: 'false' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.log, /^dispatch workflow run ci\.yml/m);
  assert.doesNotMatch(r.log, /^api /m, 'no polling');
  assert.equal(r.outputs.green, undefined);
});

test('the CI workflow is found by what it does, and an ambiguous repo is an error that names the files', () => {
  const test_ = runCi({ workflows: { 'test.yml': FAMILY_CI('Test'), 'release.yml': 'on: workflow_dispatch\njobs: {}\n' } }, { AUTO_MERGE: 'false' });
  assert.match(test_.log, /dispatch workflow run test\.yml /, 'a kit names its CI test.yml');
  const self = runCi({ workflows: { 'test.yml': 'on:\n  workflow_dispatch:\njobs:\n  family-ci:\n    uses: ./.github/workflows/family-ci.yml\n' } }, { AUTO_MERGE: 'false' });
  assert.match(self.log, /dispatch workflow run test\.yml /, "vendor-cli's own local reference counts");
  const none = runCi({ workflows: { 'ci.yml': 'on: push\njobs:\n  family-ci:\n    uses: jsvolos63/vendor-cli/.github/workflows/family-ci.yml@main\n' } });
  assert.equal(none.status, 1);
  assert.match(none.out, /found 0\. Pass ci-workflow/, 'a CI with no workflow_dispatch cannot be dispatched');
  const two = runCi({ workflows: { 'ci.yml': FAMILY_CI(), 'ci2.yml': FAMILY_CI('CI2') } });
  assert.equal(two.status, 1);
  assert.match(two.out, /found 2: .*ci\.yml .*ci2\.yml/);
  assert.equal(two.log, '', 'nothing was dispatched');
  const named = runCi({ workflows: { 'ci.yml': FAMILY_CI(), 'ci2.yml': FAMILY_CI('CI2') } }, { CI_WORKFLOW: 'ci2.yml', AUTO_MERGE: 'false' });
  assert.match(named.log, /dispatch workflow run ci2\.yml /, 'ci-workflow overrides the search');
  for (const bad of ['../ci.yml', 'ci.yml --ref main', 'ci', '$(id).yml']) {
    const r = runCi({}, { CI_WORKFLOW: bad });
    assert.equal(r.status, 1, bad);
    assert.equal(r.log, '', `${bad}: nothing was dispatched`);
  }
});

test('a head commit it cannot read stops before any dispatch', () => {
  for (const head of ['', 'HEAD', 'c'.repeat(39), 'C'.repeat(40)]) {
    const dir = setup();
    try {
      const r = exec(CI.run, dir, { ...ciEnv(), FAKE_HEAD: head });
      assert.equal(r.status, 1, JSON.stringify(head));
      assert.equal(r.log, '', `${JSON.stringify(head)}: nothing dispatched`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function runMerge(env) {
  const dir = setup();
  try {
    return exec(MERGE.run, dir, { PR_URL, SOFT_FAIL: 'false', FAKE_MERGE_SHA: 'd'.repeat(40), ...env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the merge happens only on green CI, bound to the commit CI validated', () => {
  const green = runMerge({ CI_GREEN: 'true', HEAD_SHA: HEAD });
  assert.equal(green.status, 0, green.out);
  assert.match(green.log, new RegExp(`^merge pr merge --squash --delete-branch --match-head-commit ${HEAD} ${PR_URL.replace(/[/.]/g, '\\$&')}$`, 'm'));
  assert.equal(green.outputs['merge-sha'], 'd'.repeat(40));
  assert.equal(green.outputs.merged, 'true', 'a caller reads merged, not the step outcome');
  const notGreen = runMerge({ CI_GREEN: 'false', HEAD_SHA: HEAD });
  assert.equal(notGreen.status, 0, notGreen.out);
  assert.doesNotMatch(notGreen.log, /^merge /m, 'no merge without green CI');
  assert.match(notGreen.out, /::warning::CI is not green/);
  const unset = runMerge({ CI_GREEN: '', HEAD_SHA: '' });
  assert.doesNotMatch(unset.log, /^merge /m, 'no CI result at all is not green');
  const refused = runMerge({ CI_GREEN: 'true', HEAD_SHA: HEAD, FAKE_MERGE_EXIT: '1' });
  assert.equal(refused.status, 1, 'a refused merge of a green PR still reds the run');
  assert.equal(refused.outputs.merged, undefined, 'and does not say it merged');
  assert.match(refused.out, /stuck at .*pull\/9, green/);
  const noted = runMerge({ CI_GREEN: 'true', HEAD_SHA: HEAD, FAKE_MERGE_EXIT: '1', STUCK_NOTE: 'The depth chart stops tracking the team.' });
  assert.match(noted.out, /merge it by hand or fix the blocker\. The depth chart stops tracking the team\.$/m, 'the caller says what goes stale');
});

// ------------------------------------------------------------ the family App
//
// Since 2026-11-02 GitHub refuses every merge the default token makes under
// the family branch protection (Netlify-kit #59, BearsMockDraft #236). A repo
// holding the family GitHub App's two secrets opens and merges as the App
// instead; one holding neither keeps the default token. The private key can
// mint a token for EVERY repo the App is installed on, so what the token may
// do, where the key may appear, and what happens with half a configuration
// are each pinned here.

const APP_CHECK = STEPS.find((s) => s.id === 'app-check');
const MINT = STEPS.find((s) => s.id === 'app');
const IDENTITY = STEPS.find((s) => s.id === 'identity');
const CPR = STEPS.find((s) => s.id === 'cpr');
const APP_OR_DEFAULT = '${{ steps.app.outputs.token || inputs.token }}';

// The two step conditions, evaluated the way GitHub's expression engine does
// for these shapes (string == string, boolean != boolean, &&).
function evalIf(expr, inputs) {
  const js = expr
    .replace(/inputs\.([a-z-]+)/g, (_, k) => JSON.stringify(inputs[k] ?? ''))
    .replace(/'([^']*)'/g, (_, v) => JSON.stringify(v))
    .replace(/==/g, '===')
    .replace(/!===/g, '!==');
  return Function(`"use strict"; return (${js});`)();
}

test('the App is used only when both secrets reached the action, and half a configuration fails first', () => {
  const cases = [
    { 'app-id': '', 'app-private-key': '', check: false, mint: false },
    { 'app-id': '123456', 'app-private-key': '-----BEGIN RSA PRIVATE KEY-----', check: false, mint: true },
    { 'app-id': '123456', 'app-private-key': '', check: true, mint: false },
    { 'app-id': '', 'app-private-key': '-----BEGIN RSA PRIVATE KEY-----', check: true, mint: false },
  ];
  for (const c of cases) {
    assert.equal(evalIf(APP_CHECK.if, c), c.check, `app-check for ${JSON.stringify(c)}`);
    assert.equal(evalIf(MINT.if, c), c.mint, `mint for ${JSON.stringify(c)}`);
  }
  // The refusal is a hard stop, and it names both secrets.
  assert.equal(APP_CHECK.shell, 'bash');
  const r = spawnSync('bash', ['-c', APP_CHECK.run], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^::error::.*FAMILY_BOT_APP_ID.*FAMILY_BOT_PRIVATE_KEY/m);
  assert.deepEqual(Object.keys(ACTION.inputs['app-id']), ['description', 'default']);
  assert.equal(ACTION.inputs['app-id'].default, '');
  assert.equal(ACTION.inputs['app-private-key'].default, '', 'neither input is required: a repo without the secrets keeps the default token');
});

test("the App's token reaches this repository alone, with contents and pull-requests write and nothing more", () => {
  assert.equal(MINT.uses, 'actions/create-github-app-token@v3', 'first-party: major tag, per the family pinning policy');
  assert.deepEqual(MINT.with, {
    'client-id': '${{ inputs.app-id }}',
    'private-key': '${{ inputs.app-private-key }}',
    'permission-contents': 'write',
    'permission-pull-requests': 'write',
  }, 'no owner / repositories (the token stays on this repo), no workflows permission (a .github/workflows change stays unpushable), no skip-token-revoke');
});

test('the private key appears in the mint step and nowhere else', () => {
  const where = STEPS.filter((s) => JSON.stringify(s).includes('inputs.app-private-key')).map((s) => s.id);
  assert.deepEqual(where.sort(), ['app', 'app-check'].sort());
  // app-check only tests it for emptiness, in its condition, never in a shell.
  assert.doesNotMatch(JSON.stringify({ run: APP_CHECK.run, env: APP_CHECK.env ?? {} }), /app-private-key/);
  for (const s of STEPS) {
    assert.doesNotMatch(JSON.stringify(s.env ?? {}), /app-private-key|app-id/, `${s.id} puts an App input in a shell's environment`);
  }
});

test('the identity that opens the PR merges it; the dispatch always uses the default token', () => {
  assert.equal(CPR.with.token, APP_OR_DEFAULT);
  assert.equal(MERGE.env.GH_TOKEN, APP_OR_DEFAULT);
  assert.equal(CI.env.GH_TOKEN, '${{ inputs.token }}', "the App's token is not given actions: write; the caller's job grants it to the default token");
  assert.equal(MERGE.env.IDENTITY, '${{ steps.identity.outputs.identity }}');
  assert.equal(ACTION.outputs.identity.value, '${{ steps.identity.outputs.identity }}');
});

test('the run says which identity it lands as', () => {
  const say = (env) => {
    const dir = setup();
    try { return exec(IDENTITY.run, dir, env); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  assert.deepEqual(IDENTITY.env, { MINTED: '${{ steps.app.outcome }}', APP_SLUG: '${{ steps.app.outputs.app-slug }}' });
  const app = say({ MINTED: 'success', APP_SLUG: 'jsvolos63-family-bot' });
  assert.equal(app.status, 0);
  assert.equal(app.outputs.identity, 'app');
  assert.match(app.out, /as the family App \(jsvolos63-family-bot\)/);
  for (const MINTED of ['skipped', '', 'failure']) {
    const d = say({ MINTED, APP_SLUG: '' });
    assert.equal(d.outputs.identity, 'default', `outcome '${MINTED}' is the default token`);
    assert.match(d.out, /default token/);
  }
});

test("a refused merge says whose merge it was, and soft-fail still never merges", () => {
  const asApp = runMerge({ CI_GREEN: 'true', HEAD_SHA: HEAD, FAKE_MERGE_EXIT: '1', IDENTITY: 'app' });
  assert.equal(asApp.status, 1);
  assert.match(asApp.out, /::error::.*the family App's merge was refused.*let the App merge/);
  const asDefault = runMerge({ CI_GREEN: 'true', HEAD_SHA: HEAD, FAKE_MERGE_EXIT: '1', IDENTITY: 'default' });
  assert.equal(asDefault.status, 1);
  assert.match(asDefault.out, /::error::.*no family App secrets reached the action \(FAMILY_BOT_APP_ID, FAMILY_BOT_PRIVATE_KEY\)/);
  const soft = runMerge({ CI_GREEN: 'true', HEAD_SHA: HEAD, FAKE_MERGE_EXIT: '1', IDENTITY: 'app', SOFT_FAIL: 'true' });
  assert.equal(soft.status, 0, 'soft-fail makes a refusal a warning');
  assert.match(soft.out, /^::warning::Auto-merge failed \(the family App's merge was refused/m);
  assert.equal(soft.outputs.merged, undefined);
});
