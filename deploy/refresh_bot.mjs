// Refresh automation glue. Vendor parsing stays in the existing snapshot scripts.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE = 'greenblacked/ops-toolbox';
const VERSION = /^\d+\.\d+(?:\.\d+)?$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const VOLATILE = new Set(['fetchedAt', 'generatedAt', 'checkedAt']);
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().filter((k) => !VOLATILE.has(k))
      .map((k) => [k, canonical(value[k])]));
  }
  return value;
}
export const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const positive = (n) => integer(n) && n > 0;

export function validateEvidence(e, version, run, jobs) {
  if (!VERSION.test(version) || !e || e.schema !== 1 || e.version !== version ||
      e.channel !== 'stable' || e.platform !== 'chr-x86_64' ||
      !DIGEST.test(e.archiveSha256 || '') || !SHA.test(e.testedCommit || '') ||
      !positive(e.runId) || !positive(e.runAttempt) ||
      !UTC.test(e.testedAt || '') || !Number.isFinite(Date.parse(e.testedAt)) ||
      !positive(e.passed) || !integer(e.xfailed) || !integer(e.warnings) ||
      !integer(e.skipped) || e.unexpectedFailures !== 0) return false;
  if (!run || run.id !== e.runId || run.run_attempt !== e.runAttempt ||
      run.repository?.full_name !== SOURCE || run.head_repository?.full_name !== SOURCE ||
      run.path !== '.github/workflows/routeros-version.yml' ||
      !['master', 'dev'].includes(run.head_branch) ||
      !['schedule', 'workflow_dispatch'].includes(run.event) ||
      run.status !== 'completed' || run.conclusion !== 'success') return false;
  const tested = Date.parse(e.testedAt);
  if (!(tested >= Date.parse(run.created_at) && tested <= Date.parse(run.updated_at))) return false;
  return Array.isArray(jobs) && jobs.some((job) =>
    job.name === 'Check, test, and propose RouterOS bump' && job.conclusion === 'success' &&
    job.steps?.some((step) => step.name === 'Test candidate on RouterOS CHR' &&
      step.conclusion === 'success'));
}

export function orbitResult(e) {
  return {
    vendor: 'mikrotik', family: 'RouterOS', build: e.version, version: e.version,
    stage: 'release', status: 'warn',
    checks: [
      { name: 'RouterOS CHR x86_64 candidate integration suite', status: 'pass',
        detail: e.passed + ' passed, ' + e.xfailed + ' expected failures, ' + e.warnings +
          ' warnings, ' + e.skipped + ' skipped; no unexpected failures' },
      { name: 'Candidate archive digest pinned', status: 'pass',
        detail: 'SHA-256 ' + e.archiveSha256 + '; tested commit ' + e.testedCommit },
      { name: 'Physical hardware, Wi-Fi, RouterBOOT and deployment-specific configuration',
        status: 'untested', detail: 'Virtual CHR evidence only; no physical router validation' },
    ],
    testedAt: e.testedAt,
    runner: 'GitHub Actions ops-toolbox run ' + e.runId + ' attempt ' + e.runAttempt,
  };
}

// Only read fixed GitHub API endpoints for the public, reviewed upstream repository.
// No cross-repository credentials, arbitrary URL from evidence, or executable downloads.
async function github(path, optional = false) {
  const response = await fetch('https://api.github.com/repos/' + SOURCE + '/' + path, {
    redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'orbit-release-validation' },
  });
  if (optional && response.status === 404) return null;
  if (!response.ok) throw new Error('upstream evidence API unavailable');
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) throw new Error('upstream evidence response too large');
  return JSON.parse(text);
}

async function findEvidence(version) {
  if (!VERSION.test(version)) return null;
  const ref = await github('branches/dev');
  const sha = ref?.commit?.sha;
  if (!SHA.test(sha || '')) return null;
  const file = await github('contents/mikrotik/tests/evidence/' + version + '.json?ref=' + sha, true);
  if (!file || file.encoding !== 'base64' || file.size > 16384) return null;
  const evidence = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  if (!positive(evidence.runId) || !positive(evidence.runAttempt)) return null;
  const run = await github('actions/runs/' + evidence.runId);
  const jobs = await github('actions/runs/' + evidence.runId + '/attempts/' +
    evidence.runAttempt + '/jobs?per_page=100');
  return validateEvidence(evidence, version, run, jobs.jobs) ? evidence : null;
}

async function main() {
  const [before, output] = process.argv.slice(2);
  const releases = read('src/data/releases.json');
  const security = read('src/data/security.json');
  const stable = releases.releases.find((row) => row.vendor === 'mikrotik' &&
    row.family === 'RouterOS' && row.stage === 'release' && row.line === 'stable');
  let result = null;
  let version = '';
  if (stable && VERSION.test(stable.version) && stable.build === stable.version) {
    const directory = 'results/mikrotik/RouterOS';
    const path = join(directory, stable.version + '.json');
    if (!existsSync(path) && !existsSync(join(directory, stable.version))) {
      try {
        const evidence = await findEvidence(stable.version);
        if (evidence) {
          result = orbitResult(evidence);
          version = stable.version;
          mkdirSync(directory, { recursive: true });
          write(path, result);
        }
      } catch {
        // A transient evidence-source failure must not invent PASS or block vendor data.
        console.error('CHR evidence unavailable; hardware remains untested');
      }
    }
  }
  const changed = !same(releases, read(join(before, 'releases.json'))) ||
    !same(security, read(join(before, 'security.json'))) || result !== null;
  console.log('changed=' + changed);
  if (!changed) return;
  const key = createHash('sha256').update(JSON.stringify(canonical({ releases, security, result })))
    .digest('hex').slice(0, 24);
  mkdirSync(output, { recursive: true });
  write(join(output, 'releases.json'), releases);
  write(join(output, 'security.json'), security);
  if (result) write(join(output, 'result.json'), result);
  console.log('candidate=' + key);
  console.log('result_version=' + version);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
