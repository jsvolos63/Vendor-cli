// Tests for tools/family-liveness.mjs — the family automation liveness check.
//
// Only the pure decision logic is exercised here: the script reads fourteen
// repos over the network, so the suite tests what DECIDES, not what fetches.
// The three properties below are the ones that, had they held, would have
// caught the five-week silent kit-pin outage of September 2026, so each is a
// regression test for a real failure rather than for the code's shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'tools', 'family-liveness.mjs');
const { newestScheduledPerWorkflow, parseKitPins, renderMarkdown } = await import(
  pathToFileURL(SCRIPT)
);

const run = (path, name, started, conclusion, status = 'completed') => ({
  path: `.github/workflows/${path}`,
  name,
  status,
  conclusion,
  run_started_at: started,
  html_url: `https://example.invalid/${path}/${started}`,
});

test('the newest scheduled run is taken PER WORKFLOW, not per repo', () => {
  // The outage's exact shape: a repo whose CI and release runs are green while
  // one cron has failed every week for a month. A repo-level "latest run"
  // reports that repo healthy.
  const rows = newestScheduledPerWorkflow(
    [
      run('kit-pin-bump.yml', 'Kit pin bump', '2026-09-21T07:06:48Z', 'failure'),
      run('kit-pin-bump.yml', 'Kit pin bump', '2026-08-17T07:37:44Z', 'success'),
      run('smoke.yml', 'Smoke', '2026-09-22T11:00:00Z', 'success'),
    ],
    Date.parse('2026-09-22T12:00:00Z')
  );
  const byWorkflow = Object.fromEntries(rows.map((r) => [r.workflow, r]));
  assert.deepEqual(Object.keys(byWorkflow).sort(), ['kit-pin-bump.yml', 'smoke.yml']);
  assert.equal(byWorkflow['kit-pin-bump.yml'].conclusion, 'failure');
  assert.equal(byWorkflow['smoke.yml'].conclusion, 'success');
  // And the age is what turns "it failed" into "it has been failing for weeks".
  assert.ok(byWorkflow['kit-pin-bump.yml'].ageDays > 1);
  assert.ok(byWorkflow['smoke.yml'].ageDays < 1);
});

test('an in-progress run never masks the completed one behind it', () => {
  // Taking a queued/in-progress run as newest would hide the failure that is
  // the whole signal, and it has no conclusion to report.
  const rows = newestScheduledPerWorkflow(
    [
      run('kit-pin-bump.yml', 'Kit pin bump', '2026-09-28T07:00:00Z', null, 'in_progress'),
      run('kit-pin-bump.yml', 'Kit pin bump', '2026-09-21T07:06:48Z', 'failure'),
    ],
    Date.parse('2026-09-28T07:01:00Z')
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].conclusion, 'failure');
});

test('no scheduled runs at all is an empty list, not an error', () => {
  assert.deepEqual(newestScheduledPerWorkflow([]), []);
  assert.deepEqual(newestScheduledPerWorkflow(undefined), []);
});

test('kit pins are read from dependencies AND devDependencies', () => {
  // A kit pins vendor-cli in `dependencies` (its vendor shim resolves the CLI
  // from inside the package); an app pins every kit in `devDependencies`.
  // Scanning one block is how a pin goes unwatched — which is what happened.
  const pins = parseKitPins({
    dependencies: { '@jfs/vendor-cli': 'github:jsvolos63/vendor-cli#276274b63dea9e88d36e70f7e77bc49e6e97e96b' },
    devDependencies: {
      '@jfs/news-kit': 'news-kit#1d8e9fc5285aceb2b25541001d2294666f163bd5',
      '@jfs/pwa-kit': 'github:jsvolos63/pwa-kit#78a7420d81944256a920a452eb1c77c4dfad3da6',
      eslint: '^10.9.1',
    },
  });
  assert.deepEqual(pins, {
    'vendor-cli': '276274b63dea9e88d36e70f7e77bc49e6e97e96b',
    'news-kit': '1d8e9fc5285aceb2b25541001d2294666f163bd5',
    'pwa-kit': '78a7420d81944256a920a452eb1c77c4dfad3da6',
  });
});

test('a pin with no resolvable SHA is omitted rather than guessed at', () => {
  assert.deepEqual(parseKitPins({ devDependencies: { '@jfs/news-kit': 'github:jsvolos63/news-kit' } }), {});
  assert.deepEqual(parseKitPins({ devDependencies: { '@jfs/news-kit': 'news-kit#main' } }), {});
  assert.deepEqual(parseKitPins({}), {});
});

test('the markdown report never presents could-not-check as a clean bill of health', () => {
  const md = renderMarkdown(
    'could-not-check',
    [],
    ['pwa-kit: /repos/x: HTTP 403'],
    [{ repo: 'pwa-kit', kind: 'kit', scheduled: [], stranded: [], stalePulls: [], stalePins: [], unchecked: ['x'] }]
  );
  assert.match(md, /Could not check/);
  assert.match(md, /not a clean bill of health/);
  assert.doesNotMatch(md, /Every repo's last scheduled run succeeded/);
});

test('a healthy report says so and lists no findings', () => {
  const md = renderMarkdown('healthy', [], [], [
    { repo: 'Weather', kind: 'app', scheduled: [{ workflow: 'kit-pin-bump.yml', conclusion: 'success', ageDays: 1 }], stranded: [], stalePulls: [], stalePins: [] },
  ]);
  assert.match(md, /Every repo's last scheduled run succeeded/);
  assert.doesNotMatch(md, /Could not check/);
  assert.match(md, /kit-pin-bump ✓/);
});

test('a stranded branch and a behind pin both reach the report body', () => {
  const md = renderMarkdown(
    'needs-attention',
    ['pwa-kit: branch `auto/kit-pin-bump` has been pushed with no open pull request'],
    [],
    [{ repo: 'pwa-kit', kind: 'kit', scheduled: [{ workflow: 'kit-pin-bump.yml', conclusion: 'failure', ageDays: 7 }], stranded: ['auto/kit-pin-bump'], stalePulls: [], stalePins: [{ kit: 'vendor-cli', sha: '276274b', behind: 8 }] }]
  );
  assert.match(md, /1 finding\b/);
  assert.match(md, /auto\/kit-pin-bump/);
  assert.match(md, /vendor-cli −8/);
  assert.match(md, /✗ failure/);
});

test('with no token the script exits 2 — never 0 — and says why', () => {
  // The load-bearing case. An unconfigured monitor reporting success is the one
  // failure mode that makes this worse than having no monitor at all.
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, FAMILY_READ_TOKEN: '', GH_TOKEN: '' },
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /COULD NOT CHECK|no FAMILY_READ_TOKEN/);
  assert.match(res.stderr, /must never read as a\s*\n?\s*healthy family|healthy family/);
});

test('--json with no token is machine-readably could-not-check, and still exits 2', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, FAMILY_READ_TOKEN: '', GH_TOKEN: '' },
  });
  assert.equal(res.status, 2);
  assert.deepEqual(JSON.parse(res.stdout), { status: 'could-not-check', reason: 'no token' });
});
