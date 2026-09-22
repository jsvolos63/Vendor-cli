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
