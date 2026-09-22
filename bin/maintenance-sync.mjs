#!/usr/bin/env node
// Consumer bin (`jfs-maintenance-sync`): keep the family-maintenance section
// of this repo's MAINTENANCE.md byte-identical across the @jfs family. The
// canonical text lives in family/maintenance.md in this package; the block in
// each consumer's MAINTENANCE.md is delimited by HTML-comment markers and
// rewritten wholesale. Pass `--check` to fail on drift instead of writing —
// family CI (family-ci.yml) runs that against every repo that opts in.
//
// Unlike claude-md-sync this will NOT create the file it owns. MAINTENANCE.md
// is half canonical and half repo-specific, and a file holding only the
// family block would pass the gate while saying nothing about the repo — the
// hollow pass the protocol itself forbids. Write the repo-specific half first.
//
// Imports ../index.mjs relatively, not '@jfs/vendor-cli', for the same reason
// its sibling does: family CI runs it straight out of a bare git checkout of
// this repo (no npm install), where the package-name specifier can't resolve.
import { maintenanceSync } from '../index.mjs';

maintenanceSync(process.cwd(), process.argv.slice(2));
