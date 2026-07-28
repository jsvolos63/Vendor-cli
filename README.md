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
pins to each kit repo's current default-branch HEAD,
touching `package.json` only when a pin actually moved. It scans
`dependencies`, `devDependencies`, and the `vendoredKits` object (the copy-in
consumers, e.g. John's-News) — the same shapes `jfs-check-kit-pins` covers.
For `vendoredKits` pins the bumper only rewrites the SHAs: those kits are
copied in rather than npm-installed, so the consumer is responsible for
regenerating its vendored copies from the new pins itself (no `vendor:sync`
is assumed; the bin prints a reminder when a vendoredKits pin moves).

Pin to an **explicit** commit instead of HEAD with a repeatable `--pin`
(`<kit>` is the package name as it appears in `package.json`, or the repo
name; the SHA must be 40 hex characters and the kit must actually be pinned
in this repo). An explicit pin skips remote resolution for that kit entirely,
so it also works with no remote access at all:

```bash
jfs-bump-kit-pins                                   # every kit -> its HEAD
jfs-bump-kit-pins --pin @jfs/pwa-kit=<40-hex-sha>   # pin one kit back/forward
```

**`jfs-check-kit-pins`** is a pre-flight that every `github:jsvolos63/<kit>#<sha>`
pin points at a commit that actually exists on the remote. A hand-edited or
typo'd SHA otherwise surfaces as an opaque `npm install` git-128 / codeload 404;
run this ahead of install in CI and it fails fast with a clear
`pin <kit>#<sha> does not exist` instead. It scans `dependencies`,
`devDependencies`, and the `vendoredKits` object (the copy-in consumers), and
exits non-zero on any missing pin — or on an **inconclusive** check, which is
deliberately not treated as "fine":

```yaml
# in CI, before `npm ci`
- run: jfs-check-kit-pins
```

### How the remote is reached (git first, API fallback)

Both pin bins resolve against the remote **git-first**, falling back to the
GitHub REST API:

| job | git | API fallback |
| --- | --- | --- |
| resolve HEAD | `git ls-remote <url> HEAD` | `GET /repos/<repo>/commits/HEAD` |
| pin exists?  | `git fetch --depth=1 <url> <sha>` into a throwaway bare repo | `GET /repos/<repo>/commits/<sha>` |

The API used to be the only path, and it is unusable wherever the ambient
credential is scoped to the **git transport** rather than to `api.github.com`
(Claude Code remote sessions and other git-proxy setups): the API answers 401
authenticated / 403 unauthenticated for these private repos, so
`jfs-bump-kit-pins` died with `GitHub API returned HTTP 401` before bumping
anything. `git` reaches the same repos through whatever transport the
environment already has. The API path is kept because it *does* work in GitHub
Actions, where `GITHUB_TOKEN` is API-scoped (`GH_TOKEN` is accepted too), and
it covers a git binary that's missing or blocked.

Existence needs the depth-1 **fetch**, not `ls-remote`: pins routinely point at
commits that are no longer at any ref tip, and `ls-remote` only lists tips. A
depth-1 fetch of the exact SHA succeeds for a real historical commit and fails
with `upload-pack: not our ref` for one that doesn't exist.

`jfs-check-kit-pins` is **fail-closed**: only a clean fetch (or a 200) counts
as present and only a positive "not our ref" (or a 404/422) counts as missing.
Anything else — no git binary, transport error, timeout, API 403/5xx — is
inconclusive and exits non-zero. A network outage must never turn this
pre-flight green.

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
vendored copy:

```
--format esm      verbatim ESM copy (unit tests import this)
--format global   classic-script IIFE on globalThis.<Name> (--name required,
                  unless --global is used instead)
--format bare     export-stripped copy for classic-script bundle concatenation
--format cjs      CommonJS transform for require() from CJS Netlify Functions
--pick a,b,c      global/cjs: expose just this subset (typos are an error)
--global Name[:a,b,c]
                  global format only; repeatable. Each occurrence adds a named
                  global to the SAME emitted file, exposing its `:`-suffixed
                  pick list (or the full surface without one). The kit body is
                  emitted once and every global's surface map closes over it —
                  use this when one page needs two narrowed globals from the
                  same kit, instead of vendoring the whole bundle twice.
                  Mutually exclusive with --name/--pick, the legacy
                  single-global spelling (`--global X:a,b` emits bytes
                  identical to `--name X --pick a,b`).
--check           exit 1 if the destination differs from what would be generated
```

E.g. a consumer that loads both the reader sanitizer and the news river from
`@jfs/news-kit` as classic scripts vendors ONE file:

```
jfs-news-kit-vendor --format global \
  --global NewsKitSanitize:sanitizeHtmlToFragment,isSafeContentUrl \
  --global NewsKitRiver:renderNewsRiver,ensureNewsRiverStyles \
  --out docs/js/vendor/news-kit.global.js
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
