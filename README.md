# @jfs/vendor-cli

Shared vendoring CLI for the `@jfs/*` kit family (`dom-kit`, `pwa-kit`,
`cache-kit`, `news-kit`, `netlify-kit`).

The family's consumers are buildless static sites: `node_modules` is not
deployed, so each consumer commits a generated copy of every kit it uses and
CI fails if that copy drifts from the pinned package. Each kit ships a
`jfs-<kit>-vendor` bin that owns this generation — and before this package,
every one of those bins was a byte-identical 200-line copy of the same
script, so a fix in one silently missed the other four. The logic now lives
(and is tested) here, once.

## How kits use it

Each kit declares a dependency on this package (pinned by commit SHA, like
every other `@jfs` pin) and its `bin/vendor.mjs` is a thin shim:

```js
#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVendorCli } from '@jfs/vendor-cli';

runVendorCli(dirname(dirname(fileURLToPath(import.meta.url))));
```

`runVendorCli(kitDir, argv?)` reads the **kit's** `package.json` and
`index.js` from `kitDir` and generates (or `--check`s) the consumer-side
vendored copy. Flags are unchanged from the per-kit era:

```
--format esm      verbatim ESM copy (unit tests import this)
--format global   classic-script IIFE on globalThis.<Name> (--name required)
--format bare     export-stripped copy for classic-script bundle concatenation
--format cjs      CommonJS transform for require() from CJS Netlify Functions
--pick a,b,c      global only: expose just this subset (typos are an error)
--check           exit 1 if the destination differs from what would be generated
```

The exposed surface for global/cjs is derived from the kit source's own
top-level `export` declarations — never a hand-maintained list.

## Tests

`npm test` drives a fixture kit (`test/fixture-kit/`) through a bin shim the
same way real kits are driven, covering every format, `--pick`, `--check`
drift detection, argument validation, and executable-output probes. Each kit
additionally keeps its own vendor integration test (`test-vendor.mjs`, or
`test/vendor.test.js` in news-kit) exercising its shim + pin against its
real surface.

## Releasing a change

Kits pin this package by full commit SHA. After a change lands on `main`,
bump the pin in each kit (`@jfs/vendor-cli` in `dependencies`), run the
kit's `npm install && npm test`, and ship the kits — consumers then pick the
kits up through the usual `kit-pin-bump` flow. Because the generated output
is part of the drift contract, a change that alters output requires
regenerating consumers' vendored copies (their `vendor:check` will say so).
