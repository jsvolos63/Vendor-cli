#!/usr/bin/env node
// Consumer bin (`jfs-bump-kit-pins`): rewrite this repo's @jfs/* github pins to
// each kit's current default-branch HEAD. Consolidated from the byte-identical
// scripts/bump-kit-pins.mjs that used to live in every consumer. Scans
// dependencies, devDependencies, and the `vendoredKits` object (copy-in
// consumers — for those this bin only rewrites the SHAs; the consumer owns
// regenerating its vendored copies). See @jfs/vendor-cli bumpKitPins().
import { bumpKitPins } from '@jfs/vendor-cli';

bumpKitPins(process.cwd()).catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
