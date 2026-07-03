#!/usr/bin/env node
// Fixture shim — identical in shape to the real kits' bin/vendor.mjs, except
// it imports the CLI by relative path (the fixture has no node_modules).
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVendorCli } from '../../../index.mjs';

runVendorCli(dirname(dirname(fileURLToPath(import.meta.url))));
