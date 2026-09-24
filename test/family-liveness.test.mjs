// Tests for tools/family-liveness.mjs — the family automation liveness check.
//
// Only the pure decision logic is exercised here: the script reads fourteen
// repos over the network, so the suite tests what DECIDES, not what fetches.
// The three properties below are the ones that, had they held, would have
// caught the five-week silent kit-pin outage of September 2026, so each is a
// regression test for a real failure rather than for the code's shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'tools', 'family-liveness.mjs');
const {
  newestScheduledPerWorkflow, parseKitPins, renderMarkdown, redOnDefaultBranch, pullHealth, isRed, autoBranchNames,
  workflowInventory, judgedWorkflows, isHeldLabel, recordsPull, triageBotPulls, heldAcross, HOLD_LABEL,
} =
  await import(pathToFileURL(SCRIPT));

const run = (path, name, started, conclusion, status = 'completed') => ({
  path: `.github/workflows/${path}`,
  name,
  status,
  conclusion,
  run_started_at: started,
  html_url: `https://example.invalid/${path}/${started}`,
});

test('the newest scheduled run is taken PER WORKFLOW, not per repo', () => {
  // The outage's exact shape: a repo whose CI and release runs are green while
  // one cron has failed every week for a month. A repo-level "latest run"
  // reports that repo healthy.
  const rows = newestScheduledPerWorkflow(
    [
      run('kit-pin-bump.yml', 'Kit pin bump', '2026-09-21T07:06:48Z', 'failure'),
      run('kit-pin-bump.yml', 'Kit pin bump', '2026-08-17T07:37:44Z', 'success'),
      run('smoke.yml', 'Smoke', '2026-09-22T11:00:00Z', 'success'),
    ],
    Date.parse('2026-09-22T12:00:00Z')
  );
  const byWorkflow = Object.fromEntries(rows.map((r) => [r.workflow, r]));
  assert.deepEqual(Object.keys(byWorkflow).sort(), ['kit-pin-bump.yml', 'smoke.yml']);
  assert.equal(byWorkflow['kit-pin-bump.yml'].conclusion, 'failure');
  assert.equal(byWorkflow['smoke.yml'].conclusion, 'success');
  // And the age is what turns "it failed" into "it has been failing for weeks".
  assert.ok(byWorkflow['kit-pin-bump.yml'].ageDays > 1);
  assert.ok(byWorkflow['smoke.yml'].ageDays < 1);
});

test('an in-progress run never masks the completed one behind it', () => {
  // Taking a queued/in-progress run as newest would hide the failure that is
  // the whole signal, and it has no conclusion to report.
  const rows = newestScheduledPerWorkflow(
    [
      run('kit-pin-bump.yml', 'Kit pin bump', '2026-09-28T07:00:00Z', null, 'in_progress'),
      run('kit-pin-bump.yml', 'Kit pin bump', '2026-09-21T07:06:48Z', 'failure'),
    ],
    Date.parse('2026-09-28T07:01:00Z')
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].conclusion, 'failure');
});

test('no scheduled runs at all is an empty list, not an error', () => {
  assert.deepEqual(newestScheduledPerWorkflow([]), []);
  assert.deepEqual(newestScheduledPerWorkflow(undefined), []);
});

test('kit pins are read from dependencies AND devDependencies', () => {
  // A kit pins vendor-cli in `dependencies` (its vendor shim resolves the CLI
  // from inside the package); an app pins every kit in `devDependencies`.
  // Scanning one block is how a pin goes unwatched — which is what happened.
  const pins = parseKitPins({
    dependencies: { '@jfs/vendor-cli': 'github:jsvolos63/vendor-cli#276274b63dea9e88d36e70f7e77bc49e6e97e96b' },
    devDependencies: {
      '@jfs/news-kit': 'news-kit#1d8e9fc5285aceb2b25541001d2294666f163bd5',
      '@jfs/pwa-kit': 'github:jsvolos63/pwa-kit#78a7420d81944256a920a452eb1c77c4dfad3da6',
      eslint: '^10.9.1',
    },
  });
  assert.deepEqual(pins, {
    'vendor-cli': '276274b63dea9e88d36e70f7e77bc49e6e97e96b',
    'news-kit': '1d8e9fc5285aceb2b25541001d2294666f163bd5',
    'pwa-kit': '78a7420d81944256a920a452eb1c77c4dfad3da6',
  });
});

test('a pin with no resolvable SHA is omitted rather than guessed at', () => {
  assert.deepEqual(parseKitPins({ devDependencies: { '@jfs/news-kit': 'github:jsvolos63/news-kit' } }), {});
  assert.deepEqual(parseKitPins({ devDependencies: { '@jfs/news-kit': 'news-kit#main' } }), {});
  assert.deepEqual(parseKitPins({}), {});
});

test('only branches UNDER auto/ count, though the API matches the bare prefix', () => {
  assert.deepEqual(
    autoBranchNames([
      { ref: 'refs/heads/auto/kit-pin-bump' },
      { ref: 'refs/heads/auto/refresh-schedule' },
      { ref: 'refs/heads/automation-notes' },
      { ref: 'refs/heads/auto' },
    ]),
    ['auto/kit-pin-bump', 'auto/refresh-schedule']
  );
  assert.deepEqual(autoBranchNames(null), []);
});

test('the markdown report never presents could-not-check as a clean bill of health', () => {
  const md = renderMarkdown(
    'could-not-check',
    [],
    ['pwa-kit: /repos/x: HTTP 403'],
    [{ repo: 'pwa-kit', kind: 'kit', scheduled: [], stranded: [], stalePulls: [], stalePins: [], unchecked: ['x'] }]
  );
  assert.match(md, /Could not check/);
  assert.match(md, /not a clean bill of health/);
  assert.doesNotMatch(md, /Every repo's last scheduled run succeeded/);
});

test('a healthy report says so and lists no findings', () => {
  const md = renderMarkdown('healthy', [], [], [
    { repo: 'Weather', kind: 'app', scheduled: [{ workflow: 'kit-pin-bump.yml', conclusion: 'success', ageDays: 1 }], stranded: [], stalePulls: [], stalePins: [] },
  ]);
  assert.match(md, /Every repo's last scheduled run succeeded/);
  assert.doesNotMatch(md, /Could not check/);
  assert.match(md, /kit-pin-bump ✓/);
});

test('a stranded branch and a behind pin both reach the report body', () => {
  const md = renderMarkdown(
    'needs-attention',
    ['pwa-kit: branch `auto/kit-pin-bump` has been pushed with no open pull request'],
    [],
    [{ repo: 'pwa-kit', kind: 'kit', scheduled: [{ workflow: 'kit-pin-bump.yml', conclusion: 'failure', ageDays: 7 }], stranded: ['auto/kit-pin-bump'], stalePulls: [], stalePins: [{ kit: 'vendor-cli', sha: '276274b', behind: 8 }] }]
  );
  assert.match(md, /1 finding\b/);
  assert.match(md, /auto\/kit-pin-bump/);
  assert.match(md, /vendor-cli −8/);
  assert.match(md, /✗ failure/);
});

test('with no token the script exits 2 — never 0 — and says why', () => {
  // The load-bearing case. An unconfigured monitor reporting success is the one
  // failure mode that makes this worse than having no monitor at all.
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, FAMILY_READ_TOKEN: '', GH_TOKEN: '' },
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /COULD NOT CHECK|no FAMILY_READ_TOKEN/);
  assert.match(res.stderr, /must never read as a\s*\n?\s*healthy family|healthy family/);
});

test('--json with no token is machine-readably could-not-check, and still exits 2', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, FAMILY_READ_TOKEN: '', GH_TOKEN: '' },
  });
  assert.equal(res.status, 2);
  assert.deepEqual(JSON.parse(res.stdout), { status: 'could-not-check', reason: 'no token' });
});

// ---------------------------------------------------------------------------
// The default branch and the open bot PRs — where a canonical-text edit in
// THIS repo shows up first. Merging a change to family/family-conventions.md
// reddens every consumer's next push and PR run at once (it has happened
// twice, thirteen repos the second time), and none of that is a scheduled run.

const branchRun = (path, event, started, conclusion, status = 'completed') => ({
  ...run(path, path, started, conclusion, status),
  event,
});

test('a red push run on the default branch is reported, and a later green run clears it', () => {
  const now = Date.parse('2026-09-22T12:00:00Z');
  const red = redOnDefaultBranch([branchRun('ci.yml', 'push', '2026-09-22T10:00:00Z', 'failure')], now);
  assert.equal(red.length, 1);
  assert.equal(red[0].workflow, 'ci.yml');
  assert.equal(red[0].event, 'push');
  // A dispatch that went green afterwards is the branch being green NOW.
  assert.deepEqual(
    redOnDefaultBranch(
      [
        branchRun('ci.yml', 'push', '2026-09-22T10:00:00Z', 'failure'),
        branchRun('ci.yml', 'workflow_dispatch', '2026-09-22T11:00:00Z', 'success'),
      ],
      now
    ),
    []
  );
});

test('a red dispatch is cleared by a later green SCHEDULED run of the same workflow', () => {
  // news-kit, measured: a kit-pin-bump dispatch that failed 36 days ago, with
  // every scheduled run since green. Ignoring scheduled runs here reported it
  // "red on main" for ever.
  assert.deepEqual(
    redOnDefaultBranch([
      branchRun('kit-pin-bump.yml', 'workflow_dispatch', '2026-08-17T10:00:00Z', 'failure'),
      branchRun('kit-pin-bump.yml', 'schedule', '2026-09-21T06:41:00Z', 'success'),
    ]),
    []
  );
});

test('a retired workflow is judged by neither view', () => {
  // BearsMockDraft, measured: refresh-news.yml's last scheduled run failed and
  // then the file was deleted; it was reported every week, 98 days on.
  const existing = new Set(['.github/workflows/ci.yml']);
  const retired = run('refresh-news.yml', 'Refresh news', '2026-06-16T09:00:00Z', 'failure');
  assert.equal(newestScheduledPerWorkflow([retired], Date.parse('2026-09-22T12:00:00Z'), existing).length, 0);
  assert.equal(newestScheduledPerWorkflow([retired], Date.parse('2026-09-22T12:00:00Z')).length, 1);
  assert.deepEqual(redOnDefaultBranch([{ ...retired, event: 'workflow_dispatch' }], undefined, existing), []);
});

test('the inventory knows which workflows exist and which GitHub disabled for inactivity', () => {
  const inv = workflowInventory([
    { path: '.github/workflows/ci.yml', state: 'active' },
    { path: '.github/workflows/refresh-schedule.yml', state: 'disabled_inactivity' },
    { path: 'dynamic/dependabot/dependabot-updates', state: 'active' },
  ]);
  assert.deepEqual([...inv.existing].sort(), [
    '.github/workflows/ci.yml',
    '.github/workflows/refresh-schedule.yml',
    'dynamic/dependabot/dependabot-updates',
  ]);
  assert.deepEqual(inv.disabled, ['refresh-schedule.yml']);
  assert.deepEqual(workflowInventory(undefined), { existing: new Set(), disabled: [] });
});

test('the monitor never judges its own workflow, and nothing else is dropped', () => {
  // Its run goes red whenever it has a finding; judging that run would latch
  // the monitor red for ever after its first bad Monday.
  const paths = ['.github/workflows/test.yml', '.github/workflows/family-liveness.yml'];
  assert.deepEqual([...judgedWorkflows('vendor-cli', new Set(paths))], ['.github/workflows/test.yml']);
  assert.deepEqual([...judgedWorkflows('Vendor-cli', new Set(paths))], ['.github/workflows/test.yml']);
  // Only in the hub: a same-named file anywhere else is that repo's automation.
  assert.deepEqual([...judgedWorkflows('Weather', new Set(paths))], paths);
  // A copy, not the inventory itself.
  const inv = new Set(paths);
  judgedWorkflows('vendor-cli', inv);
  assert.equal(inv.size, 2);
});

test('the default-branch view ignores what it must not judge', () => {
  const runs = [
    // question 1's own half, reported there
    branchRun('kit-pin-bump.yml', 'schedule', '2026-09-22T07:00:00Z', 'failure'),
    // a fork's PR from a branch that happens to be named main
    branchRun('ci.yml', 'pull_request', '2026-09-22T07:00:00Z', 'failure'),
    // Dependabot's own machinery, not the repo's automation
    { ...branchRun('x', 'dynamic', '2026-09-22T07:00:00Z', 'failure'), path: 'dynamic/dependabot/dependabot-updates' },
    // skipped and cancelled are by design in the family's callers
    branchRun('release.yml', 'workflow_run', '2026-09-22T07:00:00Z', 'skipped'),
    branchRun('deploy.yml', 'push', '2026-09-22T07:00:00Z', 'cancelled'),
    // an in-progress run neither reports nor masks
    branchRun('test.yml', 'push', '2026-09-22T08:00:00Z', null, 'in_progress'),
    branchRun('test.yml', 'push', '2026-09-22T07:00:00Z', 'success'),
  ];
  assert.deepEqual(redOnDefaultBranch(runs), []);
  assert.equal(isRed('timed_out'), true);
  assert.equal(isRed('startup_failure'), true);
  assert.equal(isRed('cancelled'), false);
});

test('an open PR is red when its newest run of any workflow failed, and conflicted only when GitHub says dirty', () => {
  const headRun = (path, name, started, conclusion, status = 'completed') => ({
    path: `.github/workflows/${path}`, name, run_started_at: started, status, conclusion,
  });
  const runs = [
    headRun('ci.yml', 'CI', '2026-09-22T10:00:00Z', 'failure'),
    headRun('ci.yml', 'CI', '2026-09-22T09:00:00Z', 'success'),
    headRun('dependabot-merge.yml', 'Dependabot merge', '2026-09-22T10:05:00Z', 'skipped'),
    headRun('other.yml', 'Still running', '2026-09-22T10:06:00Z', null, 'in_progress'),
  ];
  assert.deepEqual(pullHealth({ mergeable_state: 'clean' }, runs), { red: ['CI'], conflicted: false });
  // A later green run of the SAME workflow (a re-run, a dispatch) clears it.
  assert.deepEqual(
    pullHealth({ mergeable_state: 'clean' }, [...runs, headRun('ci.yml', 'CI', '2026-09-22T11:00:00Z', 'success')]),
    { red: [], conflicted: false }
  );
  assert.deepEqual(pullHealth({ mergeable_state: 'dirty' }, []), { red: [], conflicted: true });
  // GitHub computes mergeability lazily; `unknown` is not a conflict.
  assert.deepEqual(pullHealth({ mergeable_state: 'unknown' }, [headRun('ci.yml', 'CI', '2026-09-22T10:00:00Z', 'success')]), {
    red: [],
    conflicted: false,
  });
});

test('the report carries the default-branch and bot-PR columns, and tolerates rows without them', () => {
  const md = renderMarkdown('needs-attention', ['x'], [], [
    {
      repo: 'Weather', kind: 'app', scheduled: [], stranded: [], stalePulls: [], stalePins: [],
      redOnMain: [{ workflow: 'ci.yml', event: 'push', conclusion: 'failure', ageDays: 0 }],
      badPulls: [{ number: 154, red: ['family-ci / checks'], conflicted: true }],
    },
    { repo: 'pwa-kit', kind: 'kit', scheduled: [], stranded: [], stalePulls: [], stalePins: [] },
  ]);
  assert.match(md, /red on default branch/);
  assert.match(md, /ci ✗ failure/);
  assert.match(md, /#154 red\+conflicted/);
  assert.match(md, /\| pwa-kit \| _none_ \| — \|/);
});

// End to end: the real script, its real main(), a stubbed GitHub API. The pure
// tests above prove what decides; these prove the decisions reach the exit
// code — and that could-not-check still outranks a finding.
const STUB = `
import { appendFileSync } from 'node:fs';
const sha = 'a'.repeat(40);
const over = JSON.parse(process.env.LIVENESS_STUB || '{}');
globalThis.fetch = async (url) => {
  const u = new URL(url);
  const key = u.pathname + u.search;
  if (process.env.LIVENESS_LOG) appendFileSync(process.env.LIVENESS_LOG, key + '\\n');
  for (const [prefix, r] of Object.entries(over)) {
    if (key.startsWith(prefix)) {
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
    }
  }
  const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
  const p = u.pathname;
  if (/\\/actions\\/runs$/.test(p)) return ok({ workflow_runs: [] });
  if (/\\/actions\\/workflows$/.test(p)) {
    return ok({ workflows: ['ci.yml', 'kit-pin-bump.yml', 'test.yml'].map((f) => ({ path: '.github/workflows/' + f, state: 'active' })) });
  }
  if (/\\/git\\/matching-refs\\//.test(p)) return ok([]);
  if (/\\/pulls$/.test(p)) return ok([]);
  if (/\\/contents\\/package\\.json$/.test(p)) return new Response('{}', { status: 404 });
  if (/\\/branches\\//.test(p)) return ok({ commit: { sha } });
  if (/^\\/repos\\/[^/]+\\/[^/]+$/.test(p)) return ok({ default_branch: 'main' });
  return new Response('{}', { status: 500 });
};
`;

/** Runs the real script against the stub. `requests` is every API path+query
 *  it asked for, in order — what the budget tests read. */
function runStubbed(overrides, args = ['--json']) {
  const dir = mkdtempSync(join(tmpdir(), 'liveness-stub-'));
  try {
    const stub = join(dir, 'stub.mjs');
    const log = join(dir, 'requests.log');
    writeFileSync(stub, STUB);
    const res = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env, FAMILY_READ_TOKEN: 'stub', GH_TOKEN: '', LIVENESS_STUB: JSON.stringify(overrides),
        LIVENESS_LOG: log,
      },
    });
    res.requests = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    return res;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RED_MAIN = {
  '/repos/jsvolos63/Weather/actions/runs?branch=main&event=push': {
    body: { workflow_runs: [{ ...branchRun('ci.yml', 'push', '2026-09-22T10:00:00Z', 'failure') }] },
  },
};

test('end to end: a quiet family exits 0', () => {
  const res = runStubbed({});
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).status, 'healthy');
});

test('end to end: a consumer red on its default branch exits 1 and names the workflow', () => {
  const res = runStubbed(RED_MAIN);
  assert.equal(res.status, 1, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'needs-attention');
  assert.ok(out.findings.some((f) => /^Weather: `ci\.yml` is red on main/.test(f)), out.findings.join('\n'));
});

test('end to end: a red bot PR exits 1 even when it is a day old', () => {
  const res = runStubbed({
    '/repos/jsvolos63/Weather/pulls?': {
      body: [{
        number: 154, title: 'Bump jsdom', head: { ref: 'dependabot/npm_and_yarn/jsdom-30', sha: 'b'.repeat(40) },
        user: { login: 'dependabot[bot]', type: 'Bot' }, created_at: new Date(Date.now() - 86_400_000).toISOString(),
        html_url: 'https://example.invalid/154',
      }],
    },
    '/repos/jsvolos63/Weather/pulls/154': { body: { mergeable_state: 'clean' } },
    // The check-runs endpoint needs the Checks permission, which the
    // documented token scope does not grant: reading it would turn this repo
    // into could-not-check (exit 2) instead of reporting the red PR.
    '/repos/jsvolos63/Weather/commits/': { status: 403 },
    '/repos/jsvolos63/Weather/actions/runs?head_sha=': {
      body: { workflow_runs: [{ ...branchRun('ci.yml', 'pull_request', '2026-09-22T10:00:00Z', 'failure'), name: 'CI' }] },
    },
  });
  assert.equal(res.status, 1, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.ok(out.findings.some((f) => /bot PR #154 .* is red \(CI\)/.test(f)), out.findings.join('\n'));
});

test('end to end: a stranded auto/ branch is found, and a look-alike branch is not', () => {
  const res = runStubbed({
    '/repos/jsvolos63/pwa-kit/git/matching-refs/heads/auto': {
      body: [{ ref: 'refs/heads/auto/kit-pin-bump' }, { ref: 'refs/heads/automation-notes' }],
    },
  });
  assert.equal(res.status, 1, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.findings.filter((f) => f.startsWith('pwa-kit:')).length, 1, out.findings.join('\n'));
  assert.match(out.findings.find((f) => f.startsWith('pwa-kit:')), /`auto\/kit-pin-bump` has been pushed with no open pull request/);
});

test('end to end: a workflow GitHub disabled for inactivity is a finding', () => {
  const res = runStubbed({
    '/repos/jsvolos63/Zepbound-/actions/workflows': {
      body: { workflows: [{ path: '.github/workflows/zepbound-reminder.yml', state: 'disabled_inactivity' }] },
    },
  });
  assert.equal(res.status, 1, res.stderr);
  assert.ok(JSON.parse(res.stdout).findings.some((f) => /^Zepbound-: `zepbound-reminder\.yml` has been DISABLED/.test(f)));
});

test('end to end: a workflow red on its schedule AND its latest dispatch is reported once', () => {
  const failed = (event, started) => branchRun('kit-pin-bump.yml', event, started, 'failure');
  const res = runStubbed({
    '/repos/jsvolos63/pwa-kit/actions/runs?event=schedule': { body: { workflow_runs: [failed('schedule', '2026-09-21T06:41:00Z')] } },
    '/repos/jsvolos63/pwa-kit/actions/runs?branch=main&event=workflow_dispatch': {
      body: { workflow_runs: [failed('workflow_dispatch', '2026-09-22T21:53:00Z')] },
    },
  });
  assert.equal(res.status, 1, res.stderr);
  const lines = JSON.parse(res.stdout).findings.filter((f) => f.startsWith('pwa-kit:'));
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /scheduled `kit-pin-bump\.yml`/);
});

test('end to end: a red dispatch that a later green scheduled run superseded is not reported', () => {
  // The scheduled list is fetched once and handed to BOTH views; the
  // default-branch view needs it to know the branch is green NOW.
  const res = runStubbed({
    '/repos/jsvolos63/news-kit/actions/runs?event=schedule': {
      body: { workflow_runs: [branchRun('kit-pin-bump.yml', 'schedule', '2026-09-21T06:41:00Z', 'success')] },
    },
    '/repos/jsvolos63/news-kit/actions/runs?branch=main&event=workflow_dispatch': {
      body: { workflow_runs: [branchRun('kit-pin-bump.yml', 'workflow_dispatch', '2026-08-17T10:00:00Z', 'failure')] },
    },
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(JSON.parse(res.stdout).status, 'healthy');
});

test('end to end: red runs of the monitor itself are not a finding, so it cannot latch itself red', () => {
  // family-liveness.yml fails its run on every finding and every could-not-check
  // (run 35789279594 did, before FAMILY_READ_TOKEN existed). A family that is
  // otherwise healthy must still read healthy.
  const own = (event, started, path = 'family-liveness.yml') => ({
    ...branchRun(path, event, started, 'failure'), name: 'Family liveness',
  });
  const vendorCli = (path) => ({
    '/repos/jsvolos63/vendor-cli/actions/workflows': {
      body: { workflows: ['test.yml', 'family-liveness.yml'].map((f) => ({ path: '.github/workflows/' + f, state: 'active' })) },
    },
    '/repos/jsvolos63/vendor-cli/actions/runs?event=schedule': {
      body: { workflow_runs: [own('schedule', '2026-09-21T08:10:00Z', path)] },
    },
    '/repos/jsvolos63/vendor-cli/actions/runs?branch=main&event=workflow_dispatch': {
      body: { workflow_runs: [own('workflow_dispatch', '2026-09-22T21:53:00Z', path)] },
    },
  });
  const res = runStubbed(vendorCli('family-liveness.yml'));
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(JSON.parse(res.stdout).status, 'healthy');
  // The control: the same red runs on vendor-cli's CI are still findings.
  const ctl = runStubbed(vendorCli('test.yml'));
  assert.equal(ctl.status, 1, ctl.stdout + ctl.stderr);
  assert.ok(JSON.parse(ctl.stdout).findings.some((f) => /^vendor-cli: scheduled `test\.yml`/.test(f)));
});

test('end to end: could-not-check on the new endpoints still outranks a finding — exit 2, never 1 or 0', () => {
  const res = runStubbed({
    ...RED_MAIN,
    '/repos/jsvolos63/John-s-News/actions/runs?branch=main&event=push': { status: 500 },
  });
  assert.equal(res.status, 2, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'could-not-check');
  assert.ok(out.findings.length >= 1, 'the Weather finding should still be reported alongside');
  assert.ok(out.unchecked.some((u) => u.startsWith('John-s-News:')), out.unchecked.join('\n'));
});

// ---------------------------------------------------------------------------
// A bot PR held ON PURPOSE. Some are: a major the triage said to hold, with
// the decision and its lifting condition in the repo's MAINTENANCE.md
// (Surf-Tracker #256, @extractus/article-extractor 9.x, red by design; #273,
// @netlify/blobs 11). Reported every Monday, they would keep the run red for
// ever. The label `hold` lists such a PR as held instead — but only when
// MAINTENANCE.md names it, so a label can never mute a PR by itself.

test('the hold label is the whole name, in any case, and nothing else', () => {
  assert.equal(HOLD_LABEL, 'hold');
  assert.equal(isHeldLabel(['hold']), true);
  assert.equal(isHeldLabel(['dependencies', 'Hold']), true);
  assert.equal(isHeldLabel([{ name: 'HOLD' }]), true);
  assert.equal(isHeldLabel(['on hold']), false);
  assert.equal(isHeldLabel(['holding', 'hold-off']), false);
  assert.equal(isHeldLabel([]), false);
  assert.equal(isHeldLabel(undefined), false);
});

test('a PR is recorded only by its exact number, in the repo-specific half', () => {
  const doc = [
    '# Maintaining Surf-Tracker', '',
    '| **`@netlify/blobs`** (Dependabot #273) | 8.2.0 → 11.1.0 | **HOLD** |',
    'Dependabot keeps #256 open meanwhile.',
    'Upstream: pwa-kit#28 and &#300; are not ours.',
    '<!-- jfs-family-maintenance:start — managed by jfs-maintenance-sync; edit family/maintenance.md in @jfs/vendor-cli -->',
    'Canonical text, identical in fourteen repos: see #999.',
    '<!-- jfs-family-maintenance:end -->',
    '| 2026-09-23 | Weekly | #400 held, with conditions |',
  ].join('\n');
  assert.equal(recordsPull(doc, 256), true);
  assert.equal(recordsPull(doc, 273), true);
  // The run log sits outside the block in some repos, after it in others.
  assert.equal(recordsPull(doc, 400), true);
  // Prefixes and extensions of a recorded number are other PRs.
  assert.equal(recordsPull(doc, 25), false);
  assert.equal(recordsPull(doc, 2560), false);
  assert.equal(recordsPull(doc, 27), false);
  // Another repo's PR, and an HTML entity, are not this repo's PR.
  assert.equal(recordsPull(doc, 28), false);
  assert.equal(recordsPull(doc, 300), false);
  // The canonical block can record no one repo's decision.
  assert.equal(recordsPull(doc, 999), false);
  assert.equal(recordsPull(null, 256), false);
  assert.equal(recordsPull(doc, '256'), false);
});

const pr = (number, { bot = true, ageDays = 1, labels = [] } = {}) => ({
  number, title: `PR ${number}`, bot, ageDays, labels, url: `https://example.invalid/pull/${number}`,
});
const verdicts = (entries) => new Map(entries.map(([n, red, conflicted = false]) => [n, { red, conflicted }]));

test('held AND recorded: listed as held, never stale, red or conflicted', () => {
  const t = triageBotPulls(
    [pr(256, { ageDays: 20, labels: ['hold'] })],
    verdicts([[256, ['CI'], true]]),
    'Dependabot #256 — HOLD until upstream restores unwrap-on-disallowed.'
  );
  assert.deepEqual(t.stalePulls, []);
  assert.deepEqual(t.badPulls, []);
  assert.deepEqual(t.unrecorded, []);
  assert.deepEqual(t.held, [
    { number: 256, title: 'PR 256', ageDays: 20, url: 'https://example.invalid/pull/256', red: ['CI'], conflicted: true },
  ]);
});

test('held but NOT recorded: unrecorded, and judged exactly as if unlabelled', () => {
  const t = triageBotPulls(
    [pr(256, { ageDays: 20, labels: ['hold'] }), pr(12, { labels: ['hold'] })],
    verdicts([[256, ['CI']], [12, []]]),
    'Only #273 is held here.'
  );
  assert.deepEqual(t.held, []);
  assert.deepEqual(t.unrecorded.map((p) => p.number), [256, 12]);
  // The label muted nothing: the stale red PR is still both.
  assert.deepEqual(t.stalePulls.map((p) => p.number), [256]);
  assert.deepEqual(t.badPulls.map((p) => p.number), [256]);
});

test('a record that was never read mutes nothing and accuses nothing', () => {
  // main() passes null when MAINTENANCE.md could not be read, and reports
  // that as could-not-check; the PR is judged as unlabelled meanwhile.
  const t = triageBotPulls([pr(256, { ageDays: 20, labels: ['hold'] })], verdicts([[256, ['CI']]]), null);
  assert.deepEqual(t.held, []);
  assert.deepEqual(t.unrecorded, []);
  assert.deepEqual(t.stalePulls.map((p) => p.number), [256]);
  assert.deepEqual(t.badPulls.map((p) => p.number), [256]);
});

test('a person\'s PR with the label, and an unlabelled bot PR, behave as before', () => {
  const doc = '#256 #7';
  const human = triageBotPulls([pr(7, { bot: false, ageDays: 30, labels: ['hold'] })], verdicts([[7, ['CI']]]), doc);
  assert.deepEqual(human, { stalePulls: [], badPulls: [], held: [], unrecorded: [] });
  // Unlabelled: stale only past seven days, red whatever its age — and a
  // record naming it changes nothing without the label.
  const t = triageBotPulls(
    [pr(256, { ageDays: 8 }), pr(300, { ageDays: 7 }), pr(301, { ageDays: 1 })],
    verdicts([[256, []], [300, []], [301, [], true]]),
    doc
  );
  assert.deepEqual(t.stalePulls.map((p) => p.number), [256]);
  assert.deepEqual(t.badPulls.map((p) => p.number), [301]);
  assert.deepEqual(t.held, []);
  assert.deepEqual(t.unrecorded, []);
});

test('the report lists held PRs in their own section and column, and reads healthy with only those', () => {
  const rows = [
    {
      repo: 'Surf-Tracker', kind: 'app', scheduled: [], stranded: [], stalePulls: [], stalePins: [],
      held: [{ number: 256, title: 'Bump @extractus/article-extractor', ageDays: 20.4, url: 'https://example.invalid/256', red: ['CI'], conflicted: false }],
    },
    { repo: 'pwa-kit', kind: 'kit', scheduled: [], stranded: [], stalePulls: [], stalePins: [] },
  ];
  assert.deepEqual(heldAcross(rows).map((h) => `${h.repo}#${h.number}`), ['Surf-Tracker#256']);
  const md = renderMarkdown('healthy', [], [], rows);
  assert.match(md, /### Held \(recorded in MAINTENANCE\.md\)/);
  assert.match(md, /- Surf-Tracker #256 "Bump @extractus\/article-extractor" — 20d old, red \(CI\) — https:\/\/example\.invalid\/256/);
  assert.match(md, /held bot PRs/);
  assert.match(md, /\| Surf-Tracker \| _none_ \| — \| — \| — \| — \| #256 \| — \|/);
  assert.match(md, /Every repo's last scheduled run succeeded/);
  assert.match(md, /but the ones held on purpose below/);
  assert.doesNotMatch(md, /### \d+ finding/);
  // An unrecorded hold shows in the column, marked.
  const bad = renderMarkdown('needs-attention', ['x'], [], [{ ...rows[1], unrecordedHolds: [12] }]);
  assert.match(bad, /#12 ✗ unrecorded/);
  assert.doesNotMatch(bad, /### Held/);
});

test('the monitor\'s whole import graph is node: builtins and files beside it', () => {
  // It runs without `npm ci` so that a broken lockfile cannot blind it. The
  // hold rule made it import a sibling tool; that tool's imports are held to
  // the same rule here, recursively, or the property is only as good as the
  // next edit to a file nobody thinks of as part of the monitor.
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    const specs = [
      ...src.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm),
      ...src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
      ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of specs) {
      if (spec.startsWith('node:')) continue;
      assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${relative(ROOT, file)} imports "${spec}"`);
      const next = resolve(dirname(file), spec);
      assert.ok(!relative(join(ROOT, 'tools'), next).startsWith('..'), `${relative(ROOT, file)} reaches outside tools/: ${spec}`);
      walk(next);
    }
  };
  walk(SCRIPT);
  assert.ok(seen.has(join(ROOT, 'tools', 'maintenance-doc-check.mjs')), [...seen].join('\n'));
});

// End to end, in the stub: Surf-Tracker's real pair of holds.
const botPull = (number, title, ageDays, labels = [], user = { login: 'dependabot[bot]', type: 'Bot' }) => ({
  number, title, head: { ref: `dependabot/npm_and_yarn/pr-${number}`, sha: String(number).padStart(40, 'c') },
  user, created_at: new Date(Date.now() - ageDays * 86_400_000).toISOString(),
  html_url: `https://example.invalid/pull/${number}`, labels: labels.map((name) => ({ name })),
});
const maintenanceDocBody = (text) => ({ body: { content: Buffer.from(text).toString('base64'), encoding: 'base64' } });
const SURF = '/repos/jsvolos63/Surf-Tracker';
const SURF_DOC = `${SURF}/contents/MAINTENANCE.md`;
const RECORD = [
  '# Maintaining Surf-Tracker', '',
  '| **`@netlify/blobs`** (Dependabot #273) | 8.2.0 → 11.1.0 | **HOLD** | … |',
  '| **`@extractus/article-extractor`** (Dependabot #256) | 8.1.0 → 9.0.1 | **HOLD** | … |',
].join('\n');

function surfHolds({ labels = ['hold'], doc = maintenanceDocBody(RECORD), user } = {}) {
  const pulls = [
    botPull(256, 'Bump @extractus/article-extractor from 8.1.0 to 9.0.1', 20, labels, user),
    botPull(273, 'Bump @netlify/blobs from 8.2.0 to 11.1.0', 3, labels, user),
  ];
  return {
    [`${SURF}/pulls?`]: { body: pulls },
    [`${SURF}/pulls/`]: { body: { mergeable_state: 'clean' } },
    // Red by design: #256's gate test fails on 9.0.1.
    [`${SURF}/actions/runs?head_sha=`]: {
      body: { workflow_runs: [{ ...branchRun('ci.yml', 'pull_request', '2026-09-22T10:00:00Z', 'failure'), name: 'CI' }] },
    },
    ...(doc ? { [SURF_DOC]: doc } : {}),
  };
}
const docReads = (res) => res.requests.filter((r) => r.includes('/contents/MAINTENANCE.md'));

test('end to end: held and recorded exits 0, lists both as held, and reads MAINTENANCE.md once', () => {
  const res = runStubbed(surfHolds());
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'healthy');
  assert.deepEqual(out.findings, []);
  assert.deepEqual(
    out.held.map((h) => [h.repo, h.number, h.red]),
    [['Surf-Tracker', 256, ['CI']], ['Surf-Tracker', 273, ['CI']]]
  );
  assert.equal(out.held[0].title, 'Bump @extractus/article-extractor from 8.1.0 to 9.0.1');
  assert.equal(out.held[0].url, 'https://example.invalid/pull/256');
  assert.ok(out.held[0].ageDays > 19);
  // Once, for the one repo with a held PR, on its default branch.
  assert.deepEqual(docReads(res), [`${SURF_DOC}?ref=main`]);
  // The issue body carries the section.
  const md = runStubbed(surfHolds(), ['--markdown']);
  assert.equal(md.status, 0, md.stderr);
  assert.match(md.stdout, /### Held \(recorded in MAINTENANCE\.md\)/);
  assert.match(md.stdout, /- Surf-Tracker #256 "Bump @extractus\/article-extractor from 8\.1\.0 to 9\.0\.1" — 20d old, red \(CI\)/);
  assert.match(md.stdout, /\| Surf-Tracker \|.*\| #256, #273 \|/);
});

test('end to end: a hold MAINTENANCE.md does not record is a finding, and mutes nothing', () => {
  const res = runStubbed(surfHolds({ doc: maintenanceDocBody(RECORD.replace(/#256/g, 'the extractor PR')) }));
  assert.equal(res.status, 1, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  const lines = out.findings.filter((f) => f.startsWith('Surf-Tracker: bot PR #256'));
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.ok(lines.some((f) => /held without a recorded reason/.test(f)));
  assert.ok(lines.some((f) => /is 20d old/.test(f)));
  assert.ok(lines.some((f) => /is red \(CI\)/.test(f)));
  // The recorded one is still held, and nothing about it is a finding.
  assert.deepEqual(out.held.map((h) => h.number), [273]);
  assert.ok(!out.findings.some((f) => f.includes('#273')), out.findings.join('\n'));
});

for (const status of [404, 403]) {
  test(`end to end: MAINTENANCE.md answering ${status} is could-not-check — exit 2 — and the label mutes nothing`, () => {
    const res = runStubbed(surfHolds({ doc: { status } }));
    assert.equal(res.status, 2, res.stdout + res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.status, 'could-not-check');
    const u = out.unchecked.filter((x) => x.startsWith('Surf-Tracker:'));
    assert.equal(u.length, 1, out.unchecked.join('\n'));
    assert.match(u[0], /#256, #273/);
    assert.match(u[0], /MAINTENANCE\.md/);
    assert.deepEqual(out.held, []);
    // Nothing confirmed the hold, so the PRs are judged as unlabelled…
    assert.ok(out.findings.some((f) => /^Surf-Tracker: bot PR #256 .* is 20d old/.test(f)), out.findings.join('\n'));
    // …and not accused of an unrecorded hold the monitor could not read.
    assert.ok(!out.findings.some((f) => /held without a recorded reason/.test(f)));
  });
}

test('end to end: a bot PR whose verdict cannot be read is could-not-check, and costs no other finding', () => {
  // Before the hold rule the stale findings were pushed ahead of the verdict
  // reads, so one PR's 5xx cost only its red/conflicted half. Triage needs the
  // verdicts first; a failed read must still not drop the stale finding, the
  // other PRs' verdicts, or a recorded hold.
  const pulls = [
    botPull(256, 'Bump @extractus/article-extractor from 8.1.0 to 9.0.1', 20),
    botPull(273, 'Bump @netlify/blobs from 8.2.0 to 11.1.0', 3),
    botPull(280, 'Bump undici', 2, ['hold']),
  ];
  const res = runStubbed({
    [`${SURF}/pulls?`]: { body: pulls },
    [`${SURF}/pulls/256`]: { status: 500 },
    [`${SURF}/pulls/`]: { body: { mergeable_state: 'dirty' } },
    [`${SURF}/actions/runs?head_sha=`]: { body: { workflow_runs: [] } },
    [SURF_DOC]: maintenanceDocBody('Held: #280, until undici 8 ships the fix.'),
  });
  assert.equal(res.status, 2, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'could-not-check');
  assert.deepEqual(
    out.unchecked.filter((u) => u.startsWith('Surf-Tracker:')).map((u) => u.replace(/: \/repos.*/, '')),
    ['Surf-Tracker: bot PR #256']
  );
  const surf = out.findings.filter((f) => f.startsWith('Surf-Tracker:')).map((f) => f.replace(/ — https.*/, ''));
  assert.deepEqual(surf, [
    'Surf-Tracker: bot PR #256 "Bump @extractus/article-extractor from 8.1.0 to 9.0.1" is 20d old',
    'Surf-Tracker: bot PR #273 "Bump @netlify/blobs from 8.2.0 to 11.1.0" is conflicted',
  ]);
  assert.deepEqual(out.held.map((h) => [h.number, h.conflicted]), [[280, true]]);
});

test('end to end: a person\'s PR with the label is exactly as before — no read, no hold, no finding', () => {
  const user = { login: 'jsvolos63', type: 'User' };
  const labelled = runStubbed(surfHolds({ user, doc: null }));
  const bare = runStubbed(surfHolds({ user, labels: [], doc: null }));
  assert.equal(labelled.status, 0, labelled.stdout + labelled.stderr);
  assert.equal(labelled.stdout, bare.stdout);
  assert.deepEqual(labelled.requests, bare.requests);
  assert.deepEqual(docReads(labelled), []);
});

test('end to end: an unlabelled bot PR is reported as before, and costs no MAINTENANCE.md read', () => {
  const res = runStubbed(surfHolds({ labels: [], doc: null }));
  assert.equal(res.status, 1, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.held, []);
  assert.deepEqual(
    out.findings.filter((f) => f.startsWith('Surf-Tracker:')).map((f) => f.replace(/ — https.*/, '')),
    [
      'Surf-Tracker: bot PR #256 "Bump @extractus/article-extractor from 8.1.0 to 9.0.1" is 20d old',
      'Surf-Tracker: bot PR #256 "Bump @extractus/article-extractor from 8.1.0 to 9.0.1" is red (CI)',
      'Surf-Tracker: bot PR #273 "Bump @netlify/blobs from 8.2.0 to 11.1.0" is red (CI)',
    ]
  );
  assert.deepEqual(docReads(res), []);
});
