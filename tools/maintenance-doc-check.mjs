#!/usr/bin/env node
// Does this repo's MAINTENANCE.md still describe this repo?
//
// WHY THIS EXISTS
// ---------------
// A maintenance doc is TRUSTED. That is its whole value and its whole danger:
// a doc naming a command that no longer exists, a test that was renamed, or a
// cron that was retired is worse than no doc, because a session will follow it
// instead of looking. And the family's own protocol says the quiet part out
// loud — an invariant whose halves live in different files belongs in a test,
// not a comment. A maintenance plan is nothing BUT such invariants: every
// command it names has its other half in package.json, every workflow in
// .github/workflows, every gate in a test file.
//
// So the doc's factual claims are checked mechanically, the same way the
// version stamp and the vendored copies are.
//
// WHAT IS CHECKED
// ---------------
//   1. Every `npm run <script>` the doc names exists in package.json.
//   2. Every `.github/workflows/<file>.yml` the doc names exists.
//   3. Every repo-relative path inside a fenced code block exists.
//   4. Every 5-field cron expression the doc quotes appears in some workflow.
//   5. The canonical family-maintenance block is present and its markers are
//      intact (its CONTENT is jfs-maintenance-sync's job, not this one's).
//
// Inline code outside fences is deliberately NOT scanned for paths: a doc
// legitimately mentions module names, globs and identifiers that are not
// files, and a check with false positives gets disabled, which is worse than
// no check.
//
// THE ALLOWLIST, AND WHY EVERY ENTRY NEEDS A REASON
// -------------------------------------------------
// Some mentions are deliberately of things that do NOT exist — recording an
// absence is one of the most useful things a maintenance doc does ("this repo
// has no release.yml, unlike its siblings"). Those go in one block at the end
// of the doc, and an entry without a reason is rejected, because an unexplained
// exception is how a check quietly stops protecting anything:
//
//   <!-- maintenance-check:allow
//   .github/workflows/release.yml  # named only to record that this repo lacks one
//   npm run version:check          # named only to say the version flows through build.js instead
//   -->
//
// EXIT CODES
//   0  every claim checks out
//   1  at least one claim is false
//   2  COULD NOT CHECK (no MAINTENANCE.md, or it is unreadable)
//
// As everywhere in this family, 2 is distinct from 0 on purpose: "the check
// could not run" must never be reportable as "the doc is accurate".
//
// USAGE
//   node tools/maintenance-doc-check.mjs [repoDir]
//   node tools/maintenance-doc-check.mjs --json

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAINT_START = '<!-- jfs-family-maintenance:start';
const MAINT_END = '<!-- jfs-family-maintenance:end -->';
const ALLOW_OPEN = '<!-- maintenance-check:allow';

/** Split the doc into the repo-specific half and the canonical block. Claims
 *  are only checked in the repo-specific half: the canonical text is identical
 *  in fourteen repos and cannot name any one repo's scripts, so scanning it
 *  would report the same phantom finding everywhere. */
export function splitDoc(src) {
  const from = src.indexOf(MAINT_START);
  const to = src.indexOf(MAINT_END);
  if (from === -1 || to === -1 || to < from) return { own: src, canonical: null };
  return { own: src.slice(0, from) + src.slice(to + MAINT_END.length), canonical: src.slice(from, to) };
}

export function parseAllowlist(src) {
  // The marker must OPEN A LINE. A doc that explains this convention mentions
  // the marker in prose — inside backticks, mid-sentence — and matching that
  // made the parser swallow the rest of the file as entries and report sixty
  // phantom findings. Caught by running this against the first doc to document
  // the allowlist; a check with false positives gets disabled, so the anchor
  // is load-bearing rather than tidy.
  const m = /^<!-- maintenance-check:allow/m.exec(src);
  if (!m) return { allow: new Set(), bad: [], unterminated: false };
  const at = m.index;
  const end = src.indexOf('-->', at);
  // An unterminated block is ONE clear finding, not a reinterpretation of every
  // line below it as an allowlist entry.
  if (end === -1) return { allow: new Set(), bad: [], unterminated: true };
  const body = src.slice(at + ALLOW_OPEN.length, end);
  const allow = new Set();
  const bad = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const hash = line.indexOf('#');
    const token = (hash === -1 ? line : line.slice(0, hash)).trim();
    const reason = hash === -1 ? '' : line.slice(hash + 1).trim();
    if (!token) continue;
    if (!reason) {
      bad.push(token);
      continue;
    }
    allow.add(token);
  }
  return { allow, bad, unterminated: false };
}

export function fencedBlocks(src) {
  const out = [];
  const re = /^```[^\n]*\n([\s\S]*?)^```/gm;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

export function findClaims(own) {
  const scripts = new Set();
  const workflows = new Set();
  const paths = new Set();
  const crons = new Set();

  // 1. `npm run x` / `npm run x -- --flag`. The doc is telling someone to run
  //    it, so the script has to be there.
  for (const m of own.matchAll(/\bnpm run ([a-z0-9](?:[a-z0-9:_-]*[a-z0-9])?)/gi)) scripts.add(m[1]);

  // 2. Workflow files, wherever they are named.
  for (const m of own.matchAll(/(?:\.github\/workflows\/)?([a-z0-9][a-z0-9._-]*\.ya?ml)/gi)) {
    const f = m[1];
    if (/^(netlify|package|package-lock)\./i.test(f)) continue;
    if (m[0].startsWith('.github/') || /^(ci|test|release|smoke|health)\b/i.test(f) || own.includes(`.github/workflows/${f}`)) {
      workflows.add(f);
    }
  }

  // 3. Paths inside fences only — see the header note on false positives.
  for (const block of fencedBlocks(own)) {
    for (const m of block.matchAll(/(?:^|[\s"'`(])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[a-z0-9]{1,5})/g)) {
      const p = m[1];
      if (p.startsWith('http') || p.includes('..') || p.startsWith('/')) continue;
      if (/^(node_modules|dist)\//.test(p)) continue;
      paths.add(p);
    }
  }

  // 4. Quoted 5-field cron expressions.
  for (const m of own.matchAll(/`([-\d*,/]+(?:\s+[-\d*,/]+){4})`/g)) crons.add(m[1].replace(/\s+/g, ' '));

  return { scripts, workflows, paths, crons };
}

export function checkRepo(dir) {
  const docPath = join(dir, 'MAINTENANCE.md');
  if (!existsSync(docPath)) return { status: 'could-not-check', reason: 'no MAINTENANCE.md', findings: [] };
  let src;
  try {
    src = readFileSync(docPath, 'utf8');
  } catch (e) {
    return { status: 'could-not-check', reason: `unreadable MAINTENANCE.md: ${e.message}`, findings: [] };
  }

  const findings = [];
  const { own, canonical } = splitDoc(src);
  if (canonical === null) {
    findings.push('the canonical family-maintenance block is missing or its markers are mangled — run `jfs-maintenance-sync`');
  }

  const { allow, bad, unterminated } = parseAllowlist(own);
  if (unterminated) findings.push('the `<!-- maintenance-check:allow` block is never closed with `-->`');
  for (const t of bad) findings.push(`allowlist entry \`${t}\` has no reason after \`#\` — an unexplained exception is how a check stops protecting anything`);

  const claims = findClaims(own);

  let pkg = null;
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch (e) {
      findings.push(`package.json did not parse (${e.message}) — every \`npm run\` claim below is unchecked`);
    }
  }

  if (pkg) {
    const have = new Set(Object.keys(pkg.scripts || {}));
    for (const s of claims.scripts) {
      if (!have.has(s) && !allow.has(`npm run ${s}`) && !allow.has(s)) {
        findings.push(`the doc says \`npm run ${s}\` but package.json has no such script`);
      }
    }
  } else if (claims.scripts.size) {
    // No package.json at all (Zepbound-): an npm command is simply wrong here.
    for (const s of claims.scripts) {
      if (!allow.has(`npm run ${s}`) && !allow.has(s)) {
        findings.push(`the doc says \`npm run ${s}\` but this repo has no package.json`);
      }
    }
  }

  for (const f of claims.workflows) {
    const rel = `.github/workflows/${f}`;
    if (!existsSync(join(dir, rel)) && !allow.has(rel) && !allow.has(f)) {
      findings.push(`the doc names \`${rel}\` but no such workflow exists`);
    }
  }

  for (const p of claims.paths) {
    if (!existsSync(join(dir, p)) && !allow.has(p)) {
      findings.push(`the doc names \`${p}\` in a code block but that path does not exist`);
    }
  }

  if (claims.crons.size) {
    let yml = '';
    for (const f of claims.workflows) {
      const rel = join(dir, '.github/workflows', f);
      if (existsSync(rel)) yml += readFileSync(rel, 'utf8');
    }
    for (const c of claims.crons) {
      if (!yml.replace(/\s+/g, ' ').includes(c) && !allow.has(c)) {
        findings.push(`the doc quotes cron \`${c}\` but no workflow it names carries it`);
      }
    }
  }

  return {
    status: findings.length ? 'findings' : 'clean',
    findings,
    counted: {
      scripts: claims.scripts.size,
      workflows: claims.workflows.size,
      paths: claims.paths.size,
      crons: claims.crons.size,
      allowed: allow.size,
    },
  };
}

function main() {
  const argv = process.argv.slice(2);
  const jsonOut = argv.includes('--json');
  const dir = resolve(argv.find((a) => !a.startsWith('--')) || process.cwd());
  const res = checkRepo(dir);
  if (jsonOut) {
    console.log(JSON.stringify({ dir, ...res }, null, 2));
  } else if (res.status === 'could-not-check') {
    console.error(`maintenance-doc-check: ${res.reason} in ${dir}`);
  } else if (res.status === 'clean') {
    const c = res.counted;
    console.log(
      `maintenance-doc-check: MAINTENANCE.md checks out — ${c.scripts} npm scripts, ` +
      `${c.workflows} workflows, ${c.paths} paths, ${c.crons} crons verified` +
      (c.allowed ? `, ${c.allowed} allowlisted` : '')
    );
  } else {
    console.error(`maintenance-doc-check: ${res.findings.length} false or unverifiable claim(s) in MAINTENANCE.md\n`);
    for (const f of res.findings) console.error(`  ! ${f}`);
    console.error('\n  Correct the claim, or — if the mention is deliberately of something absent —');
    console.error('  add it to the `<!-- maintenance-check:allow` block WITH a reason after `#`.');
  }
  process.exit(res.status === 'could-not-check' ? 2 : res.status === 'findings' ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
