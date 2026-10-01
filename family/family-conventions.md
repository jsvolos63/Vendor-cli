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
gesture (the pill) or on the next launch. One mechanism satisfies that: a
worker that WAITS — no `skipWaiting()` in install. The pill reads
`registration.waiting` when it is TAPPED (after a second deploy, the worker
it was first shown for is redundant), posts it `SKIP_WAITING`, and reloads
on `controllerchange`, on that worker turning redundant, or at a ceiling of
seconds — never a sub-second timer, which reloads onto the old build; with
nothing waiting it just reloads. The worker's activate skips its cache prune
while a newer worker is installing or waiting. A worker that activates on
install but never `clients.claim()`s does NOT satisfy the rule, whatever its
pill does: activation hands every page the registration already controls to
the new worker (the SW spec's Activate step — `claim()` only concerns pages
no worker controls; measured in Chromium), and the open page then fetches
through the new build. The apps still on that model, pwa-kit's
`createServiceWorker` default among them, move to the waiting worker one at
a time; never half-migrate one — a pill that posts `SKIP_WAITING` at a
worker that already activated has nothing to wait for and strands on
"Updating…", which shipped once.

### Dependencies

Every npm repo carries `.github/dependabot.yml` — npm weekly, or monthly
where the repo's MAINTENANCE.md records why (a Netlify free plan, where every
merge is a paid deploy); minor and patch grouped, any production
dependencies in a group of their own; monthly `github-actions`; a 7-day
`cooldown` — and calls the family's `dependabot-merge.yml` reusable
workflow, which squash-merges a Dependabot PR once the repo's CI is green on
it and every bump in it is minor or patch. It
leaves open every MAJOR, and every grouped npm version update that bumps a
direct production dependency: those run where the keys live and the suites
fake the network, so a session reads each package's release notes and merges
it by hand. A security update arrives ungrouped and still merges on green —
which makes the grouping load-bearing. Dependabot never touches the `@jfs/*`
git pins; the kit-pin bump owns those (weekly, or on the cadence the repo
records). First-party `actions/*` are referenced by major tag; every other
action is pinned by full SHA.
