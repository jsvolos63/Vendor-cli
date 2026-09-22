// Tests that READ the workflows — the first in this repo that do.
//
// Four reusable workflows here carry the upkeep of fourteen repos, and until
// this file they were validated only by being executed: family-ci.yml,
// release.yml and dependabot-merge.yml by this repo's own callers, and
// kit-pin-bump.yml by NOBODY here — this repo pins no kit, so it has no caller
// of that workflow, and every edit to it is first executed in twelve consumer
// repos on a Monday morning, on a schedule whose failure notifies nobody. That
// is how it stayed broken for five weeks in four repos.
//
// A workflow run can only prove the paths it takes. What this file proves is
// the part a run cannot: that each file parses, that every input a workflow
// reads is one it declares (an undeclared `inputs.x` evaluates to '' with no
// error — a silent no-op knob), that every caller passes only declared inputs
// and every required one, that every `steps.<id>` / `needs.<job>` reference
// resolves, and the handful of step shapes the docs make promises about — the
// GITHUB_TOKEN export on both check steps (its absence in one of them cost
// JFS-Sports four silent weeks), `persist-credentials: false` on every
// checkout, the setup-node precedence trick, and the action-pinning policy.
//
// The last group holds the cross-file invariants MAINTENANCE.md listed as
// "prose only": the version guard against package.json `files`, the one Node
// version, the test list against the test files on disk, and CLAUDE.md's
// kit-pin-bump input list against the inputs the workflow actually declares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WF_DIR = join(ROOT, '.github', 'workflows');
const FILES = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const PKG = JSON.parse(read('package.json'));

// `uniqueKeys` makes a duplicated mapping key an ERROR rather than a silent
// last-one-wins, which is what GitHub's own parser refuses too.
function parse(src) {
  const doc = parseDocument(src, { uniqueKeys: true });
  return { errors: doc.errors.map((e) => e.message), value: doc.errors.length ? null : doc.toJS() };
}

const WF = Object.fromEntries(
  FILES.map((file) => {
    const src = readFileSync(join(WF_DIR, file), 'utf8');
    return [file, { file, src, ...parse(src) }];
  })
);
const wf = (file) => WF[file].value;

/** Every string leaf under `node` — where GitHub expressions live. Comments
 *  are not in the parsed tree, so prose ABOUT an input never counts as a use. */
function* strings(node) {
  if (typeof node === 'string') yield node;
  else if (Array.isArray(node)) for (const v of node) yield* strings(v);
  else if (node && typeof node === 'object') for (const v of Object.values(node)) yield* strings(v);
}

const callInputs = (w) => (w && w.on && typeof w.on === 'object' && w.on.workflow_call ? w.on.workflow_call.inputs || {} : null);
const REUSABLE = FILES.filter((f) => callInputs(wf(f)) !== null);
const allSteps = (w) => Object.values(w.jobs || {}).flatMap((j) => j.steps || []);

/** The workflow file a job's `uses:` points at, when it is one of THIS repo's:
 *  `./.github/workflows/x.yml` (the self-callers) or the `@main` spelling
 *  consumers use (kit-pin-bump.yml's release job calls release.yml that way). */
function localTarget(uses) {
  const m =
    /^\.\/\.github\/workflows\/([^@/]+)$/.exec(uses) ||
    /^jsvolos63\/vendor-cli\/\.github\/workflows\/([^@/]+)@main$/i.exec(uses);
  return m ? m[1] : null;
}

/** Check one call's `with:` against the called workflow's declared inputs. */
function checkCall(where, targetFile, withBlock) {
  const declared = callInputs(wf(targetFile));
  assert.ok(declared, `${where}: ${targetFile} is not a reusable (workflow_call) workflow`);
  const passed = withBlock || {};
  for (const [k, v] of Object.entries(passed)) {
    assert.ok(k in declared, `${where}: passes \`${k}\`, which ${targetFile} does not declare — GitHub refuses the call`);
    const type = declared[k].type;
    const isExpr = typeof v === 'string' && /^\s*\$\{\{[\s\S]*\}\}\s*$/.test(v);
    if (!isExpr) {
      assert.equal(typeof v, type, `${where}: \`${k}\` is declared ${type} in ${targetFile} but passed ${JSON.stringify(v)}`);
    }
  }
  for (const [k, spec] of Object.entries(declared)) {
    if (spec.required) assert.ok(k in passed, `${where}: omits \`${k}\`, which ${targetFile} requires`);
  }
}

// ------------------------------------------------------------------ parsing

test('every workflow file parses as YAML, with no duplicate keys', () => {
  assert.ok(FILES.length >= 8, `expected the eight workflows, found ${FILES.join(', ')}`);
  for (const f of FILES) assert.deepEqual(WF[f].errors, [], `${f} does not parse`);
  // The four this repo ships to the family must be present AND reusable; a
  // rename that dropped `workflow_call` would pass every other test vacuously.
  for (const f of ['family-ci.yml', 'kit-pin-bump.yml', 'release.yml', 'dependabot-merge.yml']) {
    assert.ok(REUSABLE.includes(f), `${f} is missing or no longer on: workflow_call`);
  }
});

// ------------------------------------------------------------------ inputs

test('every input a reusable workflow reads is one it declares, and every one it declares is read', () => {
  for (const f of REUSABLE) {
    const w = wf(f);
    const declared = new Set(Object.keys(callInputs(w)));
    const used = new Set();
    // Only where expressions are evaluated. An input's own `description` may
    // mention another input by name, and that is not a use.
    for (const s of strings([w.jobs, w.concurrency, w.env, w['run-name']])) {
      for (const m of s.matchAll(/\binputs\.([A-Za-z0-9_-]+)/g)) used.add(m[1]);
    }
    for (const name of used) {
      assert.ok(declared.has(name), `${f} reads inputs.${name}, which it never declares — it evaluates to '' with no error`);
    }
    for (const name of declared) {
      assert.ok(used.has(name), `${f} declares input \`${name}\` but nothing reads it — a knob wired to nothing`);
    }
  }
});

test('every declared input is typed and described, and its default matches its type', () => {
  for (const f of REUSABLE) {
    for (const [name, spec] of Object.entries(callInputs(wf(f)))) {
      const where = `${f} input \`${name}\``;
      assert.ok(['string', 'boolean', 'number'].includes(spec.type), `${where}: type is ${spec.type}`);
      assert.ok(typeof spec.description === 'string' && spec.description.trim(), `${where}: no description`);
      if (spec.required) {
        assert.ok(!('default' in spec), `${where}: required inputs cannot carry a default`);
      } else {
        assert.ok('default' in spec, `${where}: optional with no default — an omitted input reads as '' or false by accident`);
        assert.equal(typeof spec.default, spec.type, `${where}: default ${JSON.stringify(spec.default)} is not a ${spec.type}`);
      }
    }
  }
});

test('every call to a workflow in this repo passes only inputs it declares, and every required one', () => {
  let calls = 0;
  for (const f of FILES) {
    for (const [jobName, job] of Object.entries(wf(f).jobs || {})) {
      const target = job.uses && localTarget(job.uses);
      if (!target) continue;
      assert.ok(FILES.includes(target), `${f} job ${jobName} calls ${target}, which does not exist here`);
      checkCall(`${f} job ${jobName}`, target, job.with);
      calls++;
    }
  }
  // test.yml -> family-ci, release-self -> release, dependabot-merge-self ->
  // dependabot-merge, kit-pin-bump's release job -> release. Fewer means the
  // matcher stopped seeing calls, and every assertion above passed vacuously.
  assert.ok(calls >= 4, `found only ${calls} calls to this repo's workflows`);
});

test('the example callers in CLAUDE.md and README.md are calls the workflows would accept', () => {
  let examples = 0;
  for (const doc of ['CLAUDE.md', 'README.md']) {
    for (const m of read(doc).matchAll(/^```ya?ml\n([\s\S]*?)^```/gm)) {
      const { errors, value } = parse(m[1]);
      assert.deepEqual(errors, [], `${doc}: a yaml example does not parse`);
      for (const [jobName, job] of Object.entries((value && value.jobs) || {})) {
        const target = job.uses && localTarget(job.uses);
        if (!target) continue;
        checkCall(`${doc} example job ${jobName}`, target, job.with);
        examples++;
      }
    }
  }
  assert.ok(examples >= 1, 'CLAUDE.md\'s minimal kit-pin-bump caller was not found');
});

test('CLAUDE.md\'s kit-pin-bump input list names every input the workflow declares', () => {
  const src = read('CLAUDE.md');
  const at = src.indexOf('## Kit pin bump');
  assert.ok(at !== -1, 'CLAUDE.md has no "## Kit pin bump" section');
  const next = src.indexOf('\n## ', at + 1);
  const section = src.slice(at, next === -1 ? undefined : next);
  for (const name of Object.keys(callInputs(wf('kit-pin-bump.yml')))) {
    assert.ok(section.includes(`\`${name}\``), `CLAUDE.md's Kit pin bump section never names input \`${name}\``);
  }
});

// ------------------------------------------------------------------ references

test('every steps.<id> and needs.<job> reference resolves', () => {
  for (const f of FILES) {
    const jobs = wf(f).jobs || {};
    for (const [jobName, job] of Object.entries(jobs)) {
      const where = `${f} job ${jobName}`;
      const byId = new Map((job.steps || []).filter((s) => s.id).map((s) => [s.id, s]));
      const needs = [].concat(job.needs || []);
      for (const s of strings(job)) {
        for (const m of s.matchAll(/\bsteps\.([A-Za-z0-9_-]+)\.(outputs\.([A-Za-z0-9_-]+)|outcome|conclusion)/g)) {
          const step = byId.get(m[1]);
          assert.ok(step, `${where} reads steps.${m[1]}, but no step has that id`);
          // A `run:` step's outputs are whatever it writes to GITHUB_OUTPUT; a
          // name it never writes reads as '' forever. (An action's outputs are
          // the action's to declare.)
          if (m[3] && step.run) {
            assert.ok(step.run.includes(`${m[3]}=`), `${where} reads steps.${m[1]}.outputs.${m[3]}, which that step never writes`);
          }
        }
        for (const m of s.matchAll(/\bneeds\.([A-Za-z0-9_-]+)\.(outputs\.([A-Za-z0-9_-]+)|result)/g)) {
          assert.ok(needs.includes(m[1]), `${where} reads needs.${m[1]} without needing it`);
          assert.ok(jobs[m[1]], `${where} reads needs.${m[1]}, which is not a job`);
          if (m[3]) {
            assert.ok(m[3] in (jobs[m[1]].outputs || {}), `${where} reads needs.${m[1]}.outputs.${m[3]}, which that job does not declare`);
          }
        }
      }
    }
  }
});

test('every workflow_run trigger names a workflow that exists, and a release caller filters to main', () => {
  const names = new Set(FILES.map((f) => wf(f).name));
  let callers = 0;
  for (const f of FILES) {
    const w = wf(f);
    const trig = w.on && typeof w.on === 'object' ? w.on.workflow_run : null;
    if (!trig) continue;
    callers++;
    // A name that matches nothing is not an error anywhere — the trigger just
    // never fires: no release, no Dependabot merge, and no signal.
    for (const n of trig.workflows) assert.ok(names.has(n), `${f} waits on workflow "${n}", and no workflow here is named that`);
    const callsRelease = Object.values(w.jobs).some((j) => j.uses && localTarget(j.uses) === 'release.yml');
    if (callsRelease) {
      assert.deepEqual(trig.branches, ['main'], `${f}: the caller half of release.yml's doubled branch guard is missing`);
    }
  }
  assert.ok(callers >= 2, 'release-self.yml and dependabot-merge-self.yml should both trigger on workflow_run');
});

// ------------------------------------------------------------------ step shapes

test('both steps that run a caller\'s own checks export GITHUB_TOKEN', () => {
  // family-ci's `run` and kit-pin-bump's `check-command` are the SAME command
  // in most callers. When only one of them exported the token, a check that
  // fetched a private branch passed in CI and died in the bump — JFS-Sports,
  // four consecutive silent weeks.
  const checkSteps = [];
  for (const f of REUSABLE) {
    for (const s of allSteps(wf(f))) {
      if (typeof s.run === 'string' && /^\$\{\{\s*inputs\.(run|check-command)\s*\}\}$/.test(s.run.trim())) {
        checkSteps.push([f, s]);
      }
    }
  }
  assert.deepEqual(checkSteps.map(([f]) => f).sort(), ['family-ci.yml', 'kit-pin-bump.yml']);
  for (const [f, s] of checkSteps) {
    assert.equal(s.env && s.env.GITHUB_TOKEN, '${{ github.token }}', `${f} "${s.name}" does not export GITHUB_TOKEN`);
  }
});

test('every checkout leaves no credential behind', () => {
  let n = 0;
  for (const f of FILES) {
    for (const s of allSteps(wf(f))) {
      if (!/^actions\/checkout@/.test(s.uses || '')) continue;
      n++;
      assert.equal(s.with && s.with['persist-credentials'], false, `${f}: a checkout without persist-credentials: false`);
    }
  }
  assert.ok(n >= 6, `expected the six checkouts, found ${n}`);
});

test('a setup-node step naming a version FILE hands node-version in empty whenever the file is set', () => {
  // setup-node prefers a non-empty node-version OVER node-version-file, so
  // passing both would read the file and then silently ignore it.
  const GUARD = "${{ inputs.node-version-file == '' && inputs.node-version || '' }}";
  let n = 0;
  for (const f of FILES) {
    for (const s of allSteps(wf(f))) {
      if (!/^actions\/setup-node@/.test(s.uses || '')) continue;
      n++;
      const w = s.with || {};
      if ('node-version-file' in w && 'node-version' in w) {
        assert.equal(w['node-version'], GUARD, `${f}: setup-node passes both a version and a file without the guard`);
      }
      assert.ok('node-version-file' in w || 'node-version' in w, `${f}: setup-node with no version at all`);
    }
  }
  assert.ok(n >= 3, `expected three setup-node steps, found ${n}`);
});

test('actions follow the pinning policy: actions/* by major tag, anything else by full SHA', () => {
  // Read from the RAW text, because the version comment beside a SHA pin is
  // part of the policy and comments are not in the parsed tree. The count is
  // then held against the parsed tree, so a `uses:` the regex failed to see
  // cannot slip through unchecked.
  let rawCount = 0;
  let parsedCount = 0;
  for (const f of FILES) {
    for (const line of WF[f].src.split('\n')) {
      const m = /^\s*(?:-\s+)?uses:\s*['"]?([^\s'"#]+)['"]?\s*(?:#\s*(.*))?$/.exec(line);
      if (!m) continue;
      rawCount++;
      const [, ref, comment] = m;
      if (localTarget(ref)) continue;
      if (ref.startsWith('actions/')) {
        assert.match(ref, /^actions\/[a-z0-9-]+@v\d+$/, `${f}: first-party action not on a major tag: ${ref}`);
      } else {
        assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${f}: third-party action not pinned by full SHA: ${ref}`);
        assert.match(comment || '', /^v\d+\.\d+\.\d+$/, `${f}: SHA pin ${ref} has no "# vX.Y.Z" comment naming its version`);
      }
    }
    parsedCount += allSteps(wf(f)).filter((s) => s.uses).length;
    parsedCount += Object.values(wf(f).jobs || {}).filter((j) => j.uses).length;
  }
  assert.equal(rawCount, parsedCount, 'the raw scan and the parsed tree disagree on how many `uses:` there are');
});

test('every job runs under a timeout, and every workflow caps its token', () => {
  for (const f of FILES) {
    const w = wf(f);
    assert.ok(w.permissions && typeof w.permissions === 'object', `${f}: no top-level permissions block`);
    for (const [jobName, job] of Object.entries(w.jobs || {})) {
      if (job.uses) continue; // a called workflow's jobs carry their own
      assert.equal(typeof job['timeout-minutes'], 'number', `${f} job ${jobName}: no timeout-minutes`);
    }
  }
});

// ------------------------------------------------------------------ repo invariants

test('the version guard covers everything package.json ships', () => {
  // A path in `files` reaches every consumer through its pin; a change to it
  // with no version bump ships two different SHAs under one version label.
  // module-graph/ was missing, and v0.21.5 had to be bumped by hand for it.
  const call = wf('test.yml').jobs['family-ci'].with;
  const guarded = new Set(String(call['version-guard-paths']).split(/\s+/).filter(Boolean));
  for (const shipped of PKG.files) {
    assert.ok(guarded.has(shipped), `package.json ships \`${shipped}\` but test.yml's version-guard-paths does not guard it`);
  }
});

test('one Node: .nvmrc, the declared floor, the monitor and the reusable defaults agree', () => {
  const nvmrc = read('.nvmrc').trim();
  assert.match(nvmrc, /^\d+$/, '.nvmrc should name a bare major');
  assert.equal(PKG.engines.node, `>=${nvmrc}`, 'engines.node should be the .nvmrc major — the floor nobody tests against drifts otherwise');
  // This repo's CI and its monitor both read the file, not a literal beside it.
  assert.equal(wf('test.yml').jobs['family-ci'].with['node-version-file'], '.nvmrc');
  const liveNode = allSteps(wf('family-liveness.yml')).find((s) => /^actions\/setup-node@/.test(s.uses || ''));
  assert.deepEqual(liveNode.with, { 'node-version-file': '.nvmrc' });
  // The consumer defaults are NOT tied to this repo's .nvmrc — moving them
  // retargets every caller that never asked — but they must agree with each
  // other (they used to disagree) and never sit below the declared floor.
  const ci = callInputs(wf('family-ci.yml'))['node-version'].default;
  const bump = callInputs(wf('kit-pin-bump.yml'))['node-version'].default;
  assert.equal(ci, bump, 'family-ci and kit-pin-bump default to different Node majors');
  assert.ok(Number(ci) >= Number(nvmrc), `the reusable default (${ci}) is below the declared floor (${nvmrc})`);
});

test('npm test runs every test file on disk, and names none that is missing', () => {
  const named = PKG.scripts.test.split(/\s+/).filter((t) => t.startsWith('test/')).sort();
  const onDisk = readdirSync(join(ROOT, 'test'))
    .filter((f) => f === 'test.mjs' || f.endsWith('.test.mjs'))
    .map((f) => `test/${f}`)
    .sort();
  // The script names its files rather than globbing, so a new file that is
  // not added to it never runs — in CI or anywhere — and nothing says so.
  assert.deepEqual(named, onDisk);
});
