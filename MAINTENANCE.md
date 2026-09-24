# Maintaining @jfs/vendor-cli

This repo's own health is the shortest thing in this file: 228 tests green,
`eslint .` clean, no advisories, nothing vendored that could drift, nothing
deployed, and every version from `v0.17.0` to `v0.21.8` carrying a tag. What
maintenance here actually turns on is that nearly every file in this repository
is an **input to thirteen others** — four reusable workflows, two canonical
texts, one sanitizer policy, one code generator and one module linker — so the
failure that matters is never "vendor-cli is broken". It is *"vendor-cli
changed, and somewhere else went quietly red."* Nothing in this repository has
ever been able to notice that, and the monitor that notices part of it,
`.github/workflows/family-liveness.yml`, has read all fourteen repos only since
2026-09-23, when its token was created (runs 35914155538 and 35918562939, 44
findings each, on the rolling issue #60).

## What runs by itself

| Automation | Fires | Lands by itself | Leaves for a session | How a failure would be noticed |
| --- | --- | --- | --- | --- |
| `.github/workflows/test.yml` → `family-ci.yml` **locally** (`uses: ./…`), with `node-version-file: .nvmrc`, `install-command: npm install`, `run: npm run lint` + `npm test`, `version-guard-paths: index.mjs bin family tools module-graph` | every push on every branch, every `pull_request`, `workflow_dispatch` | — it *is* the gate | nothing | red on the commit or the PR. The only automation here whose failure appears where somebody is already looking. |
| `.github/workflows/release-self.yml` → `release.yml` locally | `workflow_run` on **Test** completed, `branches: [main]`; plus `workflow_dispatch` | the `v<version>` tag and its GitHub release | nothing | nothing — but it demonstrably works here. Every version back to `v0.17.0` is tagged and `v0.21.7` sits on `7a1e0b5`. Merges to `main` in this repo are made with a user token, which fires the push CI run the gate waits on; that is why this repo does not have the untagged-version problem three consumers do. |
| `.github/workflows/dependabot-merge-self.yml` → `dependabot-merge.yml` locally | `workflow_run` on **Test** completed | every minor/patch bump, squash-merged on green | **every major**, and any PR body the parser cannot read | a PR sits open and nobody is told — until the monitor's weekly run, which now reports a bot PR that is red or conflicted at any age, not only one older than a week. A PR held on purpose carries the label `hold` and is named by number in this file, and is then listed as held rather than reported. |
| `.github/workflows/family-liveness.yml` (`cron: '10 8 * * 1'`, Mondays 08:10 UTC) + dispatch | weekly | the family's four weekly questions asked mechanically; one rolling issue in *this* repo; a red run | acting on whatever it finds | its own red run and issue #60. Run 35789279594 (dispatched 2026-09-22 21:53 UTC, 16:53 CDT) exited 2, could-not-check, because the `FAMILY_READ_TOKEN` secret did not exist, and opened #60 saying so — the failure mode working as designed. The owner created the token on 2026-09-23: run 35914155538's first attempt still met nine private repos answering 404 (exit 2), and its second attempt and run 35918562939 (20:19 and 20:49 UTC, 15:19 and 15:49 CDT) read all fourteen repos and exited 1 with 44 findings each. Two of those were Surf-Tracker #256, a Dependabot major held by decision in that repo's MAINTENANCE.md and red by design — which a monitor with no way to tell a hold from neglect reports every Monday for ever. Since 0.21.9 a bot PR labelled `hold` AND named as `#<number>` in its repo's MAINTENANCE.md is listed under "Held" instead; a label with no record is a finding of its own. |
| `.github/dependabot.yml` | npm weekly Tuesday (minor+patch grouped, `open-pull-requests-limit: 5`); `github-actions` monthly (no limit set, so GitHub's default 5) | opening the PRs | the review of every major | a PR sits open. |
| `.github/workflows/family-ci.yml`, `kit-pin-bump.yml`, `release.yml`, `dependabot-merge.yml` | `workflow_call` only — none of them has a trigger of its own | nothing, for this repo | — | see **Blast radius**. Three of the four run against this repo on every push; the fourth never does. |

Two absences shape everything below.

**There is no kit-pin bump here, and there cannot be.** This package pins no
`@jfs/*` kit — its only runtime dependency is `esbuild` — so it has no
`kit-pins:bump` script and no caller of `kit-pin-bump.yml`. The consequence is
the single most important fact in this file: `kit-pin-bump.yml` is the one
reusable workflow this repo **does not dogfood**. An edit to it is executed for
the first time in twelve consumer repos, on a Monday morning, on a schedule
whose failure notifies nobody. That is exactly how it came to be broken for
four to five weeks in four repos from two unrelated causes, which is what the
family protocol's "Who watches the watchers" section was written from.

**There is nothing to deploy.** No site, no functions, no service worker, no
cached shell, no `netlify.toml`, no `versionStamp` block. "Green CI is not
delivered" in the family block below still applies, but *delivered* here means
**a consumer's pin has moved to this commit** — work done by the kit-pin bump,
in twelve other repositories, and the thing that silently stopped.

## The gate

There is no aggregate `check` script in this repo — only two of the family's
fourteen repos have one. CI runs exactly two commands, and `test.yml` hands
them to `family-ci.yml` as its `run:` block so the two cannot drift:

```
npm run lint
npm test
```

| Step | What it is |
| --- | --- |
| `npm run lint` | `eslint .` over `index.mjs`, `bin/`, `module-graph/`, `tools/`, `test/`. `test/fixture-kit/**` is ignored and must stay ignored: those files are deliberately malformed generator INPUTS. |
| `npm test` | `node --test` over **nine explicitly named files** — `test/test.mjs`, `test/tooling.test.mjs`, `test/claude-md-sync.test.mjs`, `test/maintenance-sync.test.mjs`, `test/family-liveness.test.mjs`, `test/maintenance-doc-check.test.mjs`, `test/sanitizer-policy-sync.test.mjs`, `test/module-graph.test.mjs`, `test/workflows.test.mjs`. 228 cases, ~18 s. |

Three properties of that gate matter more than the list.

- **`npm test` names its files; it does not glob.** A new `test/*.test.mjs`
  that is not added to the `test` script simply never runs, in CI or locally,
  and nothing says so. `test/workflows.test.mjs` now holds the named list
  equal to the files on disk.
- **`npm install`, never `npm ci`.** `package-lock.json` is gitignored and not
  tracked, so `npm ci` cannot run in this repo at all. `esbuild` must be
  installed before the suite: the tree-shaking tests import `index.mjs`
  directly and it resolves esbuild lazily.
- **family-ci adds three checks no local command here can run**, and skips
  five others. Measured on run 35681572086: the CLAUDE.md family-conventions
  check runs (`claude-md-check` defaults true); the `vendor:sync` /
  `vendor:check` parity step runs and reports *"scripts absent - skipped"*;
  the version-bump guard is a separate job that runs on `pull_request` —
  and, since the 2026-09-22 sweep, on `workflow_dispatch` too, diffing
  against the default branch, because the family merges on a green
  dispatch. Skipped here: the second checkout, Python, the kit-pin
  pre-flight, the shipped-dependency audit, and the family-tooling cleanup.

**Self-validation works, and it works for a reason worth writing down.**
`family-ci.yml` decides whether to clone vendor-cli beside the caller with
`github.repository == 'jsvolos63/vendor-cli'`. This repository's canonical name
is `jsvolos63/Vendor-cli`, with a capital V. It matches anyway — GitHub Actions
compares strings case-insensitively — and that is not an assumption: on run
35681572086 both the second `actions/checkout@v5` step and *Remove family
tooling checkout* concluded **skipped**, which only happens when the equality
holds. So a PR here validates against its own canonical text and its own
tooling, not `main`'s, exactly as the header comment claims. If that ever
changed, every gate in this repo's CI would silently start testing `main`
instead of the PR.

## Blast radius — what this repo delivers, and to whom

This is the section that makes a change here different from a change anywhere
else in the family. Counts verified by grep across the sibling checkouts on
2026-09-22.

| What ships | To | Delivered by | Dogfooded here | How a break shows up |
| --- | --- | --- | --- | --- |
| `.github/workflows/family-ci.yml` | 13 consumer repos | `@main`, immediately — no pin | yes, `test.yml` (`uses: ./…`) | loud: every consumer's next push or PR. The blast is instant and total. |
| `.github/workflows/kit-pin-bump.yml` | 12 consumer repos | `@main`, immediately | **no caller exists here** | silent, for a week at a time: a scheduled run on a page nobody opens. |
| `.github/workflows/release.yml` | 10 consumer repos | `@main`, immediately | yes, `release-self.yml` | silent: a version ships untagged and nothing says so. |
| `.github/workflows/dependabot-merge.yml` | 13 consumer repos | `@main`, immediately | yes, `dependabot-merge-self.yml` | silent: bot PRs stop merging and simply accumulate. |
| `family/family-conventions.md` | 14 CLAUDE.md files | `jfs-claude-md-sync`, checked against vendor-cli **main** | yes | loud and immediate: every consumer's `claude-md-check` goes red the moment this merges, until each is re-synced. Has happened twice, thirteen repos at once the second time. |
| `family/maintenance.md` | every MAINTENANCE.md with `maintenance-check: true` | `jfs-maintenance-sync`, checked against **main** | yes, as of this commit | same shape, narrower blast — which is precisely why the input defaults false. |
| `family/sanitizer-policy.json` | `news-kit/index.js` marker regions (the only kit that carries any) | `jfs-sanitizer-policy-sync`, plus the generator's own refusal | no — nothing here carries a policy region | loud and fail-closed: the generator refuses to vendor a kit whose source regions drifted, so every consumer's `vendor:check` stops rather than shipping. |
| `index.mjs` — the vendoring generator | 33 committed vendored copies across 8 consumers | the consumer's `@jfs/vendor-cli` **pin**, or a kit's own pin (a kit's vendor shim resolves the CLI from *inside* the kit) | yes, against `test/fixture-kit/` | the worst case in this repo: exit 0, a plausible file, a `ReferenceError` at load in a browser. `vendor:check` cannot see it, because regeneration repeats the bug. |
| `module-graph/` — the buildless link gate | 5 suite files in 4 repos | the consumer's pin | yes, `test/module-graph.test.mjs` | red in those four repos' suites. |
| `bin/` — six bins | every repo's npm scripts and both family gates | pin, or a bare checkout in family-ci | partly | varies by bin. |

Three consequences to hold on to.

- **A workflow edit needs no pin and no release.** It reaches every consumer
  on the next run of whatever triggers it. There is no staging, no canary and
  no rollback but a revert. The header comment on each of the four says to
  treat edits like kit API changes; that is not politeness.
- **Changing an input's DEFAULT retargets repos that never asked.**
  `family-ci.yml`'s `node-version` default and `kit-pin-bump.yml`'s both read
  `'22'`, and a caller that passes neither input rides them. This is also why
  `node-version-file` (on both of those workflows now) and
  `maintenance-check` are opt-in with inert defaults rather than "use it if
  it exists". `test/workflows.test.mjs` holds the two defaults equal to each
  other and at or above `engines.node`, but deliberately NOT to this repo's
  `.nvmrc`.
- **A canonical-text edit and every consumer's re-sync are one piece of work,
  in one session.** The gates read `main`, not the pin, so merging the text
  here reddens the consumers immediately and the weekly bump is a backstop,
  not the delivery. CLAUDE.md records this twice already.

## This repo's cross-file invariants

The pairs held in step by remembering rather than by reasoning. The prose-only
rows are the monthly sweep's work and the mechanization backlog.

| Invariant | Files | Gated by | What breaks when they drift |
| --- | --- | --- | --- |
| The two marked-block marker pairs must never be a substring of one another | `index.mjs` `FAMILY_START`/`MAINT_START` | **`test/maintenance-sync.test.mjs`** | one synchronizer finds the other's block and eats it. |
| Every picked export's local is still declared under its own name after the shake | `index.mjs` post-bundle gate | **`test/test.mjs`** (fail-closed refusal) | an esbuild rename ships a global surface map pointing at a name that does not exist. |
| A kit source's policy regions match the canonical JSON | `family/sanitizer-policy.json` ↔ the kit's `index.js` | **the generator itself**, plus news-kit's own `policy:check` | a drifted security constant is vendored into three browser-shipped sanitizers. |
| The canonical texts ↔ the 14 CLAUDE.md / opted-in MAINTENANCE.md blocks | `family/*.md` | each consumer's family-ci | consumers red. Gated *there*, invisible *here*. |
| `version-guard-paths` ↔ what `files` actually ships | `test.yml` ↔ `package.json` `files` | **`test/workflows.test.mjs`** | a change to `module-graph/`, which consumers import through the pin, lands with no version bump. It had been papered over by hand (`v0.21.5`) until the 2026-09-22 sweep added `module-graph` to the guard. |
| The Node version | `.nvmrc` (22) — read by `test.yml` and, since the sweep, by `family-liveness.yml`; `engines.node` (`>=22`); the `family-ci.yml` and `kit-pin-bump.yml` defaults (`'22'`) | **`test/workflows.test.mjs`** | CI, the monitor and the declared floor diverge. `engines.node` sat at `>=18`, EOL since April 2025, until the sweep. |
| The two reusable workflows' check steps must both export `GITHUB_TOKEN` | `family-ci.yml` "Run checks" ↔ `kit-pin-bump.yml` "Run the repo's CI checks against the bumped tree" | **`test/workflows.test.mjs`**, beside the comment in each | the exact five-week JFS-Sports outage: the same `check-command` passes in CI and dies in the bump on `fatal: could not read Username`. |
| A caller's `workflows: [Test]` ↔ `test.yml`'s `name: Test` | `release-self.yml`, `dependabot-merge-self.yml` ↔ `test.yml` | **`test/workflows.test.mjs`** (here only; each consumer's pair is still prose) | the `workflow_run` trigger silently never fires: no releases, no Dependabot merges, no error. CLAUDE.md records that the name is `Test` in the kits, `Tests` in JFS-Sports and `CI` in the apps, so it cannot be defaulted. |
| `npm test`'s named files ↔ `test/*.test.mjs` on disk | `package.json` ↔ `test/` | **`test/workflows.test.mjs`** | a test file that never runs, silently. |
| A consumer bot PR labelled `hold` ↔ a `#<number>` naming it in that repo's MAINTENANCE.md, repo-specific half | the label on GitHub ↔ the consumer's `MAINTENANCE.md` (the deferred table the protocol's "hold it — visibly" asks for) | **`tools/family-liveness.mjs`, weekly** — an unbacked label is a finding, a missing or unreadable file is could-not-check; the rule itself by **`test/family-liveness.test.mjs`** | a label becomes a silent mute. The record is what makes a hold a decision rather than a way to stop hearing about a PR. |
| The 14-repo roster and the 5-kit package map in the monitor ↔ the real family | `tools/family-liveness.mjs` `REPOS`, `KIT_REPO_BY_PACKAGE` ↔ CLAUDE.md's "five kits / kit #6" count | **prose only** | a repo joins or leaves and the monitor never looks at it — the enumerated list is deliberate (reviewable in a diff), which means it is also forgettable. |
| README's numbered job list ↔ the six bins | `README.md` ↔ `package.json` `bin` | **`test/workflows.test.mjs`** (every bin named) | it had drifted: README said the package "owns five jobs" and named neither `jfs-sanitizer-policy-sync` nor `jfs-maintenance-sync`, and `package.json`'s `description` omitted the sanitizer-policy sync. Both fixed in the sweep. |

**`test/workflows.test.mjs` reads the workflows.** Until the 2026-09-22
sweep no test here read a line of YAML, and four workflows carrying the upkeep
of fourteen repositories were validated only by being executed — three of them
here, `kit-pin-bump.yml` nowhere. It parses every file, holds every input read
to one declared (and every declared one to a read), every caller's `with:` to
the called workflow's inputs, every `steps.` / `needs.` reference to something
that exists, and the step shapes above. It cannot prove a workflow *runs*:
`kit-pin-bump.yml`'s first execution after any edit is still a consumer's.

## What nothing watches

| Thing | Belongs to | How it fails | What watches it today |
| --- | --- | --- | --- |
| The `FAMILY_READ_TOKEN` PAT | GitHub, and it expires | `tools/family-liveness.mjs` exits **2** (could-not-check), the run goes red and the issue body is prefixed with "The check could not complete" | the monitor itself — but only once it is running. Its own absence, or the workflow failing to start, is watched by nothing. Nothing in this repository can assert the secret exists. |
| The 13 consumers' *push and PR* CI | each consumer | red `main`, red PRs, Dependabot merges blocked | **the monitor, weekly, once it has a token.** Since the sweep `family-liveness.mjs` reports the newest non-scheduled run of each workflow on every default branch when it is red, and every open bot PR that is red or conflicted — except one held on purpose (label `hold` plus a `#<number>` in that repo's MAINTENANCE.md), which it lists as held. A session's own red PR is still nobody's to notice, and a canonical-text edit here still reddens thirteen repos up to a week before the Monday run says so — the re-sync in the same session remains the real control. |
| "Allow GitHub Actions to create and approve pull requests" in each consumer | a per-repo GitHub setting, in no file anywhere | the bump pushes `auto/kit-pin-bump` and cannot open a PR | the monitor's stranded-branch question — but only *after* a bump has already been stranded. In a repo whose pins never move there is no push, no stranded branch, and no signal at all. |
| `peter-evans/create-pull-request`, SHA-pinned at `5f6978faf089d4d20b00c7766989d076bb2fc7f1` (v8.1.1) | a third party | its next major, or a moved tag on its account | Dependabot's monthly `github-actions` entry, and `test/workflows.test.mjs`, which refuses a third-party `uses:` that is not a full SHA with a `# vX.Y.Z` comment. The step's first execution after a bump is still twelve consumers' Monday run. |
| `esbuild`'s reprint | upstream | a version bump changes the BYTES of every narrowed vendored copy in eight consumers | Dependabot watches the version. **Nothing watches the output.** The 0.25.10 → 0.28.2 bump (#53) was auto-merged as a minor/patch group member and shipped with **no vendor-cli version bump at all**, because `version-guard-paths` does not include `package.json`. |
| GitHub Actions platform semantics | GitHub | this repo's design rests on four of them: a `GITHUB_TOKEN` push fires no workflows; `workflow_run` fires for any branch and for fork PRs; `setup-node` prefers a non-empty `node-version` over `node-version-file`; string `==` ignores case | nothing. Each is recorded in a comment beside the code that depends on it, which is the best available substitute. |
| The npm registry and GitHub codeload for `github:` installs | third parties | every consumer's install fails loudly | nothing, and nothing needs to. |

## Cost and quota exposure

No paid API, no upstream data feed, no deploy, no key of any kind in this
repository. Two things it can spend, and one it spends in other people's
repos.

- **Actions minutes, doubled on purpose and by accident.** `test.yml` triggers
  on `push` with no branch filter *and* on `pull_request`, so every push to a
  PR branch runs the suite twice (measured: runs 210/211 and 212/213 are the
  same two Dependabot commits). Each run is ~25 s wall clock with a
  `timeout-minutes: 20` ceiling, so the waste is small and the duplication
  buys branch coverage for pushes that never become PRs. Worth knowing before
  reading the run count.
- **The GitHub REST API budget of the monitor.** `family-liveness.mjs` makes
  nine calls per repo (four runs lists — scheduled, then push, dispatch and
  `workflow_run` on the default branch — plus `auto/*` refs, open PRs,
  `package.json`, the repo and its workflow inventory), two per open bot PR,
  one `MAINTENANCE.md` read per repo that has a `hold`-labelled bot PR (and
  none in any other; labels come on the PR list it already reads), ten for
  the five kit HEADs, and one `compare` per pin not at HEAD — order
  200 calls per weekly run against a PAT's 5,000/hour. Each call carries
  `AbortSignal.timeout(20_000)` and the job carries `timeout-minutes: 15`.
  There is no caching and no conditional-request handling; at family scale
  there does not need to be.
- **The real cost of a change here is other repos' CI.** An edit to a
  canonical text obliges thirteen consumer CI runs plus thirteen re-sync
  commits. An edit to `family-ci.yml` is validated by thirteen repos whether
  or not that was the intent. Budget the session, not the minutes.

## Generated and baked

Nothing in this repository is generated. It is the one repo in the family with
no vendored copy, no stamped constant and no baked dataset — `npm run lint`
and `npm test` are the whole of it, and `git status` is honest.

What must never be hand-edited is this repo's **output**, elsewhere:

| Never hand-edit | Regenerated by |
| --- | --- |
| the 33 committed vendored kit copies across 8 consumers | each kit's `jfs-<kit>-vendor` bin → `runVendorCli` |
| the family-conventions block in 14 CLAUDE.md files | `jfs-claude-md-sync` |
| the family-maintenance block in every MAINTENANCE.md (including this file, below the marker) | `jfs-maintenance-sync` |
| `news-kit/index.js`'s `@jfs-sanitizer-policy:` regions | `jfs-sanitizer-policy-sync` from `family/sanitizer-policy.json` |
| consumers' stamped version constants | `jfs-version-stamp` |

Two local rules follow. `package-lock.json` is **gitignored deliberately** —
do not add one, and do not "fix" `install-command: npm install` to `npm ci`.
And this repo runs its own stamper on nothing: there is no `versionStamp`
block, so the version in `package.json` is bumped by hand and the only thing
checking it is family-ci's version-bump job, on pull requests and dispatches.

## Deferred and stuck

Nothing is deferred. The four Dependabot majors that sat open 13 days in the
hub (#49–#52, filling 4 of the `github-actions` ecosystem's 5 default PR
slots) landed in the 2026-09-22 sweep as four separate commits on its branch,
each carrying its proof; Dependabot closes a PR once `main` carries the
version it proposed. `engines.node` went from `>=18` to `>=22` in the same
sweep, with the test that holds it to `.nvmrc`.

What the four majors still owe after merge is a real run in the places no CI
here executes:

| Dependency | Now | Proved here | Still to observe after merge |
| --- | --- | --- | --- |
| `peter-evans/create-pull-request` | 7.0.9 → 8.1.1, `5f6978f…` | inputs and outputs read against the action's own `action.yml` at that SHA; the pinning test | a dispatched kit-pin bump in a consumer whose "Actions may create PRs" setting is on (Art-Gallery-): PR created, merged, release job run, no Node 20 warning. Not pwa-kit, fetch-kit or Netlify-kit, whose setting fails the step for another reason. |
| `actions/checkout` | v5 → v7 | this PR's family-ci run (two checkouts, `fetch-depth: 0` in version-bump) | the first `checkout@v7` under `workflow_run` in the family: this repo's `release-self` run after the merge push. |
| `actions/setup-node` | v5 → v7 | this PR's run resolves `.nvmrc` through the precedence guard | one consumer whose `.nvmrc` says 24 (BearsMockDraft): "Resolved .nvmrc as 24". |
| `actions/setup-python` | v6 → v7 | nothing — the step is skipped here | Zepbound-'s CI, the one caller passing `python-version` (`'3.12'`). Its own crons already run `v7.0.0` green. |

Not deferred, just not done: `esbuild` is exactly pinned at `0.28.2`, which is
the current release; `eslint` (`^10.9.1`, latest 10.11.0), `@eslint/js`,
`globals` and `yaml` are all inside their ranges; `npm audit --omit=dev
--audit-level=high` reports **0 vulnerabilities**. One merged-but-undeleted
session branch, `claude/family-review-3urdej`, sits on the remote; it is an
ancestor of `main` and harmless. There is no stranded `auto/*` branch here and
there never will be.

## What looks like cruft and is load-bearing

- **`linkProbe`'s two `meta:` cases, in five consumer suites.** A linker that
  returned `ok: true` for everything would satisfy every other assertion in
  all of them at once. Deleting the probes as redundant is deleting the only
  thing that proves the gate can fail.
- **`followDynamic` off by default.** Following `import()` can only *add*
  reached modules, which loosens an orphan check and tightens a stray check.
  It is the caller's decision, not a sensible default. One consumer needs it.
- **Exit 2 everywhere, distinct from 0 *and* from 1.** `jfs-check-kit-pins`,
  `tools/family-liveness.mjs` and `tools/maintenance-doc-check.mjs` all
  separate "could not check" from "clean" and fail closed. Collapsing any of
  them into a boolean is the one change that would make a monitor worse than
  no monitor, and `test/family-liveness.test.mjs` pins it.
- **The generator's loud refusals.** A non-declaration top-level statement, a
  missing `;`, a `}` followed by `/`, destructuring in a later declarator,
  marker text surviving outside a strippable comment — each aborts generation
  with a message. They look like paranoia about malformed input. They are the
  residue of six silent-drop bugs found in one release (0.13.0), whose failure
  mode was exit 0 plus a plausible file plus a `ReferenceError` in somebody's
  browser.
- **`esbuild` exact-pinned, resolved lazily.** Exact because narrowed output
  must be a pure function of (source, picks) for any consumer's
  `vendor:check` to mean anything. Lazy because the stamper and bumper bins
  must not load a bundler to rewrite a string. A caret and a top-level import
  are each a regression, not a tidy-up.
- **A full surface is never shaken.** Verbatim source, byte for byte, which is
  why re-pinning this CLI is not a re-vendor event for a full-surface copy.
- **`test/fixture-kit/**` is lint-ignored.** The fixtures are deliberately
  malformed so the refusals above can be tested. Linting them would report
  their entire purpose as errors.
- **The doubled branch guard in `release.yml`, and the head-repository check
  beside it.** `workflow_run` fires for a CI run on any branch *and* for a
  fork PR's run, so `head_branch == default_branch` alone would let a fork
  whose branch is named `main` get a release tagged from its own
  `package.json`. Both halves are needed. So is treating "the tag exists now"
  as success after a failed create: the goal is the tag, not the credit.
- **`maintenance-check` defaults false while `claude-md-check` defaults
  true.** Not an inconsistency. Both gates read `main`; the one whose file
  some repos have not written yet must not redden them for it.
- **`jfs-maintenance-sync` refuses to create `MAINTENANCE.md`.** Its twin
  happily appends to a CLAUDE.md that lacks a block. A file holding only the
  family block would pass the gate while documenting nothing — the hollow pass
  the protocol itself forbids. Write the repo-specific half first.
- **The monitor reading a consumer's `MAINTENANCE.md` to honour a label it
  could simply trust.** A `hold` label mutes a bot PR only when that repo's
  own half of `MAINTENANCE.md` names it as `#<number>`; without the record it
  is a finding. It looks like belt and braces. Trusting the label alone would
  hand any session a silent mute for exactly the PRs question 4 exists to
  surface — and one that outlives the reason for it, since nothing asks a
  label why it is still there.
- **`tools/family-liveness.mjs` is dependency-free and runs without an
  install.** A broken lockfile must never be able to blind the monitor. The
  enumerated `REPOS` list is deliberate for the same reason a discovery step
  would be dangerous: a repo that silently drops out of a discovered list is
  the exact failure this script exists to catch.

## Diagnosis — it is broken and I do not know why

Fastest-resolving first.

1. **A consumer went red right after something merged here.** Almost always
   one of the two canonical-text gates. The consumer's failing step names
   itself: *Check CLAUDE.md family conventions are in sync* or *Check
   MAINTENANCE.md …*. Both read vendor-cli `main`, not the consumer's pin, so
   the fix is to re-sync that repo now, not to wait for Monday. From the
   consumer's root, against a checkout of this repo:

   ```
   node /path/to/Vendor-cli/bin/claude-md-sync.mjs
   node /path/to/Vendor-cli/bin/maintenance-sync.mjs
   ```

2. **A consumer's `maintenance-check` fails on a claim, not on the block.**
   That is the second gate. Run it where the doc lives and read the findings:

   ```
   node /path/to/Vendor-cli/tools/maintenance-doc-check.mjs
   ```

   It exits 1 on a false claim and **2** when it could not check at all. A
   deliberate mention of something absent belongs in that doc's
   `<!-- maintenance-check:allow` block *with a reason after `#`* — an entry
   without one is itself a finding.

3. **A consumer's `vendor:check` is red and nothing was vendored.** Either the
   sanitizer-policy gate refused the generation (a kit source whose marker
   regions drifted from `family/sanitizer-policy.json` — fix the kit and
   re-sync, never the emitted copy), or the pinned generator changed its
   output. Both are fail-closed by design; neither is fixed by editing a
   vendored file.

4. **A vendored copy loads and throws `ReferenceError`.** The historically
   worst failure here, and `vendor:check` cannot see it because regeneration
   repeats the bug. Reproduce against `test/fixture-kit/` first; the
   post-bundle gate and the refusals listed above are where to look.

5. **CI green here, red there, same command.** Compare the two check steps of
   `.github/workflows/family-ci.yml` and `.github/workflows/kit-pin-bump.yml`:
   both must export `GITHUB_TOKEN`, because both checkouts use
   `persist-credentials: false` and `github.token` cannot be interpolated in a
   caller's `with:` block. That asymmetry cost JFS-Sports four silent weeks.

6. **A `workflow_run`-triggered workflow never fires.** Check that the
   caller's `workflows:` list matches the CI workflow's `name:` *exactly*
   (`Test` here). A mismatch produces no runs and no error anywhere.

7. **The version-bump job failed.** `version-guard-paths` is
   `index.mjs bin family tools module-graph` and the job runs on pull requests
   and dispatches. A change to any of those with no `package.json` version
   bump fails there and nowhere else — in particular, not on the push run
   that preceded it.

8. **The family's automation stopped.** Run the monitor by hand before reading
   anything else:

   ```
   FAMILY_READ_TOKEN=<pat> node tools/family-liveness.mjs
   ```

   Exit 0 healthy, 1 needs a session, **2 could not check** — treat 2 as "I
   have learned nothing", never as health. Without a token it exits 2 and says
   so. The Actions page is <https://github.com/jsvolos63/Vendor-cli/actions>;
   read it **per workflow**, because a scheduled failure appears on its own
   page and nowhere else. A finding that a bot PR is "held without a recorded
   reason" means it carries the `hold` label and its repo's `MAINTENANCE.md`
   names no `#<number>` for it outside the synced block: write the hold into
   that file's deferred table (why, and what would lift it), or take the label
   off. A PR under "Held" is not a finding, so it neither reddens the run nor
   comments on issue #60 by itself: it appears in every run's job summary, and
   in the issue only in a week that has something else to report. Nothing
   re-asks a hold's lifting condition — a stale `#<number>` anywhere in the
   repo half keeps honouring a labelled PR — so that is the monthly sweep's
   dependency-currency step, which walks every outstanding major, not the
   monitor's job.

9. **A bump is stuck in a consumer.** `git ls-remote --heads origin
   'refs/heads/auto/*'` in that repo against its open PR list. Commits with no
   PR means Settings → Actions → General → Workflow permissions does not let
   Actions open pull requests there. That is a setting, not a code fix, and it
   is in no file this repo can read.

## Run log

| Date | Cadence | Outcome |
| --- | --- | --- |
| 2026-09-22 | Maintenance plan written | First plan for this repo; the family-wide half is now the synced block below and everything above it is what is true of the hub alone. Opted `test.yml` into `maintenance-check: true`, so both new gates run here against this repo's own tree. Verified green: 177 tests over 8 files, `eslint .` clean, `npm audit --omit=dev --audit-level=high` 0 vulnerabilities, `esbuild` pinned at the current release, every version `v0.17.0`–`v0.21.6` tagged, no stranded `auto/*` branch, `claude-md-sync --check` in sync. Seven things the writing turned up. (1) **The commit that added the maintenance protocol changed `index.mjs`, `bin/` and `family/` without bumping the version**, which `version-guard-paths` requires — the job had been skipped because it only runs on `pull_request`, so the push run was green and the PR would not be. Bumped to `0.21.7` in this commit; it is the only fix made here. (2) **`kit-pin-bump.yml` is the one reusable workflow with no local caller**, because this repo pins no kit — so every edit to it is first executed in twelve consumers on a Monday, which is how it stayed broken for five weeks. (3) **Four Dependabot majors are open and green, 13 days old, filling 4 of the `github-actions` ecosystem's 5 default PR slots**; one of them, `peter-evans/create-pull-request` 8.1.1, is the fix for the Node 20 runner deprecation that affects twelve repos. (4) **`family-liveness.mjs` reads only `?event=schedule`**, so the failure a canonical-text edit here causes — thirteen consumers red on push/PR CI — is invisible to the monitor written to watch this repo's blast radius. (5) **The esbuild 0.25.10 → 0.28.2 bump shipped with no version bump**, since `version-guard-paths` omits `package.json`; the same guard also omits `module-graph/` and `tools/`, both of which `files` ships, and `v0.21.5` was bumped by hand for a `module-graph` change the guard would not have demanded. (6) **No test in this repo reads any YAML** — four workflows serving fourteen repos are validated only by being run, one of them nowhere. (7) `README.md` still says the package "owns five jobs" and lists neither `jfs-sanitizer-policy-sync` nor `jfs-maintenance-sync`; `package.json`'s `description` omits the latter as well. Also confirmed by run 35681572086's step list that `github.repository == 'jsvolos63/vendor-cli'` matches this repo despite its canonical capital V, so family-ci's self-reference genuinely validates the PR's own tooling. |
| 2026-09-22/23 | Weekly sweep (interrupted by the account spend limit on the 22nd; finished on the 23rd) | Baseline at `main` `3e9e174`: 178 tests, `eslint .` clean. Final: 213 tests over 9 files, lint clean, both sync checks in sync, `tools/maintenance-doc-check.mjs` clean, `npm audit --omit=dev --audit-level=high` 0 vulnerabilities. **Weekly questions:** the monitor's first run (35789279594) exited 2 — `FAMILY_READ_TOKEN` does not exist — and opened #60, owner-only; this repo has no stranded `auto/*` branch (only the merged `claude/family-review-3urdej`) and pins no kit; its four bot PRs were the Dependabot majors below. **Landed on the branch, one commit each:** `peter-evans/create-pull-request` 8.1.1 (`5f6978f`, tag and `action.yml` inputs/outputs re-verified against the remote), `actions/checkout` v7, `actions/setup-node` v7, `actions/setup-python` v7 (#49–#52). **Fixed:** `test/workflows.test.mjs`, the first test here that reads YAML, mechanizing six of the invariant table's prose-only rows; `module-graph` added to `version-guard-paths`; `engines.node` `>=18` → `>=22`; the monitor reads `.nvmrc`; family-ci's version-bump job also runs on `workflow_dispatch` (the family merges on a green dispatch, which never carried it); `kit-pin-bump.yml` gains the `node-version-file` input family-ci has (inert unless passed); the monitor now reports a red default branch, red or conflicted bot PRs and workflows GitHub disabled for inactivity — reading PR verdicts from workflow runs, not check runs, so the documented token scope suffices, and asking per event so a 30-minute cron cannot push a red push run out of its window; README's job list and `package.json`'s description name all six bins. Version `0.21.7` → `0.21.8` (`tools/` changed). **Found in review:** the monitor read its own `family-liveness.yml` runs, and that run goes red on every finding and every could-not-check — so run 35789279594 (exit 2, before the token) would have made the first run WITH a token report the monitor itself as red on `main`, and each Monday after would report the previous Monday's red scheduled run: a latch no healthy family could clear. `judgedWorkflows` now drops that one path in this repo, with a unit test, an end-to-end test and a control. **Recorded, not done:** the monitor's `REPOS` roster is still prose-only against the real family; an `esbuild` bump still ships with no version bump because `package.json` is deliberately unguarded (guarding it would fail every Dependabot devDependency PR); `kit-pin-bump.yml` and `release.yml` can only be proven after merge — see "Deferred and stuck" for the four runs to watch. **Owner-only:** create `FAMILY_READ_TOKEN` (#60); turn on "Allow GitHub Actions to create and approve pull requests" in pwa-kit, fetch-kit and Netlify-kit; backfill the 15 untagged consumer versions by dispatching `release.yml` at each commit. |
| 2026-09-24 | Monitor fix, from its first full run | The first two runs with `FAMILY_READ_TOKEN` (35914155538 attempt 2 and 35918562939, 2026-09-23 20:19 and 20:49 UTC, 15:19 and 15:49 CDT) exited 1 with 44 findings each; two were Surf-Tracker #256 — stale and red — a Dependabot major that repo's MAINTENANCE.md holds on purpose (its gate test fails on 9.0.1, by design), beside #273, held the same way. A PR held by decision was indistinguishable from one nobody had looked at, so the run could never go green. **Fixed (0.21.9):** an open bot PR carrying the label `hold` is listed under "Held (recorded in MAINTENANCE.md)", and in a new per-repo column, instead of as stale or red/conflicted — only when its repo's `MAINTENANCE.md`, read on the default branch through the contents scope the token already has, names it as `#<number>` outside the synced block. A label with no record is a finding ("held without a recorded reason") and the PR is judged as unlabelled; a missing or unreadable file is could-not-check and mutes nothing; a person's PR is untouched; a family whose only open business is recorded holds exits 0. The file is read once per repo and only where a bot PR carries the label. The monitor now imports `splitDoc` from `tools/maintenance-doc-check.mjs`, and a new test holds its import graph to `node:` builtins and files under `tools/`. **Proof:** 14 new tests in the first pass (unit, and the end-to-end stub, which now logs every request it serves, so "once, only where needed" is asserted); 21 mutations — the label alone muting, the label ignored, 404 or 403 read as an empty record, an unread record counted as recorded, a person's PR honoured, the file read in every repo, the digit and repo-prefix guards on `#<number>`, the synced block not stripped, the Held section, column or JSON list dropped, the unbacked-label finding dropped, a held PR still judged, a case-sensitive label, an npm import in the sibling tool, the read off the default branch, the stale threshold moved, a person's PR judged, health skipped for held PRs — each fails a test. **Found in review:** triage needs every bot PR's verdict before it can decide anything, so the verdict reads moved ahead of the stale findings — and one PR's verdict failing to read (a 5xx on `pulls/<n>`) then threw the whole repo into could-not-check with its stale findings, the other PRs' verdicts, its holds and its pin checks dropped, where before only that PR's red/conflicted half was lost. A failed verdict read is now recorded against that PR (`bot PR #<n>: …`, still exit 2) and the rest of the repo is judged; a 15th test drives it end to end and fails on the pre-review head. Diagnosis step 8 also said a held PR stays "in sight": it does only in the job summary, and in the issue in a week with something else to report, since a held PR alone comments on nothing — reworded. Baseline 213 → 228 tests, lint clean, both sync checks and `tools/maintenance-doc-check.mjs` clean. **Not done here:** labelling Surf-Tracker #256 and #273 (a consumer session's call, and labels are out of this session's remit); until they carry `hold` the monitor still reports them, correctly. `family/maintenance.md`'s weekly question 4 still reads "Is any bot PR older than seven days, red, or conflicted?" with no mention of holds; it is untouched here because editing the canonical text forces a same-session re-sync of every consumer. |

<!-- maintenance-check:allow
npm run check                 # named to record that this repo has NO aggregate check script, unlike two family repos
npm run vendor:check          # named to record its ABSENCE here; family-ci's vendor-script-parity step reports "scripts absent - skipped"
npm run vendor:sync           # same: this repo vendors nothing, so neither script exists
npm run version:stamp         # this repo SHIPS jfs-version-stamp and runs it on nothing; there is no versionStamp block
npm run version:check         # same: the version is guarded by family-ci's version-bump job, not by a local script
npm run kit-pins:bump         # named to record that this repo pins no @jfs kit and so has no bumper script
npm run policy:check          # news-kit's script, named as the kit-side gate on the canonical sanitizer policy; not a script here
.github/workflows/ci.yml      # the filename consumers use for the workflow that calls family-ci; this repo's is test.yml
.github/workflows/smoke.yml   # market-monitor's production smoke check, named as the family's only failure-opens-an-issue precedent
.github/workflows/health.yml  # Surf-Tracker's daily health check, named for the same reason
-->

<!-- jfs-family-maintenance:start — managed by jfs-maintenance-sync; edit family/maintenance.md in @jfs/vendor-cli -->

## Family maintenance protocol

This section is identical across every repo in the @jfs family. It is managed
by `jfs-maintenance-sync` (@jfs/vendor-cli) and checked by family CI — edit
`family/maintenance.md` in the vendor-cli repo, not here.

It covers what is true of **every** repo. What is true of THIS one — its
automation inventory, its upstreams, its invariants, its diagnosis ladder — is
the repo-specific half of this file, above.

### What the automation does, and what it deliberately leaves

Four reusable workflows in `@jfs/vendor-cli` carry the whole family's upkeep.
A repo calls the ones that apply to it:

| Workflow | Fires | Lands by itself | Leaves for a session |
| --- | --- | --- | --- |
| `family-ci.yml` | every push, every PR, `workflow_dispatch` | — it *is* the gate | nothing |
| `dependabot-merge.yml` | when CI completes on a Dependabot PR | every bump that is minor or patch, squash-merged on green | **every major**, and any PR body it can't parse |
| `kit-pin-bump.yml` | weekly, Mondays ~06:41 UTC | the `@jfs/*` pins, the re-vendor, the CLAUDE.md conventions block, the version bump | nothing, when it works |
| `release.yml` | CI green on `main` | the `v<version>` tag and its GitHub release | nothing |

Three gaps follow from that table and they are the whole reason this protocol
exists. They are not oversights; each is a deliberate refusal to automate a
judgement call, and each therefore needs a cadence instead.

**1. Majors accumulate, and the backlog is not inert.** A major is a
judgement, not a merge, so `dependabot-merge.yml` leaves it open. Nothing
schedules the session that makes the judgement, and `.github/dependabot.yml`
caps open PRs. Once the cap is full of unreviewed majors, the weekly
minor/patch PR — the one the automation *does* land — stops being opened at
all. The backlog turns from a to-do list into a block on the working half of
the pipeline.

**2. CI cannot check prose, or anything whose halves live in different
files.** Every repo's gate parses what it ships, lints it, regenerates the
vendored copies, checks the version stamp and runs the suite. None of that
notices that CLAUDE.md describes a module that moved, or that a value added to
one file has no matching entry in the two others that must agree with it. The
family's answer is the same every time and it is worth repeating: **an
invariant whose halves live in different files belongs in a test, not a
comment.** Prose does not hold. Where a cross-file rule is still only written
down, the monthly sweep is what checks it, and mechanizing it is the standing
work.

**3. Nothing watches the upstreams.** Every feed, API, scraped page and
published dataset belongs to somebody else, and these apps fail soft by
design: an upstream that 404s, moves, rate-limits the deploy's egress IP or
starts answering with a bot wall yields less content, one line in a
diagnostics payload, and a green CI run. The only way to notice is to look.

And one standing limitation that applies to every repo here: **the suites fake
the network.** That is what makes them fast, offline and safe to run
air-gapped, and it is exactly why a breaking change in a client library or an
upstream's payload shape ships green. A green suite is evidence about this
repo's code. It is never evidence about its dependencies' behaviour, and never
evidence that the deploy works.

### Who watches the watchers

The automation above is what makes fourteen repos maintainable with the owner
away, which makes a silent failure *in the automation* the highest-severity
failure mode in the family — and until this protocol existed, nothing watched
it at all.

The failure is not hypothetical and it is not rare. A `workflow_run` that
fails on a schedule produces no issue, no comment and no message anyone reads;
it leaves a red mark on a page nobody opens. Measured on 2026-09-22: the
weekly kit-pin bump had failed on **every** scheduled run for four to five
weeks in four repos, from two unrelated causes, with no signal of any kind.
Three of them had pushed a correct bump to an `auto/kit-pin-bump` branch that
no pull request was ever opened for. One patch release of the vendoring
generator had gone unvendored family-wide as a result — the same class of
failure the vendor-cli notes already record happening once before, fixed at
the source, and recurred by a different mechanism.

So the weekly check below is not optional hygiene. It is the one cadence that
protects every other cadence, and it asks four questions:

1. **Did each scheduled workflow's last run succeed?** Not "is `main` green" —
   a scheduled run fails on its own page. Check the run, not the branch.
2. **Is there a stranded `auto/*` branch?** A branch with commits and no open
   PR means the automation did its work and could not deliver it. On any repo:
   `git ls-remote --heads origin 'refs/heads/auto/*'` against the open PR list.
3. **Are the `@jfs/*` pins actually current?** A repo whose pins sit behind
   every sibling's is a repo whose bump is not landing, whatever its workflow
   page says. Compare the pins across repos, not against hope.
4. **Is any bot PR older than seven days, red, or conflicted?**

A clean week needs no action. Say so and stop.

### The cadences

#### Every change — before the push

These are the existing rules, restated so the protocol is complete in one
place:

- Run the repo's own gate command — the same steps CI runs, so the two cannot
  drift. Push only once it is clean.
- Bump the version and run the stamper whenever a **shipped asset** changes.
  Every app here serves its shell from a versioned service-worker cache, so a
  missed bump leaves returning visitors on the stale build — the exact failure
  the family flow exists to prevent. A change that never reaches the browser
  needs no bump.
- Never hand-edit generated output: a vendored kit copy, a stamped constant, a
  baked dataset. Bump the pin and re-run the generator; the copies are
  reviewed as bundler output, not as source.
- A new external resource changes the CSP, in **every** file that declares one.
- Docs change in the commit that makes them wrong, not in a later sweep.
- Open the PR ready for review, dispatch CI, and merge on green — a
  session-pushed branch fires no `pull_request` workflows, so a dispatched run
  on the head commit is the only gate there is.

#### Weekly — pipeline hygiene (~10 minutes)

The four questions under "Who watches the watchers". Nothing else.

#### Monthly — the sweep (~1 hour)

Work the sections in this order, because each one's output feeds the next:

1. **Cross-file drift** — fix first. A failure means two files that must agree
   no longer do, and where the check is gated, CI is already red.
2. **Dependency currency** — every outstanding major goes through the triage
   below. Record the verdict; do not re-derive last month's no.
3. **Advisories** — a high or critical in a *shipped* dependency already has
   CI red where the prod-audit gate is on. When no version bump resolves it —
   an upstream pinning a vulnerable transitive exactly — an `overrides` entry
   is the family's escape hatch.
4. **Upstreams** — probe the ones this repo owns a probe for, and read the
   result against its documented caveats. A datacenter IP gets a correct 403
   from Cloudflare-fronted hosts; the probe reports it and cannot tell you
   which it is.
5. **Delivery** — confirm the version being served is the one that shipped.
   See "Green CI is not delivered".
6. Add a row to the run log at the bottom of this file.

#### Quarterly, or whenever a signal says so

- **Runtime floor.** `engines.node` (or the language equivalent) against what
  upstream still supports and against the floors the outstanding majors
  demand. This is the single decision that most often unblocks a stuck major
  backlog, and it is a runtime decision before it is a dependency one.
- **Platform.** The function runtime, the bundler, the header set, the actions
  pinned by SHA — a pinned third-party action ages into a deprecated runner.
- **Security re-read.** The SSRF guards, the rate limits, the origin gates,
  what the public diagnostics endpoint discloses, and whether every key is
  still scoped, spend-limited and rotatable.
- **Upstream inventory.** Not "does it answer" but "is it still the right
  source" — a feed that died, a sanctioned route that now exists where a proxy
  was used, a pinned figure that has rotted.

### Major-bump triage

"Does CI pass?" is the wrong question for a major, because the suite fakes the
network. Work these in order and stop at the first step that says hold.

**1. Inventory the call sites.** Grep the import; read every use. Most majors
turn out not to touch the API this repo actually calls. Write down what you
depend on before reading a single release note.

**2. Check the engine floor** against the runtimes that really execute the
code — not only the declared floor, but the function runtime, the build image
and whatever the local entry point runs. A major that raises the floor is a
runtime decision first. Decide the floor, then come back.

**3. Prove it, at the bar the dependency's class demands.**

| Class | What counts as proof |
| --- | --- |
| Pure JS the suite really exercises | the repo's gate command |
| Native module | a scratch script reproducing this repo's *exact* usage against the new version — and whether it installed a prebuilt binary or compiled from source, which changes CI time and can fail on the build image |
| A client the suite **fakes** | nothing the suite can say. Diff the real export surface between the versions and read the call sites by hand |
| Browser-shipped | whatever gate executes the real module graph — a link error is invisible to a linter and arrives as `undefined` under a bundler-transformed test runner |

**4. Land it.** One major per PR unless they are genuinely independent and all
trivially verified. Bump the version only if a shipped asset changed — a
dependency bump that touches nothing shipped must not churn the
service-worker cache name.

**5. Or hold it — visibly.** A major that should not land gets a row in this
file's deferred table, with the reason and **the condition that would change
the answer**. The bot keeps the PR open either way; the table is what stops
the next session spending an hour re-deriving the same no.

### Green CI is not delivered

CI going green means the code is sound. It does not mean anyone received it.
The deploy is a second gate, it runs after CI, and it can fail on its own —
and when it does, nothing breaks and nothing says so: the platform keeps
serving the last good build, the stamped version never moves, no update pill
ever appears, and the change is simply absent for everyone. That is the same
shape as a stale dataset — every automated check green, the product quietly
not doing the new thing.

So after a merge, confirm that the build being served is the one that shipped:
compare the version in the repo against the version the live site reports and
against the one its service worker carries. Three agreeing numbers is delivery
confirmed. The last two lagging the first means the deploy failed or has not
finished.

### What a maintenance session must not do

- **Do not "clean up" a load-bearing irregularity.** Every repo here carries
  measured numbers, deliberate fallback orderings and odd-looking guards that
  encode a bug already paid for. Each repo lists its own above; the rule is
  that an oddity with a comment recording a measurement is evidence, not
  cruft. Simplify the interior freely. Before simplifying anything that
  touches a boundary, make sure that boundary's checks exist and pass.
- **Do not weaken a gate to make it pass.** A skipped test, a loosened
  assertion and a silenced linter rule all read as green. If a check is wrong,
  fix or delete it deliberately and say why; if it is right, fix the code.
- **Do not let a check pass quietly when it could not run.** "Could not check"
  must never be reportable as "fine" — the one failure mode that makes a
  monitor worse than no monitor. Keep the exit codes distinct.
- **Do not extract a kit to solve a duplication.** The bar is a third
  consumer *and* drift that has already caused a real bug or a manual
  reconciliation. Prefer growing an existing kit.

### The run log

Every sweep ends with a row in the repo-specific run log: the date, the
cadence, and what was actually found and done — including "clean". A sweep
that leaves no trace is a sweep the next session will repeat from scratch, and
the log is the only record of why a held major is still held.

<!-- jfs-family-maintenance:end -->
