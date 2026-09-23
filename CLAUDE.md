# @jfs/vendor-cli — working notes for Claude

Shared dev CLI for the `@jfs` kit family — the vendoring generator
(esm/global/cjs, surface derived from the kit's own exports) plus the
consolidated kit-pin bumper (`jfs-bump-kit-pins`), kit-pin existence
pre-flight, version stamper (`jfs-version-stamp`), and the two canonical-text
synchronizers (`jfs-claude-md-sync` for CLAUDE.md's family conventions,
`jfs-maintenance-sync` for MAINTENANCE.md's family maintenance protocol) the
consumers used to each hand-roll. It also hosts the family's own monitoring —
see "Who watches the watchers" below. Every consuming repo's `vendor:sync` /
`vendor:check` / `version:stamp` script runs a bin from here, so a breaking
change lands in every app's CI at once.

## Family CI (`.github/workflows/family-ci.yml`)

This repo also hosts the family's reusable CI workflow. Every repo's CI
calls it (`uses: jsvolos63/vendor-cli/.github/workflows/family-ci.yml@main`)
instead of hand-copying the checkout/node/install/check skeleton; it carries
the kit-pin pre-flight (the same `jfs-check-kit-pins` bin consumers can run
locally — not a second spelling of it), the CLAUDE.md family-conventions check, the
shipped-dependency audit gate (`prod-audit` — `npm audit --omit=dev
--audit-level=high`), the kit-style version-bump guard, and
`node-version-file` (point it at a repo's `.nvmrc` so one file governs CI and
the deploy, instead of the version being named once here and once for the
deploy where the two can drift) as opt-in inputs. Edits to it land in every
repo's next CI run at once — treat them like kit API changes. This repo's
own `test.yml` references it locally (`uses: ./…`) so a PR editing the
workflow validates against its own copy.

## Kit pin bump (`.github/workflows/kit-pin-bump.yml`)

The second reusable workflow: the weekly pin-bump/re-vendor/auto-merge flow
that eight consumers used to hand-copy (~104 lines each, all eight drifted).
Callers keep only the schedule and their repo-specific commands; everything
else — checkout, node, install, `jfs-bump-kit-pins`, PR open, squash-merge —
lives here. Inputs: `check-command` (required — the repo's CI checks, run
in-workflow because default-token PRs never trigger pull_request CI),
`install-command` (default `npm ci`), `vendor-sync-command`,
`claude-md-sync-command` and `version-bump-command` ('' skips any),
`node-version` (default 22), `node-version-file` ('' keeps `node-version`;
the same opt-in family-ci has), `auto-merge` (default true), `soft-fail`
(default false), `release-title` ('' skips), `pr-body-extra`.

The `claude-md-sync-command` step (default: `npm install` then
`npx --no-install jfs-claude-md-sync`) is how the canonical
family-conventions text propagates: an edit to
`family/family-conventions.md` is a vendor-cli commit, so it reaches every
consumer as a vendor-cli pin bump, and the bump PR now carries the
re-synced CLAUDE.md block with it. Before this step the sync was manual
and nothing ran it — when the canonical text gained the Look & feel
section, six consumers sat red on family CI's conventions check until a
session re-synced them by hand. The re-install in the default matters:
syncing from a stale pinned copy could regress the block, which is worse
than skipping. It is a BACKSTOP, not the delivery — see "The canonical
family-conventions text" below for why the sync cannot wait for Monday.

**The bump tags the version it lands, because nothing else can.** The merge
this workflow makes is a default-`GITHUB_TOKEN` merge, and a `GITHUB_TOKEN`
push fires no workflows — the same fact that forces the check step to run the
repo's CI itself, one layer up. So the merged commit gets no CI run on main,
no `workflow_run` reaches the repo's Release workflow, and `release.yml`,
gated on exactly that run, never fires. Measured on 2026-09-22: **fifteen
versions had landed on main untagged**, every one of them a Monday pin bump —
Weather 6, Art-Gallery- 3, John's News 2, market-monitor 2, Surf-Tracker 2.
A second `gh release create` here would have been a second set of rules about
what may be tagged, so the `release` job CALLS `release.yml` instead (nested
`workflow_call`), handing it the squash commit `gh pr merge` just made. Three
things hold it together: the caller opts in with `release-title` (a repo with
no Release workflow must not be tagged out of a `package.json` that does not
name its app version — BearsMockDraft's carries no `version` field at all, its
app version being `js/version.js`); the sha comes from
`gh pr view --json mergeCommit`, not from "the head of main now", which would
race whatever merged next; and `release.yml` still refuses a version whose tag
exists, so a kit caller — which bumps no version — simply no-ops. With
`auto-merge: false` nothing is skipped that matters: a human's merge fires CI
and the ordinary gated path tags it.

The important behavior change vs. the old copies: a blocked auto-merge of a
validated bump **fails the run** instead of emitting an invisible
`::warning::` (the old failure mode is how pins silently drifted across the
family); `soft-fail: true` restores warning-only. A minimal caller:

```yaml
name: Kit pin bump
on:
  schedule:
    - cron: '41 6 * * 1'
  workflow_dispatch:
permissions:
  contents: write        # the caller must grant both — a called
  pull-requests: write   # workflow can't elevate its token
jobs:
  bump:
    uses: jsvolos63/vendor-cli/.github/workflows/kit-pin-bump.yml@main
    with:
      check-command: |
        npm run check
        npm test
```

A **kit** caller (no `vendor:sync`, no `version:stamp` — its semver tracks
`index.js` + `bin`) must also pass `vendor-sync-command: npm install` (so
`package-lock.json` follows the bumped pin) and `version-bump-command: ''`.
Left at the defaults the run dies on `Missing script: "vendor:sync"`, which
pwa-kit, netlify-kit and fetch-kit did on every scheduled run for two weeks
while nothing watched: their vendor-cli pins sat at 0.18.1 against 0.21.3,
and because each kit's vendor shim resolves the CLI from INSIDE the kit,
every consumer vendored those three kits through the stale generator.

Same rules as family-ci: edits land in every consumer's next scheduled bump
at once — treat them like kit API changes.

## Tree-shaking in the vendoring generator (esbuild since 0.16.0)

`--pick` / `--global Name:picks` narrow the emitted BODY, not just the
exposed API. The REACHABILITY analysis is esbuild's (exact-pinned in
`dependencies`, resolved lazily so the stamper/bumper bins never load it):
`treeShakeKitSource` writes the kit plus a synthetic entry that re-exports
exactly the picked names into a temp dir and bundles it with tree-shaking
on, `minify: false`, `format: esm`. A narrowed body is therefore esbuild's
reprint — comments dropped, `const` lowered to `var`, quoting normalized —
and consumers' committed narrowed copies are bundler output, reviewed as
such. It runs for ALL THREE formats; a narrowed esm build ends in one
aggregate `export { … }` line (the only form that can carry an alias).
(A fourth format, `bare`, existed through 0.18.x with zero consumers and
was removed in 0.19.0 — don't re-add it without a consumer in hand.)

The hand-written shaker this replaced — a character-level lexer, statement
segmentation, an identifier-reachability walk — had the worst failure mode
this repo has: **exit 0, a plausible vendored file, and a `ReferenceError`
at load in the consumer**, invisible to `vendor:check` because regeneration
repeats the bug. An adversarial audit found six such bugs in one release
(0.13.0); that whole class now belongs to esbuild rather than to this file.

What survives of the old pass, and why:

- `lexKitSource` + `sliceTopLevel` still run — the surface derivation and the
  full-surface `export`-strip (`strippedBody`) need to tell code from comments
  and template literals, and the shake path keeps them purely for their
  refusals. Those refusals (non-declaration top-level statement, missing `;`
  before a fresh statement, `}` followed by `/`, destructuring in a later
  declarator) are LOUD failures, the acceptable kind — none of them can
  silently drop code anymore.
- **The chunker is down to a preamble reader** (0.21.6,
  `readPreambleAndAccount`). It used to build a chunk per statement — attached
  comments, kind, declared names — for the hand-written shaker; once esbuild
  reprinted the surviving declarations, the only caller destructured
  `{ preamble }` and every other field went unread, comment attribution
  (`splitAtFirstBlank`) included. What is left is the file-top preamble
  (esbuild's bundle drops it, so it is re-attached by hand) and the walk over
  every statement that makes `declaredNames` fire its destructuring refusal
  before a byte is emitted. Removing the rest changed no consumer's vendored
  bytes: all 33 committed copies across the eight consumers regenerate
  identically.
- **Policy regions are ordinary code in narrowed builds** (0.20.0). Through
  0.19.x a placeholder/graft/analysis apparatus (~200 lines) kept
  `@jfs-sanitizer-policy:` regions byte-exact inside narrowed output, for
  per-consumer policy checks that were themselves retired at 0.17.0 — it
  defended markers nothing read. Now a narrowed build reprints policy code
  like everything else (values flow from the gated source; an unreachable
  region drops with the rest of the unreachable body), and the generator
  STRIPS the marker comment lines that survive esbuild's reprint, refusing
  if marker text survives anywhere else — a reprinted region must never
  read as a canonical one. The load-bearing gates are the owning kit's own
  `policy:check` over its SOURCE, and the full-surface gate below.
- Post-bundle gate, fail-closed: every picked export's LOCAL must still
  be declared under its own name (the global/cjs surface maps reference
  locals by name, so an esbuild rename must refuse, not ship).

A FULL surface (no picks, or picks covering every export) never goes near
the bundler: verbatim source, byte-for-byte as always — which is why
re-pinning this CLI is not a re-vendor event for any full-surface copy. A
kit that does not declare `"sideEffects": false` is never shaken either.
Determinism holds because esbuild is pinned exactly and invoked with fixed
options in a fixed relative layout; `vendor:check` still diffs
regeneration against the committed copy.

## The buildless-module-graph gate (`@jfs/vendor-cli/module-graph`)

Five apps in the family ship `<script type="module">` with **no build step**,
so the BROWSER resolves the import graph. If one specifier resolves to nothing
— or one `import { x }` names an export its source no longer has — the browser
instantiates NOTHING: blank page, no partial render, and the service worker
re-serves the same broken shell from cache. Nothing in an ordinary CI run sees
it. ESLint parses each module in isolation and never resolves a specifier;
vitest transforms ESM through esbuild, so a missing named import arrives as
`undefined` rather than a link error. JFS-Sports measured exactly that: a
renamed export left `eslint`, `node --check`, `node build.js` and the whole
vitest suite green.

`module-graph/link-module-graph.mjs` links a graph with V8's own resolver
(`vm.SourceTextModule`, stopped before `Evaluate()` — no DOM, no module body
runs, no new dependency) as a CHILD PROCESS, because
`--experimental-vm-modules` has to be set at process start and neither
`node --test` nor vitest sets it. `module-graph/index.mjs` is the parent-side
API: `linkGraph` / `linkGraphs` (multi-entry, optional dynamic-import
fixpoint), `listModuleFiles`, `findOrphans`, `outsideModules`, and `linkProbe`.

**Why it lives here and not in a kit.** It is DEV tooling — every repo already
carries this package as a devDependency, and the family's own extraction bar
says to prefer growing something existing over minting kit #6. It ships under a
subpath export, so no consumer's `import { … } from '@jfs/vendor-cli'` changes.

It was extracted from three hand-copied consumer copies. JFS-Sports' and
market-monitor's were byte-identical; Surf-Tracker's had drifted nine lines
behind and never received the `initializeImportMeta` hardening the other two
carry — forward-drift that no reconciliation ever walked back, which is the
half of the extraction bar that isn't "a third consumer".

Two properties to keep when editing:

- **`linkProbe` is not a convenience.** A linker that reported `ok: true` for
  everything would satisfy every assertion in all five consumer suites at once,
  so each consumer keeps two meta-tests proving it still fails on an
  unresolvable specifier and on a missing named export. `linkProbe` is what
  makes those two lines each instead of thirty.
- **`followDynamic` stays off by default.** `import('./x.js')` is invisible to
  a static link, so a lazily-imported subgraph is its own entry. Following it
  can only ADD reached modules — which LOOSENS an orphan check and TIGHTENS an
  outside/stray check — so it is the caller's decision, not a silent default.
  Only market-monitor needs it today.

## Lint

`npm run lint` (ESLint flat config, `eslint.config.mjs`); CI runs it before
the suite. This was the LAST code in the family to get a linter and the one
with the most leverage: every vendored copy in every consumer repo is this
package's output, and the generator's worst historical failure mode is exit 0
plus a plausible file plus a `ReferenceError` at load in the consumer —
which `vendor:check` cannot see, because regeneration repeats the bug.

Two findings, both fixed: `preserve-caught-error` on the two places that
catch an API failure and throw a composed message without attaching
`{ cause }`. Both are the git-then-API fallback paths in pin resolution
(`resolveHeadSha`, `verifyKitPins`), so the error a user actually sees when
BOTH transports fail now carries the original stack rather than only its
message text.

`test/fixture-kit/**` is ignored, and must stay ignored: those files are
INPUTS to the generator, deliberately odd — a top-level `$`, semicolon-less
declarations, policy marker regions — precisely so the generator's refusals
can be tested. Linting them would report the fixtures' whole purpose as
errors.

`no-control-regex` and `no-regex-spaces` are off: the lexer and the
sanitizer-policy machinery match control characters and known multi-space
indents in emitted output, so both rules fire on the subject matter rather
than on mistakes.

## Release (`.github/workflows/release.yml`)

The third reusable workflow, alongside `family-ci.yml` and
`kit-pin-bump.yml` (and `dependabot-merge.yml`, below): tag `v<version>` from `package.json` and open a GitHub
release, once per new version, on main. Callers keep only their triggers, the
`contents: write` grant (a called workflow cannot elevate its own token) and a
`title` input.

Seven repos hand-copied this and **all seven drifted**, in a clean ladder:

| repo(s) | what its copy had |
| --- | --- |
| the four kits | the bare version — plain `push`, nothing else |
| Weather | + `workflow_dispatch` backfill |
| vendor-cli | + `concurrency`, + `persist-credentials: false` |
| JFS-Sports | + **gate on CI success**, + validated-SHA pinning, + `set -euo pipefail`, + create-race handling |

The one that matters is JFS-Sports': its comment records that "a plain push
trigger tagged and published a release for a red main". **Six of the seven
could still do that** — including this repo. The reusable workflow is the
union, so consolidating propagates that fix to every consumer at once.

Four details worth not undoing:

- **The CI gate reads the caller's event.** A called workflow inherits the
  triggering event, so `github.event.workflow_run.conclusion` works here even
  though the `workflow_run` trigger is declared in the caller. The caller's
  `workflows:` list must match its CI workflow's `name:` exactly — which is
  `Test` in the kits, `Tests` in JFS-Sports and `CI` in the apps, so it cannot
  be defaulted.
- **The branch guard is doubled on purpose.** `workflow_run` fires for a CI
  run on ANY branch, so a caller needs `branches: [main]` on its trigger — and
  the reusable workflow ALSO checks `workflow_run.head_branch` against the
  repository's default branch, because a caller that forgets would otherwise
  tag a feature-branch commit and publish a release from unmerged work. Manual
  dispatch is exempt: that ref is chosen deliberately.
- **`ref` is the third path in, and it is not a trigger.** A sibling
  automation that has just merged a version bump calls this workflow with
  `ref:` set to that commit, and the CI gate steps aside — because the merge
  it made is precisely the one that announced nothing for the gate to read
  (see "Kit pin bump" above). Nobody else can reach it: a called workflow runs
  against the CALLER's repository with the caller's token, so the only ref a
  caller can hand over is one of its own. `ref` also wins over
  `workflow_run.head_sha` for the checkout and the tag target, for the reason
  that pinning exists at all — the tag lands on the commit that was validated,
  never on a newer one.
- **The existence check is advisory, not a lock.** The concurrency group
  serialises one repo's runs, but a tag can still arrive between the check and
  the create, so a failed `gh release create` re-checks and treats "it exists
  now" as success. The goal is that the tag exists, not that this run made it.

Edits land in every consumer's next release — treat them like kit API changes.

## Dependabot merge (`.github/workflows/dependabot-merge.yml`)

The family's **fourth** reusable workflow. Dependabot's PRs trigger
`pull_request` CI on their own (a bot's push does, a `GITHUB_TOKEN` push does
not) but that run's token is read-only, so nothing could merge them: the
family review found three sitting a week old across two repos, one of them
the fix for a HIGH prod-audit failure that had CI red on main. Each repo now
triggers this on its CI workflow completing (`workflow_run`, the same
name-must-match rule as `release.yml`); it merges when the run is green, the
PR is Dependabot's own, and every bump it carries is minor or patch. A MAJOR
bump, or a body the parser cannot read, is left open. Every npm repo pairs it
with a `.github/dependabot.yml` — weekly npm with minor and patch grouped,
monthly `github-actions` — and the `@jfs/*` git pins stay the kit-pin bump's.

**Action pinning policy**, stated here because the review found it applied
inconsistently: first-party `actions/*` are referenced by major tag (they
are maintained by the platform the runner belongs to, and a SHA there buys
nothing the tag does not), and every other action is pinned by full SHA
with the version in a trailing comment — `peter-evans/create-pull-request`
in `kit-pin-bump.yml` is the model. The monthly `github-actions` Dependabot
entry is what keeps both shapes fresh.

## The canonical family-maintenance text, and the two gates on it

`family/maintenance.md` is the second canonical text, beside
`family/family-conventions.md`, and it works the same way: every repo's
`MAINTENANCE.md` carries it verbatim between `<!-- jfs-family-maintenance:start
… -->` / `:end` markers, rewritten wholesale by `jfs-maintenance-sync`. It holds
what is true of EVERY repo — what the four reusable workflows land and the three
gaps they leave, the four cadences, the major-bump triage and its classes of
proof, "Green CI is not delivered", and what a maintenance session must not do.
The repo-specific half — that repo's own automation inventory, its upstreams,
its invariants, its diagnosis ladder, its deferred majors and its run log — is
hand-written above the block.

`claudeMdSync` and `maintenanceSync` are one `syncMarkedBlock` pass with
different arguments, so the marker handling and the mangled-marker refusal
cannot drift between them. `test/maintenance-sync.test.mjs` pins one property
the CLAUDE.md twin does not need: **the two marker pairs must never be a
substring of one another**, or one sync would find the other's block and eat it.

**`jfs-maintenance-sync` refuses to CREATE `MAINTENANCE.md`**, where its twin
happily appends to a CLAUDE.md that lacks a block. The file is half canonical
and half repo-specific, and one holding only the family block would satisfy the
gate while documenting nothing — the hollow pass the protocol's own "do not let
a check pass quietly" rule forbids. Write the repo-specific half first.

Two family-CI steps enforce it, both behind ONE opt-in input,
`maintenance-check`:

- `bin/maintenance-sync.mjs --check` — the canonical block is current.
- `tools/maintenance-doc-check.mjs` — the repo-specific half is still TRUE of
  the repo: every `npm run` it names is a real script, every workflow and path
  it names exists, every cron it quotes is the cron that actually fires. A
  maintenance doc is trusted, so a stale claim in one is worse than a gap — a
  session follows it instead of looking. Deliberate mentions of things that do
  NOT exist (recording an absence is one of the most useful things such a doc
  does) go in a `<!-- maintenance-check:allow` block, and **an entry with no
  reason after `#` is itself a finding**. Inline code outside fenced blocks is
  not scanned for paths, on purpose: docs name modules, globs and identifiers
  that are not files, and a check with false positives gets disabled.

`maintenance-check` defaults **false**, unlike `claude-md-check`'s true, for the
reason spelled out under "The canonical family-conventions text" below: these
gates run against vendor-cli MAIN rather than the consumer's pin, so the moment
the canonical text changes here, every opted-in consumer goes red until it
re-syncs. A repo opts in in the same PR that adds its `MAINTENANCE.md`, and a
repo joining the family is never instantly red for a file it has not written.
The same rule applies to editing `family/maintenance.md`: the edit and the
re-sync of every consumer are ONE piece of work, in the same session.

## Who watches the watchers (`tools/family-liveness.mjs`)

The four reusable workflows keep fourteen repos maintained with the owner away,
which makes a silent failure IN them the highest-severity failure mode in the
family — and nothing watched them. A scheduled run that fails produces no
issue, no comment and no message anyone reads.

Measured on 2026-09-22: the weekly kit-pin bump had failed on **every**
scheduled run for four to five weeks in four repos, from two unrelated causes,
in silence.

- **pwa-kit, fetch-kit, Netlify-kit** each resolved the pins, re-vendored,
  committed and PUSHED `auto/kit-pin-bump` — then could not open a pull request
  (`GitHub Actions is not permitted to create or approve pull requests`, a
  per-repo setting under Settings → Actions → General). Correct work delivered
  nowhere, three times over. Their `@jfs/vendor-cli` pins sat at 0.21.3 against
  0.21.6, and because each kit's vendor shim resolves the CLI from INSIDE the
  kit, every consumer re-vendoring those kits ran a stale generator.
- **JFS-Sports** died 16 seconds in, before the PR step: its check-command
  starts with the `fetch-data.mjs` scripts, which git-fetch a private orphan
  branch, and `kit-pin-bump.yml` did not export `GITHUB_TOKEN` to its check step
  while `family-ci.yml` did — so the SAME command passed in CI and failed in the
  bump. Fixed here; the env block is on both workflows' check steps now, and
  the comment on each says to keep them in step.

The section above this one already records this class happening once before
(three kits dying on `Missing script: "vendor:sync"` for two weeks) and being
fixed at the source. It recurred anyway, by a different mechanism, because **a
fix is not a monitor.** So `tools/family-liveness.mjs` asks the protocol's four
weekly questions mechanically across every repo: did each repo's last
*scheduled* run of each workflow succeed (per workflow, not per repo — a repo
whose CI is green while one cron has failed for a month reads healthy otherwise);
is any `auto/*` branch stranded with no PR; is any `@jfs/*` pin more than one
commit behind its kit's default branch; is any bot PR older than a week, or
red or conflicted at any age. Beside the first question it asks whether the
newest non-scheduled run of any workflow on each default branch is red —
the failure a canonical-text edit HERE causes, thirteen consumers red on push
and PR CI at once, none of it a scheduled run — and whether GitHub has
disabled a workflow for inactivity, since a disabled cron's last run reads
green for ever.

`.github/workflows/family-liveness.yml` runs it Mondays 08:10 UTC —
deliberately ~90 minutes after the 06:41 bump, so it observes THIS week's run —
and opens ONE rolling issue here when something needs a session. One issue in
the hub rather than a notification in thirteen repos: per-repo notifications
would need an `issues: write` grant in each, and the notifier's own failure
would be silent. The run itself also goes red, because a green run with an
issue attached is the same invisible signal again.

Five properties not to undo:

- **It needs a PAT** (`FAMILY_READ_TOKEN`; read on contents, actions,
  pull-requests). A repo-scoped `GITHUB_TOKEN` cannot see its siblings.
- **Every call stays inside that scope.** A PR's verdict comes from the
  workflow runs on its head commit, not from the check-runs endpoint, which a
  fine-grained token reads only with the Checks permission — a 403 there would
  have made every repo with an open bot PR could-not-check.
  `test/family-liveness.test.mjs` stubs that endpoint to 403 to hold it.
- **It never judges its own workflow.** Its run goes red on every finding and
  every could-not-check, so reading `family-liveness.yml`'s runs here would
  latch it: one bad Monday reddens the run, the next Monday reports that red
  run and reddens its own, and a healthy family never reads healthy again.
  `judgedWorkflows` drops that one path in this repo only;
  `test/family-liveness.test.mjs` holds it, with the same red runs on
  `test.yml` as the control that this repo is still watched.
- **No `npm ci`.** The script is dependency-free so a broken lockfile or a
  failed install can never blind the monitor — the same reasoning as
  Surf-Tracker's health check, written after a 54-day silent content outage.
- **Exit 2 is COULD NOT CHECK, and outranks a clean result.** No token,
  insufficient scope, or an API failure exits 2, never 0, and a partial look
  never reports the family healthy on the strength of the repos it did read.
  `test/family-liveness.test.mjs` pins that, because an unconfigured monitor
  reporting success is the one failure mode that makes it worse than nothing.

## Kit extraction policy (the bar for kit #6)

The family is **five kits** today — news-kit, pwa-kit, netlify-kit,
fetch-kit, and this one — so the next new one would be #6. (It read "#9"
until dom-kit and modal-kit were absorbed into news-kit at v0.12.0 and
archived, and "#7" until cache-kit was absorbed into fetch-kit at v0.2.0
and retired; if you change the roster, change this number with it.)

The family's per-repo overhead — CI, pins, vendoring, release tagging, a
CLAUDE.md — is a permanent fixed cost that scales with repo count, not with
usage. The short version of the bar lives in the synced block below and in
every consumer's CLAUDE.md; the reasoning: a new kit is justified only by a
third consumer AND demonstrated drift pain, because two repos copy-pasting
a helper is strictly cheaper than a sixth kit until drift actually bites.
When shared code does clear the bar, prefer landing it in an existing kit
(news-kit has absorbed river + source-menu + sanitize; netlify-kit absorbed
the Anthropic client) over creating a new repo.

## The canonical family-conventions text

`family/family-conventions.md` is the single source for the marked block at
the bottom of every repo's CLAUDE.md (including this one). Edit it here,
bump the version, and consumers pick it up via `jfs-claude-md-sync` — family
CI fails any repo whose block has drifted. The block is deliberately short:
only conventions that are truly family-wide belong in it.

**Family CI checks the block against vendor-cli MAIN, not against the
consumer's pin.** `family-ci.yml` clones this repo's main into
`.jfs-family/vendor-cli` and runs `claude-md-sync --check` from there, so
the moment an edit to the canonical text merges here, every consumer's
next CI run — a Dependabot PR's, a session's dispatch, anything — fails
its conventions check, and it stays red until that consumer's CLAUDE.md
is re-synced. The weekly pin bump does carry the re-sync, but a repo
cannot wait for Monday with CI red: the Dependabot merge workflow, for
one, merges nothing while it is. This has now happened twice (the Look &
feel section, then the Service-worker-updates and Dependencies sections:
thirteen repos red at once). So the change to the canonical text and
the re-sync of every consumer are ONE piece of work, in the same session:
merge the vendor-cli change, then in each consumer run
`node <vendor-cli checkout>/bin/claude-md-sync.mjs` from the repo root
(it syncs the CWD's CLAUDE.md), open the PR, dispatch CI, merge. Docs
only, so no consumer version bump.

## The canonical sanitizer policy

`family/sanitizer-policy.json` is the single source for the family's
security-critical sanitizer constants: the blocked-tag list that dom-kit's
`_BLOCKED_TAGS` and news-kit's `DEFAULT_BLOCKED` used to hand-mirror (and
drifted on once — MATH), and the URL control-character strip regex that
existed three times across the two kits. Each kit carries the constants
between `// @jfs-sanitizer-policy:<region>:start` / `:end` markers and
regenerates them with `jfs-sanitizer-policy-sync` (start-marker params pick
the kit's casing/quoting); the kits' CI runs the `--check` mode and fails on
drift. Edit the JSON here, bump the version, and re-pin + re-sync the kits.

Since 0.17.0 the gate also runs **inside the vendoring generator**: a kit
SOURCE carrying a policy marker is validated against the canonical JSON
before anything is written or checked, so a pin to a kit commit whose
regions drifted is refused rather than vendored. It gates on the source,
not on the emitted copy, and that distinction shipped as a real hole: from
0.20.0 to 0.21.1 the check keyed off the EMITTED bytes, and since 0.20.0 a
NARROWED copy carries no markers at all — the graft that used to preserve
them was retired, its reprinted policy values flow from the source, and the
generator strips the marker comment lines so a reprint can never read as a
canonical region — so every `--pick` generation skipped the gate while the
full-surface copies, already verbatim, were the only ones checked. That is
backwards from where the risk is: the narrowed ESM copies are news-kit's
browser-shipped sanitizers in Art-Gallery-, market-monitor and John's News.
`test/test.mjs`'s policy-gate case now drives the narrowed shapes too.
Because every consumer's `vendor:check` regenerates through this CLI, the
gate re-runs on every consumer CI run for free — which is why the
consumer-side `policy:check` scripts were retired (the kit-side
`policy:check` in news-kit's own CI remains the load-bearing source gate).
Don't re-add per-consumer policy:check wiring; the choke points cover it.

<!-- jfs-family-conventions:start — managed by jfs-claude-md-sync; edit family/family-conventions.md in @jfs/vendor-cli -->

## Family conventions

These conventions are identical across every repo in the @jfs family. The
section is managed by `jfs-claude-md-sync` (@jfs/vendor-cli) and checked by
family CI — edit `family/family-conventions.md` in the vendor-cli repo, not
here.

### Pull requests

Open pull requests **ready for review — never as drafts.** This applies to
PRs opened by automated Claude Code sessions too: some hosted environments
default to creating drafts, so mark the PR ready as part of opening it
rather than leaving it for a follow-up.

### Session autonomy

These repos are worked by automated Claude Code sessions with the owner
away, so a session that stops to ask has usually failed at the task. Every
repo's `.claude/settings.json` carries the family allowlist and
`acceptEdits`, so the ordinary tools of the job — reads, edits, git, the
npm scripts, the GitHub API — run without a permission prompt. Use them.

Ask a follow-up question only when proceeding either way would be wrong: a
genuine product decision, or an ambiguity whose two readings produce
materially different work. Routine calls — naming, file placement, patch
vs. minor, which helper to extract — belong to the session: pick the
obvious one, say so in the PR body, and keep going.

Merging is the session's job too. Open the PR ready for review, dispatch
CI, and squash-merge it once that run is green on the head commit. A
finished, green PR left open for a human to click is the outcome this
section exists to prevent. The gate itself does not move: green CI on the
head commit is still the precondition for every merge, and a red run means
fix it and re-dispatch — never merge anyway, and never park it and ask.

### Kit extraction bar

Extract shared code into a NEW `@jfs/*` kit only when both hold: a third
repo needs the same code, AND drift between the existing copies has already
caused a real bug or a manual reconciliation. Until then, copy-pasting
between two repos is cheaper than a new repo's permanent CI, pin, and
vendoring overhead. Prefer growing an existing kit over minting a new one.

### CI on automated pull requests

A push from an automated session does not fire `pull_request` workflows, so
a session-opened PR starts with no CI run of its own. Every repo's CI
workflow carries `workflow_dispatch:` so the session can run the same checks
by hand: dispatch CI on the branch, and do not merge until that run is green
on the head commit. A merge with no CI run defeats every gate the family
maintains.

### Look & feel baseline

These are mechanical UI rules, not a shared design system — each app keeps
its own look. They exist because each was violated in at least one family
repo and shipped as a real defect.

1. `env(safe-area-inset-*)` and `viewport-fit=cover` travel together — using
   one without the other is a bug (the insets resolve to 0 without it, and
   `black-translucent` status bars need it).
2. Every app has a global `:focus-visible` rule and sets
   `-webkit-tap-highlight-color` deliberately.
3. The `theme-color` meta, the manifest `theme_color`, the manifest
   `background_color`, and the app's `--bg` all agree (with a dark variant
   where the app has a light mode).
4. The version badge lives in the header and is rendered from build config,
   never hand-typed in HTML.
5. Webfonts are either self-hosted (subset, preloaded, `font-display: swap`)
   or absent — a font-family the page doesn't load must not be named first
   in a stack.

### Service-worker updates

A new build is never applied under the reader mid-session: no reload, no
swap of the controlling worker while a page is open. The worker registers,
the page shows a "new version" pill, and the new build takes over on a
gesture (the pill) or on the next launch. Two mechanisms satisfy that and
each app picks ONE: a worker that WAITS (no `skipWaiting()` in install; the
pill posts `SKIP_WAITING` and reloads on `controllerchange`) or a worker that
activates on install but never `clients.claim()`s (the pill just reloads).
Never mix them — a pill that posts `SKIP_WAITING` at a worker that already
activated has nothing to wait for and strands on "Updating…", which shipped
once.

### Dependencies

Every npm repo carries `.github/dependabot.yml` (weekly npm, minor and patch
grouped into one PR; monthly `github-actions`) and calls the family's
`dependabot-merge.yml` reusable workflow, which squash-merges a Dependabot PR
once the repo's CI is green on it and every bump in it is minor or patch. A
MAJOR bump is left open for a session or a human. Dependabot never touches
the `@jfs/*` git pins; the weekly kit-pin bump owns those. First-party
`actions/*` are referenced by major tag; every other action is pinned by
full SHA.

<!-- jfs-family-conventions:end -->

## Session preferences (jsvolos63)

- Always present times relating to usage limits or resets in US Central
  time (CT), converting from UTC (note CST/CDT as applicable).
