#!/usr/bin/env node
// Consumer bin (`jfs-version-stamp`): stamp the version into this repo's shell
// files per the `versionStamp` block in package.json. Pass `--check` to fail on
// drift instead of writing. See @jfs/vendor-cli versionStamp().
import { versionStamp } from '@jfs/vendor-cli';

versionStamp(process.cwd(), process.argv.slice(2));
