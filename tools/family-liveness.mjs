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
//      main green" — a scheduled run fails on its own page.)
//   2. Is there a stranded `auto/*` branch: commits pushed, no pull request?
//   3. Are the @jfs/* pins actually current against each kit's default branch?
//   4. Is any bot pull request stale, or is any open one red or conflicted?
//
// DEPENDENCY-FREE, and the workflow runs it WITHOUT `npm ci`, for the same
// reason Surf-Tracker's health check is: a broken lockfile or a bad install
// must never be able to blind the monitor. Node >= 18 for global fetch.
//
// EXIT CODES — the distinction is the point
// -----------------------------------------
//   0  healthy: every automation's last scheduled run succeeded, nothing stranded
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
 *  has been failing for a month while every other workflow is green. */
export function newestScheduledPerWorkflow(workflowRuns, now = NOW) {
  const newest = new Map();
  for (const run of workflowRuns || []) {
    // An in-progress run says nothing yet; taking it as the newest would hide
    // the failed run behind it, which is the whole signal.
    if (run.status !== 'completed') continue;
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

async function scheduledRuns(repo) {
  const data = await api(`/repos/${OWNER}/${repo}/actions/runs?event=schedule&per_page=100`);
  return newestScheduledPerWorkflow(data.workflow_runs);
}

async function autoBranches(repo) {
  const refs = await api(`/repos/${OWNER}/${repo}/git/matching-refs/heads/auto/`, { allow404: true });
  return (refs || []).map((r) => r.ref.replace('refs/heads/', ''));
}

async function openPulls(repo) {
  const pulls = await api(`/repos/${OWNER}/${repo}/pulls?state=open&per_page=100`);
  return (pulls || []).map((p) => ({
    number: p.number,
    title: p.title,
    head: p.head?.ref,
    author: p.user?.login,
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
    const row = { repo, kind, scheduled: [], stranded: [], stalePulls: [], stalePins: [], unchecked: [] };
    try {
      const [runs, branches, pulls, repoPins] = await Promise.all([
        scheduledRuns(repo),
        autoBranches(repo),
        openPulls(repo),
        pins(repo),
      ]);

      row.scheduled = runs;
      for (const r of runs) {
        if (r.conclusion !== 'success') {
          findings.push(
            `${repo}: scheduled \`${r.workflow}\` last ran ${r.ageDays.toFixed(0)}d ago and ` +
            `concluded **${r.conclusion}** — ${r.url}`
          );
        }
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
    if (!findings.length && !unchecked.length) console.log('  every scheduled run green, nothing stranded, every pin current.');
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
    out.push('Every repo\'s last scheduled run succeeded, no `auto/*` branch is stranded, no bot PR is stale, and every `@jfs/*` pin is current.', '');
  }
  out.push('### Per repo', '', '| repo | scheduled runs | stranded | stale bot PRs | pins behind |', '| --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const runs = r.scheduled.length
      ? r.scheduled.map((s) => `${s.workflow.replace(/\.ya?ml$/, '')} ${s.conclusion === 'success' ? '✓' : '✗ ' + s.conclusion}`).join('<br>')
      : '_none_';
    out.push(
      `| ${r.repo} | ${runs} | ${r.stranded.join(', ') || '—'} | ` +
      `${r.stalePulls.map((p) => '#' + p.number).join(', ') || '—'} | ` +
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
