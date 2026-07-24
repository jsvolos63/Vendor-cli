# @jfs/vendor-cli — working notes for Claude

Shared dev CLI for the `@jfs` kit family — the vendoring generator
(esm/global/bare/cjs, surface derived from the kit's own exports) plus the
consolidated kit-pin bumper (`jfs-bump-kit-pins`), kit-pin existence
pre-flight, and version stamper (`jfs-version-stamp`) the consumers used
to each hand-roll. Every consuming repo's `vendor:sync` / `vendor:check` /
`version:stamp` script runs a bin from here, so a breaking change lands in
every app's CI at once.

## Pull requests

Open pull requests **ready for review — never as drafts.** This applies to
PRs opened by automated Claude Code sessions too: some hosted environments
default to creating drafts, so mark the PR ready as part of opening it
rather than leaving it for a follow-up.
