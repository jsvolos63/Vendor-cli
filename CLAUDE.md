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

## Tree-shaking in the vendoring generator

`--pick` / `--global Name:picks` narrow the emitted BODY, not just the
exposed API: the generator roots at the picked exports' local declarations
and drops every top-level declaration they can't reach. It is a
purpose-built pass over the kit source (a lexer that classifies every
character as code/comment/literal, statement segmentation, reachability),
NOT a bundler — a bundler would reprint every kit and erase every comment,
and these files are committed and reviewed.

It runs for ALL FOUR formats. `esm` was excluded at first on the theory that
an ESM copy is bundler input, which is wrong here: the consumers are
buildless and import the vendored ESM file directly in the browser, so an
unshaken copy is shipped bytes (news-kit v0.12.0's absorption of dom-kit +
modal-kit put three consumers on a 113 KB ESM copy; their real pick lists
emit 16 KB / 70 KB / 90 KB). A narrowed esm build emits the surviving
declarations with `export` stripped plus one aggregate `export { … }` line —
the esm analogue of cjs's `module.exports` map, and the only form that can
carry an alias. `bare` has no exposed surface at all, so `--pick` there
narrows the body only.

Four invariants, all tested:
surviving declarations are exact source slices (readability), any
declaration carrying a `@jfs-sanitizer-policy:` marker is a root and the
generator refuses to emit fewer markers than the source (the consumers run
the policy check against the GENERATED copy), the output is a pure function
of source+picks (`vendor:check`), and anything the scanner can't account for
fails the generation. A full surface is never shaken — its bytes are
unchanged from the pre-tree-shaking CLI. A kit that does not declare
`"sideEffects": false` is never shaken either.

## Kit extraction policy (the bar for kit #9)

The family's per-repo overhead — CI, pins, vendoring, release tagging, a
CLAUDE.md — is a permanent fixed cost that scales with repo count, not with
usage. The short version of the bar lives in the synced block below and in
every consumer's CLAUDE.md; the reasoning: a new kit is justified only by a
third consumer AND demonstrated drift pain, because two repos copy-pasting
a helper is strictly cheaper than a ninth kit until drift actually bites.
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

### Kit extraction bar

Extract shared code into a NEW `@jfs/*` kit only when both hold: a third
repo needs the same code, AND drift between the existing copies has already
caused a real bug or a manual reconciliation. Until then, copy-pasting
between two repos is cheaper than a new repo's permanent CI, pin, and
vendoring overhead. Prefer growing an existing kit over minting a new one.

<!-- jfs-family-conventions:end -->

## Session preferences (jsvolos63)

- Always present times relating to usage limits or resets in US Central
  time (CT), converting from UTC (note CST/CDT as applicable).
