#!/usr/bin/env node
// Consumer bin (`jfs-check-kit-pins`): pre-flight that every @jfs/* github pin
// in this repo's package.json points at a commit that actually exists on the
// remote. Run it in CI ahead of `npm install` so a typo'd/hand-edited SHA fails
// with a clear message instead of an opaque install-time git-128 / 404.
// Existence is checked with `git fetch --depth=1` of the exact SHA, falling
// back to the GitHub API; an inconclusive check (neither transport could
// answer) exits non-zero rather than passing. See @jfs/vendor-cli
// verifyKitPins().
import { verifyKitPins } from '@jfs/vendor-cli';

verifyKitPins(process.cwd())
  .then((n) => {
    console.log(`kit-pin-check: all ${n} kit pin(s) resolve.`);
  })
  .catch((err) => {
    console.error(`kit-pin-check: ${err?.message || err}`);
    process.exit(1);
  });
