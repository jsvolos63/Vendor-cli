# @jfs/vendor-cli — working notes for Claude

Shared dev CLI for the `@jfs` kit family — the vendoring generator
(esm/global/bare/cjs, surface derived from the kit's own exports) plus the
consolidated kit-pin bumper (`jfs-bump-kit-pins`), kit-pin existence
pre-flight, version stamper (`jfs-version-stamp`), and CLAUDE.md
family-conventions synchronizer (`jfs-claude-md-sync`) the consumers used
to each hand-roll. Every consuming repo's `vendor:sync` / `vendor:check` /
`version:stamp` script runs a bin from here, so a breaking change lands in
every app's CI at once.

## Family CI (`.github/workflows/family-ci.yml`)

This repo also hosts the family's reusable CI workflow. Every repo's CI
calls it (`uses: jsvolos63/vendor-cli/.github/workflows/family-ci.yml@main`)
instead of hand-copying the checkout/node/install/check skeleton; it carries
the kit-pin pre-flight, the CLAUDE.md family-conventions check, and the
kit-style version-bump guard as opt-in inputs. Edits to it land in every
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
`install-command` (default `npm ci`), `vendor-sync-command` and
`version-bump-command` ('' skips either), `node-version` (default 22),
`auto-merge` (default true), `soft-fail` (default false), `pr-body-extra`.
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
such. It runs for ALL FOUR formats; a narrowed esm build ends in one
aggregate `export { … }` line (the only form that can carry an alias), and
`bare` has no exposed surface, so `--pick` there narrows the body only.

The hand-written shaker this replaced — a character-level lexer, statement
segmentation, an identifier-reachability walk — had the worst failure mode
this repo has: **exit 0, a plausible vendored file, and a `ReferenceError`
at load in the consumer**, invisible to `vendor:check` because regeneration
repeats the bug. An adversarial audit found six such bugs in one release
(0.13.0); that whole class now belongs to esbuild rather than to this file.

What survives of the old pass, and why:

- `lexKitSource` + `sliceTopLevel` + the chunking still run — the surface
  derivation and the full-surface `export`-strip (`strippedBody`) need to
  tell code from comments and template literals, and the policy-graft pass
  needs the boundaries of the declaration that carries each marker. Their
  refusals (non-declaration top-level statement, missing `;` before a fresh
  statement, `}` followed by `/`, destructuring in a later declarator) are
  LOUD failures, the acceptable kind — none of them can silently drop code
  anymore.
- **Policy markers survive byte-exact.** A declaration carrying a
  `@jfs-sanitizer-policy:` marker is swapped for a placeholder (tokened
  with per-run random bytes, so a kit body can never collide with it)
  before the bundle, force-rooted through a synthetic export, and grafted
  back verbatim (attached comments and markers included) after it —
  esbuild's reprint would otherwise break the canonical casing/quoting
  the generator itself validates in every emitted copy (see the sanitizer
  policy section), and an unreachable region would be dropped outright.
  Because the placeholder blinds esbuild to everything the marked
  declaration REFERENCES, an analysis pass first bundles the original
  source with the same roots and force-roots every name it keeps through
  the placeholder pass — so a helper only a policy region reaches can't be
  shaken out from under the grafted code. The marker-count gate
  (output must carry every marker the source does) still backstops the
  graft.
- Post-bundle gates, both fail-closed: every policy placeholder must
  survive as a graftable line, and every picked export's LOCAL must still
  be declared under its own name (the global/cjs surface maps reference
  locals by name, so an esbuild rename must refuse, not ship).

A FULL surface (no picks, or picks covering every export) never goes near
the bundler: verbatim source, byte-for-byte as always — which is why
re-pinning this CLI is not a re-vendor event for any full-surface copy. A
kit that does not declare `"sideEffects": false` is never shaken either.
Determinism holds because esbuild is pinned exactly and invoked with fixed
options in a fixed relative layout; `vendor:check` still diffs
regeneration against the committed copy.

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

Since 0.17.0 the gate also runs **inside the vendoring generator**: any
emitted copy carrying a policy marker is validated against the canonical
JSON before it is written or checked, so a pin to a kit commit whose
regions drifted is refused rather than vendored. Because every consumer's
`vendor:check` regenerates through this CLI, canonical policy is
re-verified on every consumer CI run for free — which is why the
consumer-side `policy:check` scripts were retired (the kit-side
`policy:check` in news-kit's own CI remains the load-bearing source gate).
Don't re-add per-consumer policy:check wiring; the choke point covers it.

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

<!-- jfs-family-conventions:end -->

## Session preferences (jsvolos63)

- Always present times relating to usage limits or resets in US Central
  time (CT), converting from UTC (note CST/CDT as applicable).
