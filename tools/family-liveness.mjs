#!/usr/bin/env node
// Is the family's own automation still running?
//
// WHY THIS EXISTS
// ---------------
// Four reusable workflows in this repo carry the upkeep of fourteen repos, and
// that is what makes the family maintainable with the owner away. It also makes
// a silent failure IN that automation the highest-severity failure mode in the
// whole system — and until this script, nothing watched it.
//
// A scheduled `workflow_run` that fails produces no issue, no comment and no
// message anyone reads. It leaves a red mark on a page nobody opens. Measured
// on 2026-09-22: the weekly kit-pin bump had failed on EVERY scheduled run for
// four to five weeks in four of thirteen repos, from two unrelated causes, with
// no signal of any kind.
//
//   - pwa-kit, fetch-kit and Netlify-kit had each resolved the new pins,
//     re-vendored, committed and PUSHED `auto/kit-pin-bump` — and then could
//     not open a pull request ("GitHub Actions is not permitted to create or
//     approve pull requests", a per-repo setting). Correct work, delivered
//     nowhere, three times over, for five weeks.
//   - JFS-Sports died 16 seconds in, before the PR step, because
//     kit-pin-bump.yml did not export GITHUB_TOKEN to its check step while
//     family-ci.yml did, so the same check-command passed in CI and failed in
//     the bump. Its @jfs pins sat behind every sibling's the whole time.
//
// One patch release of the vendoring generator went unvendored family-wide as a
// result, which matters more than it sounds: each kit's vendor shim resolves the
// CLI from INSIDE the kit, so a stale pin there means every consumer re-vendors
// through a stale generator. CLAUDE.md already records this class of failure
// happening once before, being fixed at the source, and it recurred anyway by a
// different mechanism. A fix is not a monitor.
//
// So this asks the four questions the family maintenance protocol's weekly
// cadence asks, mechanically, across every repo at once:
//
//   1. Did each repo's last SCHEDULED run of each workflow succeed? (Not "is
//      main green" — a scheduled run fails on its own page.) And, beside it,
//      is the newest non-scheduled run of any workflow on the default branch
//      red? That second half is the failure THIS repo causes: an edit to a
//      canonical text here reddens every consumer's push and PR CI at once,
//      and a monitor that read only scheduled runs could not see it.
//   2. Is there a stranded `auto/*` branch: commits pushed, no pull request?
//   3. Are the @jfs/* pins actually current against each kit's default branch?
//   4. Is any bot pull request stale, red, or conflicted? (Red is the other
//      place a canonical-text edit shows first: every open Dependabot PR's
//      CI fails its conventions check, and a red PR is one
//      dependabot-merge.yml will never land.)
//
// DEPENDENCY-FREE, and the workflow runs it WITHOUT `npm ci`, for the same
// reason Surf-Tracker's health check is: a broken lockfile or a bad install
// must never be able to blind the monitor. It needs only the global fetch
// (Node >= 18); the workflow runs it on the Node this repo's .nvmrc names.
//
// EXIT CODES — the distinction is the point
// -----------------------------------------
//   0  healthy: every automation's last scheduled run succeeded, no default
//      branch is red, no bot PR is stale, red or conflicted, nothing stranded
//   1  something needs a session
//   2  COULD NOT CHECK (no token, insufficient scope, API or network failure)
//
// 2 is separate from 0 deliberately, and from 1 as well. "The monitor could not
// look" must never be reportable as "the automation is fine" — that is the one
// failure mode that would make this worse than nothing, and it is the mistake
// the family's own protocol names under "do not let a check pass quietly".
//
// USAGE
// -----
//   FAMILY_READ_TOKEN=<pat> node tools/family-liveness.mjs
//   FAMILY_READ_TOKEN=<pat> node tools/family-liveness.mjs --json
//   node tools/family-liveness.mjs --markdown      # the issue body
//
// The token needs READ access to every repo below (contents + actions +
// pull-requests). A repo-scoped GITHUB_TOKEN cannot see its siblings, so this
// is the one job in the family that needs a PAT; without one it exits 2 rather
// than reporting a comfortable nothing.

import { pathToFileURL } from 'node:url';

const OWNER = 'jsvolos63';

// The family. Adding a repo to the family means adding a line here — there is
// no discovery step on purpose: an enumerated list is reviewable in a diff, and
// a repo that silently drops out of a discovered list is exactly the kind of
// gap this script exists to catch. `kits` are the repos other repos pin.
const REPOS = [
  { repo: 'JFS-Sports', kind: 'app' },
  { repo: 'John-s-News', kind: 'app' },
  { repo: 'market-monitor', kind: 'app' },
  { repo: 'Surf-Tracker', kind: 'app' },
  { repo: 'Art-Gallery-', kind: 'app' },
  { repo: 'Weather', kind: 'app' },
  { repo: 'FlightCheck', kind: 'app' },
  { repo: 'BearsMockDraft', kind: 'app' },
  { repo: 'Zepbound-', kind: 'app' },
  { repo: 'news-kit', kind: 'kit' },
  { repo: 'pwa-kit', kind: 'kit' },
  { repo: 'Netlify-kit', kind: 'kit' },
  { repo: 'fetch-kit', kind: 'kit' },
  { repo: 'vendor-cli', kind: 'kit' },
];

// A pin spec is `github:jsvolos63/<repo>#<sha>` or `<repo>#<sha>`; the package
// name maps to the repo that owns it. Names differ in case from the repo names.
const KIT_REPO_BY_PACKAGE = {
  '@jfs/news-kit': 'news-kit',
  '@jfs/pwa-kit': 'pwa-kit',
  '@jfs/netlify-kit': 'Netlify-kit',
  '@jfs/fetch-kit': 'fetch-kit',
  '@jfs/vendor-cli': 'vendor-cli',
};

const STALE_PR_DAYS = 7;

// The conclusions that mean "this failed". `cancelled` and `skipped` are not
// in it: a concurrency group cancels superseded runs by design, and the
// family's workflow_run callers skip on every run that is not theirs to act
// on (Dependabot merge on a human's PR, Release on a feature branch).
const RED = new Set(['failure', 'timed_out', 'startup_failure']);
export const isRed = (conclusion) => RED.has(conclusion);

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const MD_OUT = argv.includes('--markdown');
const TOKEN = process.env.FAMILY_READ_TOKEN || process.env.GH_TOKEN || '';

// `now` is read once so every age in one report is measured from one instant.
const NOW = Date.now();
const days = (iso) => (NOW - Date.parse(iso)) / 86_400_000;

class CouldNotCheck extends Error {}

async function api(path, { allow404 = false } = {}) {
  let res;
  try {
    res = await fetch(`https://api.github.com${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${TOKEN}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'jfs-family-liveness',
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    // A network failure is never a finding about the automation — it is a
    // failure to observe it, which is a different exit code.
    throw new CouldNotCheck(`${path}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
  }
  if (res.status === 404 && allow404) return null;
  if (res.status === 401 || res.status === 403) {
    throw new CouldNotCheck(
      `${path}: HTTP ${res.status} — FAMILY_READ_TOKEN is missing, expired, or lacks read scope on ${OWNER}`
    );
  }
  if (!res.ok) throw new CouldNotCheck(`${path}: HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (e) {
    throw new CouldNotCheck(`${path}: unparseable response (${e.message})`);
  }
}

/** The newest SCHEDULED run per workflow. A repo's cron jobs each fail on their
 *  own page, so the per-workflow newest is the only view that finds a job that
 *  has been failing for a month while every other workflow is green.
 *
 *  `existing`, when given, is the set of workflow paths the repo still has. A
 *  retired workflow's last run never ages out of the runs list, so without it
 *  a cron deleted after one failure is reported every week for ever —
 *  BearsMockDraft's refresh-news.yml was, 98 days after its file was gone. */
export function newestScheduledPerWorkflow(workflowRuns, now = NOW, existing = null) {
  const newest = new Map();
  for (const run of workflowRuns || []) {
    // An in-progress run says nothing yet; taking it as the newest would hide
    // the failed run behind it, which is the whole signal.
    if (run.status !== 'completed') continue;
    if (existing && !existing.has(run.path)) continue;
    const key = run.path || run.name;
    const prev = newest.get(key);
    if (!prev || Date.parse(run.run_started_at) > Date.parse(prev.run_started_at)) newest.set(key, run);
  }
  return [...newest.values()].map((r) => ({
    workflow: (r.path || '').replace('.github/workflows/', '') || r.name,
    conclusion: r.conclusion,
    ageDays: (now - Date.parse(r.run_started_at)) / 86_400_000,
    url: r.html_url,
  }));
}

/** The repo's raw runs, one request per event. The scheduled list feeds
 *  question 1; all four feed the default-branch view. Asked per EVENT, not as
 *  one `?branch=` page, because a single page is the newest hundred runs of
 *  every kind: Zepbound-'s reminder cron alone fills it in about two days, and
 *  a push run that went red before that would scroll out of view unreported. */
const BRANCH_EVENTS = ['push', 'workflow_dispatch', 'workflow_run'];

async function repoRuns(repo, branch) {
  const q = (extra) => api(`/repos/${OWNER}/${repo}/actions/runs?${extra}&per_page=100`);
  const b = encodeURIComponent(branch);
  const [schedule, ...onBranch] = await Promise.all([
    q('event=schedule'),
    ...BRANCH_EVENTS.map((e) => q(`branch=${b}&event=${e}`)),
  ]);
  const scheduled = schedule.workflow_runs || [];
  return { scheduled, onBranch: [...scheduled, ...onBranch.flatMap((d) => d.workflow_runs || [])] };
}

/** The repo's workflows as GitHub knows them now: the paths that still exist,
 *  and the ones GitHub has DISABLED for inactivity. It does that by itself to a
 *  scheduled workflow after sixty days without repository activity, and a
 *  disabled cron's last run stays green for ever — it simply stops running,
 *  which the newest-run view reads as healthy. */
export function workflowInventory(workflows) {
  const existing = new Set();
  const disabled = [];
  for (const w of workflows || []) {
    existing.add(w.path);
    if (w.state === 'disabled_inactivity') disabled.push(String(w.path).replace('.github/workflows/', ''));
  }
  return { existing, disabled };
}

/** The newest completed run of each repo workflow on the default branch, over
 *  every event it is handed — main() passes the push, dispatch, workflow_run
 *  and scheduled runs — reported only when it is red and not a scheduled run
 *  (those are question 1's own half). Taking the newest across events is what lets a later
 *  green scheduled run clear an older red dispatch — the question is whether
 *  the branch is red NOW. A pull_request run whose head branch happens to be
 *  named like the default branch is a fork's, not this branch's. Dependabot's
 *  and Copilot's dynamic workflows live outside .github/workflows and are not
 *  the repo's automation. */
export function redOnDefaultBranch(workflowRuns, now = NOW, existing = null) {
  const newest = new Map();
  for (const run of workflowRuns || []) {
    if (run.status !== 'completed') continue;
    if (['pull_request', 'pull_request_target'].includes(run.event)) continue;
    if (!String(run.path || '').startsWith('.github/workflows/')) continue;
    if (existing && !existing.has(run.path)) continue;
    const prev = newest.get(run.path);
    if (!prev || Date.parse(run.run_started_at) > Date.parse(prev.run_started_at)) newest.set(run.path, run);
  }
  return [...newest.values()]
    .filter((r) => r.event !== 'schedule' && isRed(r.conclusion))
    .map((r) => ({
      workflow: r.path.replace('.github/workflows/', ''),
      event: r.event,
      conclusion: r.conclusion,
      ageDays: (now - Date.parse(r.run_started_at)) / 86_400_000,
      url: r.html_url,
    }));
}

/** Is an open PR red, or conflicted? `pull` is the single-PR payload (the list
 *  endpoint carries no mergeability); `headRuns` the workflow runs on its head
 *  commit. The newest completed run of each workflow decides, so a red run
 *  that a later run of the same workflow went green over is not reported.
 *  GitHub computes mergeability lazily and may still answer `unknown` — that
 *  is reported as nothing, not as a conflict and not as a failure to check.
 *
 *  Workflow RUNS, not the check-runs endpoint: a fine-grained token reads check
 *  runs only with the Checks permission, which the documented scope (contents,
 *  actions, pull-requests) does not grant. Every family check is an Actions
 *  workflow, so the runs carry the same verdict under the scope the token has —
 *  and a 403 here would have turned every repo with an open bot PR into
 *  could-not-check. */
export function pullHealth(pull, headRuns) {
  const newest = new Map();
  for (const run of headRuns || []) {
    if (run.status !== 'completed') continue;
    const key = run.path || run.name;
    const prev = newest.get(key);
    if (!prev || Date.parse(run.run_started_at) > Date.parse(prev.run_started_at)) newest.set(key, run);
  }
  const red = [...newest.values()].filter((r) => isRed(r.conclusion)).map((r) => r.name || r.path);
  return { red: [...new Set(red)].sort(), conflicted: pull?.mergeable_state === 'dirty' };
}

async function botPullHealth(repo, p) {
  const [detail, runs] = await Promise.all([
    api(`/repos/${OWNER}/${repo}/pulls/${p.number}`),
    api(`/repos/${OWNER}/${repo}/actions/runs?head_sha=${p.sha}&per_page=100`),
  ]);
  return pullHealth(detail, runs.workflow_runs);
}

/** The `auto/*` branches among a matching-refs answer. The API matches by
 *  PREFIX, so `heads/auto` also returns a branch named `automation-x`; the
 *  filter is what makes the answer mean "under auto/". (The request used to
 *  carry the slash itself — `heads/auto/` — which GitHub accepts but an
 *  egress proxy that canonicalizes paths refuses with a 400, and that turned
 *  every hand-run of this script from a session into could-not-check.) */
export function autoBranchNames(refs) {
  return (refs || [])
    .map((r) => String(r.ref || ''))
    .filter((ref) => ref.startsWith('refs/heads/auto/'))
    .map((ref) => ref.replace('refs/heads/', ''));
}

async function autoBranches(repo) {
  return autoBranchNames(await api(`/repos/${OWNER}/${repo}/git/matching-refs/heads/auto`, { allow404: true }));
}

async function openPulls(repo) {
  const pulls = await api(`/repos/${OWNER}/${repo}/pulls?state=open&per_page=100`);
  return (pulls || []).map((p) => ({
    number: p.number,
    title: p.title,
    head: p.head?.ref,
    author: p.user?.login,
    sha: p.head?.sha,
    bot: p.user?.type === 'Bot' || /dependabot|github-actions/i.test(p.user?.login || ''),
    ageDays: days(p.created_at),
    draft: p.draft,
    url: p.html_url,
  }));
}

async function pins(repo) {
  const file = await api(`/repos/${OWNER}/${repo}/contents/package.json`, { allow404: true });
  if (!file?.content) return null; // Zepbound- has no package.json — not a fault.
  let pkg;
  try {
    pkg = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  } catch (e) {
    throw new CouldNotCheck(`${repo}: package.json did not parse (${e.message})`);
  }
  return parseKitPins(pkg);
}

export function parseKitPins(pkg) {
  // Both blocks: a kit pins vendor-cli in `dependencies` (its vendor shim
  // resolves the CLI from inside the package, so a consumer install must bring
  // it), while an app pins every kit in `devDependencies`. Scanning only one
  // is how a pin goes unwatched.
  const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const out = {};
  for (const [name, spec] of Object.entries(all)) {
    const kit = KIT_REPO_BY_PACKAGE[name];
    if (!kit) continue;
    const m = /#([0-9a-f]{7,40})$/.exec(String(spec));
    if (m) out[kit] = m[1];
  }
  return out;
}

async function kitHeads() {
  const heads = {};
  for (const kit of new Set(Object.values(KIT_REPO_BY_PACKAGE))) {
    const r = await api(`/repos/${OWNER}/${kit}`);
    const branch = await api(`/repos/${OWNER}/${kit}/branches/${r.default_branch}`);
    heads[kit] = branch.commit.sha;
  }
  return heads;
}

/** How far behind a pin is. The SHA alone cannot say, so this compares and
 *  reports the distance — a pin one commit behind on a Monday morning is
 *  normal; one seven commits behind is a bump that is not landing. */
async function behind(kit, sha, headSha) {
  if (sha && headSha.startsWith(sha)) return 0;
  const cmp = await api(`/repos/${OWNER}/${kit}/compare/${sha}...${headSha}`, { allow404: true });
  return cmp?.ahead_by ?? null;
}

async function main() {
  if (!TOKEN) {
    const msg =
      'family-liveness: no FAMILY_READ_TOKEN (or GH_TOKEN) in the environment.\n' +
      '  This job reads fourteen repos, and a repo-scoped GITHUB_TOKEN cannot see its siblings,\n' +
      '  so it needs a PAT with read access to contents, actions and pull-requests on ' + OWNER + '.\n' +
      '  Exiting 2 (COULD NOT CHECK) rather than 0: an unconfigured monitor must never read as a\n' +
      '  healthy family.';
    if (JSON_OUT) console.log(JSON.stringify({ status: 'could-not-check', reason: 'no token' }, null, 2));
    else console.error(msg);
    process.exit(2);
  }

  const findings = [];
  const unchecked = [];
  const rows = [];

  let heads;
  try {
    heads = await kitHeads();
  } catch (e) {
    if (!(e instanceof CouldNotCheck)) throw e;
    unchecked.push(`kit HEADs: ${e.message}`);
    heads = {};
  }

  for (const { repo, kind } of REPOS) {
    const row = {
      repo, kind, scheduled: [], disabled: [], redOnMain: [], stranded: [], stalePulls: [], badPulls: [], stalePins: [],
      unchecked: [],
    };
    try {
      const [branches, pulls, repoPins, meta, wfs] = await Promise.all([
        autoBranches(repo),
        openPulls(repo),
        pins(repo),
        api(`/repos/${OWNER}/${repo}`),
        api(`/repos/${OWNER}/${repo}/actions/workflows?per_page=100`),
      ]);
      const { existing, disabled } = workflowInventory(wfs.workflows);
      const raw = await repoRuns(repo, meta.default_branch);
      const runs = newestScheduledPerWorkflow(raw.scheduled, NOW, existing);
      const redOnMain = redOnDefaultBranch(raw.onBranch, NOW, existing);

      row.scheduled = runs;
      for (const r of runs) {
        if (r.conclusion !== 'success') {
          findings.push(
            `${repo}: scheduled \`${r.workflow}\` last ran ${r.ageDays.toFixed(0)}d ago and ` +
            `concluded **${r.conclusion}** — ${r.url}`
          );
        }
      }

      row.disabled = disabled;
      for (const w of disabled) {
        findings.push(
          `${repo}: \`${w}\` has been DISABLED by GitHub for inactivity — it no longer runs at all, ` +
          'and its last run reads green for ever. Re-enable it on the Actions page.'
        );
      }

      // One line per failing workflow: one question 1 already reports red is
      // not repeated here.
      const redScheduled = new Set(runs.filter((r) => r.conclusion !== 'success').map((r) => r.workflow));
      row.redOnMain = redOnMain.filter((r) => !redScheduled.has(r.workflow));
      for (const r of row.redOnMain) {
        findings.push(
          `${repo}: \`${r.workflow}\` is red on ${meta.default_branch} — its newest ${r.event} run ` +
          `(${r.ageDays.toFixed(0)}d ago) concluded **${r.conclusion}** — ${r.url}`
        );
      }

      // A pushed auto/* branch with no pull request is the automation having
      // done its work and failed to deliver it — invisible on the workflow page
      // once the run has scrolled away, and the exact shape of the five-week
      // outage this script was written for.
      const headsWithPr = new Set(pulls.map((p) => p.head));
      row.stranded = branches.filter((b) => !headsWithPr.has(b));
      for (const b of row.stranded) {
        findings.push(
          `${repo}: branch \`${b}\` has been pushed with no open pull request — the automation ` +
          'committed work it could not deliver (check "Allow GitHub Actions to create and approve ' +
          'pull requests" in Settings > Actions > General).'
        );
      }

      row.stalePulls = pulls.filter((p) => p.bot && p.ageDays > STALE_PR_DAYS);
      for (const p of row.stalePulls) {
        findings.push(`${repo}: bot PR #${p.number} "${p.title}" is ${p.ageDays.toFixed(0)}d old — ${p.url}`);
      }

      // Every open bot PR, whatever its age: a red one is a PR the merge
      // automation will never land, and a fresh one going red is the first
      // sign of a canonical-text edit here reddening the family.
      for (const p of pulls.filter((q) => q.bot)) {
        const h = await botPullHealth(repo, p);
        if (!h.red.length && !h.conflicted) continue;
        row.badPulls.push({ number: p.number, red: h.red, conflicted: h.conflicted });
        const why = [
          h.red.length ? `red (${h.red.join(', ')})` : '',
          h.conflicted ? 'conflicted' : '',
        ].filter(Boolean).join(' and ');
        findings.push(`${repo}: bot PR #${p.number} "${p.title}" is ${why} — ${p.url}`);
      }

      if (repoPins && Object.keys(heads).length) {
        for (const [kit, sha] of Object.entries(repoPins)) {
          if (!heads[kit]) continue;
          let n;
          try {
            n = await behind(kit, sha, heads[kit]);
          } catch (e) {
            if (!(e instanceof CouldNotCheck)) throw e;
            row.unchecked.push(`pin ${kit}: ${e.message}`);
            continue;
          }
          if (n === null) {
            row.unchecked.push(`pin ${kit}: ${sha.slice(0, 7)} does not compare against HEAD`);
          } else if (n > 1) {
            // > 1 rather than > 0: the bump runs weekly, so a single commit of
            // lag between a kit merge and Monday is the system working.
            row.stalePins.push({ kit, sha: sha.slice(0, 7), behind: n });
            findings.push(`${repo}: \`@jfs/${kit}\` pin ${sha.slice(0, 7)} is ${n} commits behind ${kit}'s default branch`);
          }
        }
      }
    } catch (e) {
      if (!(e instanceof CouldNotCheck)) throw e;
      row.unchecked.push(e.message);
    }
    // Aggregated in ONE place: the catch above and the per-pin catches inside
    // both record onto `row`, so collecting here is what keeps a repo that
    // failed two different ways from being reported twice.
    unchecked.push(...row.unchecked.map((u) => `${repo}: ${u}`));
    rows.push(row);
  }

  const status = unchecked.length ? 'could-not-check' : findings.length ? 'needs-attention' : 'healthy';

  if (JSON_OUT) {
    console.log(JSON.stringify({ status, findings, unchecked, repos: rows }, null, 2));
  } else if (MD_OUT) {
    console.log(renderMarkdown(status, findings, unchecked, rows));
  } else {
    console.log(`jfs family liveness — ${REPOS.length} repos, ${status}\n`);
    for (const f of findings) console.log(`  ! ${f.replace(/[`*]/g, '')}`);
    for (const u of unchecked) console.log(`  ? could not check — ${u}`);
    if (!findings.length && !unchecked.length) {
      console.log('  every scheduled run green, no default branch red, no bot PR stale/red/conflicted, nothing stranded, every pin current.');
    }
  }

  // Could-not-check outranks a clean result: a partial look must not report the
  // family healthy on the strength of the repos it did manage to read.
  process.exit(unchecked.length ? 2 : findings.length ? 1 : 0);
}

export function renderMarkdown(status, findings, unchecked, rows) {
  const out = [];
  out.push(`## Family automation liveness — ${status}`, '');
  if (findings.length) {
    out.push(`### ${findings.length} finding${findings.length === 1 ? '' : 's'}`, '');
    for (const f of findings) out.push(`- ${f}`);
    out.push('');
  }
  if (unchecked.length) {
    out.push(`### Could not check (${unchecked.length}) — this is not a clean bill of health`, '');
    for (const u of unchecked) out.push(`- ${u}`);
    out.push('');
  }
  if (!findings.length && !unchecked.length) {
    out.push('Every repo\'s last scheduled run succeeded, no default branch is red, no `auto/*` branch is stranded, no bot PR is stale, red or conflicted, and every `@jfs/*` pin is current.', '');
  }
  out.push(
    '### Per repo', '',
    '| repo | scheduled runs | red on default branch | stranded | stale bot PRs | red / conflicted bot PRs | pins behind |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  );
  for (const r of rows) {
    const runs = r.scheduled.length
      ? r.scheduled.map((s) => `${s.workflow.replace(/\.ya?ml$/, '')} ${s.conclusion === 'success' ? '✓' : '✗ ' + s.conclusion}`).join('<br>')
      : '_none_';
    // Rows built before a column existed (or by a test) may lack its field.
    const redOnMain = [
      ...(r.redOnMain || []).map((m) => `${m.workflow.replace(/\.ya?ml$/, '')} ✗ ${m.conclusion}`),
      ...(r.disabled || []).map((w) => `${w.replace(/\.ya?ml$/, '')} ✗ disabled`),
    ].join('<br>');
    const badPulls = (r.badPulls || [])
      .map((p) => `#${p.number} ${[p.red.length ? 'red' : '', p.conflicted ? 'conflicted' : ''].filter(Boolean).join('+')}`)
      .join(', ');
    out.push(
      `| ${r.repo} | ${runs} | ${redOnMain || '—'} | ${r.stranded.join(', ') || '—'} | ` +
      `${r.stalePulls.map((p) => '#' + p.number).join(', ') || '—'} | ${badPulls || '—'} | ` +
      `${r.stalePins.map((p) => `${p.kit} −${p.behind}`).join(', ') || '—'} |`
    );
  }
  out.push('', '_Generated by `tools/family-liveness.mjs`. See the family maintenance protocol, "Who watches the watchers"._');
  return out.join('\n');
}

// Guarded so the pure exports above can be imported by the test suite without
// this script reaching the network or calling process.exit().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
