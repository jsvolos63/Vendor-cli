# @jfs/vendor-cli

Shared **dev CLI** for the `@jfs/*` kit family (`dom-kit`, `pwa-kit`,
`cache-kit`, `news-kit`, `netlify-kit`). It owns three jobs that used to be
byte-identical copies scattered across the kits and their consumers:

1. **Vendoring** (`runVendorCli`, via each kit's `jfs-<kit>-vendor` bin) —
   generate/`--check` the committed copies buildless consumers ship.
2. **Kit-pin bumping** (`bumpKitPins`, `jfs-bump-kit-pins` bin) — the
   consumer-side pin rewriter.
3. **Kit-pin checking** (`verifyKitPins`, `jfs-check-kit-pins` bin) — a
   pre-flight that every pinned SHA actually exists on the remote.
4. **Version stamping** (`versionStamp`, `jfs-version-stamp` bin) — stamp the
   version into a consumer's shell files.

The family's consumers are buildless static sites: `node_modules` is not
deployed, so each consumer commits a generated copy of every kit it uses and
CI fails if that copy drifts from the pinned package. Each kit ships a
`jfs-<kit>-vendor` bin that owns this generation — and before this package,
every one of those bins was a byte-identical 200-line copy of the same
script, so a fix in one silently missed the other four. The logic now lives
(and is tested) here, once.

## Consumer bins

Consumers that used to hand-roll `scripts/bump-kit-pins.mjs` and their own
version stamper now add `@jfs/vendor-cli` as a direct devDependency (pinned by
commit SHA, like every `@jfs` pin — npm only links a *direct* dependency's
bins) and call:

```jsonc
// package.json
"scripts": {
  "version:stamp": "jfs-version-stamp",
  "version:check": "jfs-version-stamp --check"
}
```

```yaml
# .github/workflows/kit-pin-bump.yml
- run: jfs-bump-kit-pins          # was: node scripts/bump-kit-pins.mjs
```

**`jfs-bump-kit-pins`** rewrites the repo's `github:jsvolos63/<kit>#<sha>`
pins to each kit repo's current default-branch HEAD (needs `GITHUB_TOKEN`),
touching `package.json` only when a pin actually moved.

**`jfs-check-kit-pins`** is a pre-flight that every `github:jsvolos63/<kit>#<sha>`
pin points at a commit that actually exists on the remote. A hand-edited or
typo'd SHA otherwise surfaces as an opaque `npm install` git-128 / codeload 404;
run this ahead of install in CI and it fails fast with a clear
`pin <kit>#<sha> does not exist` instead. It scans the same sections and pin
format as `jfs-bump-kit-pins`, needs `GITHUB_TOKEN` for private repos, and exits
non-zero on any missing pin (or an inconclusive API status — a 403/5xx is not
treated as "missing"):

```yaml
# in CI, before `npm ci`
- run: jfs-check-kit-pins
```

**`jfs-version-stamp`** stamps one version string into the shell files that
must agree on it, driven by a `versionStamp` block in the consumer's
`package.json`:

```jsonc
"versionStamp": {
  "source": { "packageVersion": true },   // or { fromFile } / { deployEnv }
  "edits": [
    { "file": "sw.js",
      "find": "const SW_VERSION = '[^']*';",
      "replace": "const SW_VERSION = '{version}';" },
    { "file": "index.html", "flags": "g",
      "find": "\\?v=[^&\"'\\s]*", "replace": "?v={version}" }
  ]
}
```

`source` is exactly one of `{ packageVersion: true }` (the `version` field),
`{ fromFile: { path, pattern } }` (capture group 1 of a regex — for repos
whose source of truth is a `const` in a JS file), or
`{ deployEnv: { vars, fallback } }` (a per-deploy id from env vars, each
optionally sliced as `"NAME:8"`, with a `"timestamp"` fallback). Each edit's
`find` is a RegExp string (optional `flags`) and `{version}` is substituted
into `replace`. `--check` writes nothing and exits 1 on drift; it's a no-op
for the non-deterministic `deployEnv` source.

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
