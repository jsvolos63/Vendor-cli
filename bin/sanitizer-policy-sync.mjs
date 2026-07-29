#!/usr/bin/env node
// Kit bin (`jfs-sanitizer-policy-sync`): keep the family's security-critical
// sanitizer constants (the blocked-tag list, the URL control-character strip
// regex) byte-identical across the @jfs kits. The canonical data lives in
// family/sanitizer-policy.json in this package; each kit carries the
// constants between `// @jfs-sanitizer-policy:<region>:start` / `:end`
// markers, rewritten wholesale via small per-region templates (start-marker
// params pick each kit's casing/quoting). Pass `--check` to fail with a
// diff-style message on drift instead of writing — the kits' CI runs that.
//
// Like the sibling jfs-claude-md-sync this imports ../index.mjs relatively,
// not '@jfs/vendor-cli', so it also runs straight out of a bare git checkout
// of this repo (no npm install).
import { sanitizerPolicySync } from '../index.mjs';

sanitizerPolicySync(process.cwd(), process.argv.slice(2));
