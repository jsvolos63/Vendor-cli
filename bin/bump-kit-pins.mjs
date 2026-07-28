#!/usr/bin/env node
// Consumer bin (`jfs-bump-kit-pins`): rewrite this repo's @jfs/* github pins to
// each kit's current default-branch HEAD. Consolidated from the byte-identical
// scripts/bump-kit-pins.mjs that used to live in every consumer. Scans
// dependencies, devDependencies, and the `vendoredKits` object (copy-in
// consumers — for those this bin only rewrites the SHAs; the consumer owns
// regenerating its vendored copies). HEAD is resolved with `git ls-remote`,
// falling back to the GitHub API. See @jfs/vendor-cli bumpKitPins().
//
// Usage: jfs-bump-kit-pins [--pin <kit>=<sha>]...
//
//   --pin <kit>=<sha>  Repeatable. Pin that kit to an EXPLICIT 40-hex commit
//                      instead of resolving its HEAD (skips resolution for
//                      that kit entirely — pin back to a known-good commit, or
//                      bump with no remote access at all). <kit> is the
//                      package name as it appears in package.json (e.g.
//                      @jfs/pwa-kit) or the repo name (pwa-kit), and it must
//                      actually be pinned in this package.json.
import { bumpKitPins, parseBumpKitPinsArgs } from '@jfs/vendor-cli';

let opts;
try {
  opts = parseBumpKitPinsArgs(process.argv.slice(2));
} catch (err) {
  console.error(err?.message || err);
  process.exit(1);
}

bumpKitPins(process.cwd(), { pins: opts.pins }).catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
