#!/usr/bin/env node
// Consumer bin (`jfs-claude-md-sync`): keep the family-conventions section of
// this repo's CLAUDE.md byte-identical across the @jfs family. The canonical
// text lives in family/family-conventions.md in this package; the block in
// each consumer's CLAUDE.md is delimited by HTML-comment markers and rewritten
// wholesale. Pass `--check` to fail on drift instead of writing — family CI
// (family-ci.yml) runs that against every repo.
//
// Unlike the sibling bins this imports ../index.mjs relatively, not
// '@jfs/vendor-cli': family CI runs it straight out of a bare git checkout of
// this repo (no npm install), where the package-name specifier can't resolve.
import { claudeMdSync } from '../index.mjs';

claudeMdSync(process.cwd(), process.argv.slice(2));
