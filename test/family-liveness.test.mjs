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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'tools', 'family-liveness.mjs');
const {
  newestScheduledPerWorkflow, parseKitPins, renderMarkdown, redOnDefaultBranch, pullHealth, isRed, autoBranchNames,
  workflowInventory,
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
const sha = 'a'.repeat(40);
const over = JSON.parse(process.env.LIVENESS_STUB || '{}');
globalThis.fetch = async (url) => {
  const u = new URL(url);
  const key = u.pathname + u.search;
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

function runStubbed(overrides) {
  const dir = mkdtempSync(join(tmpdir(), 'liveness-stub-'));
  try {
    const stub = join(dir, 'stub.mjs');
    writeFileSync(stub, STUB);
    return spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, SCRIPT, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, FAMILY_READ_TOKEN: 'stub', GH_TOKEN: '', LIVENESS_STUB: JSON.stringify(overrides) },
    });
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
