// Refresh automation glue. Vendor parsing stays in the existing snapshot scripts.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE = 'greenblacked/ops-toolbox';
const VERSION = /^[0-9]{1,3}\.[0-9]{1,3}(?:\.[0-9]{1,4})?$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const VOLATILE = new Set(['fetchedAt', 'generatedAt', 'checkedAt']);
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
// Generated data is JSON only, never downloaded executable bytes. Exclusive creation
// also refuses to overwrite an existing file or follow a final-component symlink.
function writeJson(path, value) {
  if (!path.endsWith('.json')) throw new Error('refusing non-JSON output');
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
}

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
const exact = (value, pattern) => typeof value === 'string' && pattern.test(value) &&
  !/[\r\n]/.test(value);
const FIELDS = ['archiveSha256', 'channel', 'passed', 'platform', 'runAttempt', 'runId',
  'schema', 'skipped', 'testedAt', 'testedCommit', 'unexpectedFailures', 'version',
  'warnings', 'xfailed'].sort();
const positive = (n) => integer(n) && n > 0;

export function validateEvidence(e, version, run, jobs) {
  if (!exact(version, VERSION) || !e || typeof e !== 'object' || Array.isArray(e) ||
      Object.keys(e).sort().join(',') !== FIELDS.join(',') ||
      e.schema !== 1 || e.version !== version ||
      e.channel !== 'stable' || e.platform !== 'chr-x86_64' ||
      !exact(e.archiveSha256, DIGEST) || !exact(e.testedCommit, SHA) ||
      !positive(e.runId) || !positive(e.runAttempt) ||
      !exact(e.testedAt, UTC) || !Number.isFinite(Date.parse(e.testedAt)) ||
      new Date(e.testedAt).toISOString().replace('.000Z', 'Z') !== e.testedAt ||
      !positive(e.passed) || !integer(e.xfailed) || !integer(e.warnings) ||
      !integer(e.skipped) || [e.passed, e.xfailed, e.warnings, e.skipped].some((n) => n > 1000000) ||
      e.unexpectedFailures !== 0) return false;
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
  if (!/^application\/(?:vnd\.github\+)?json\b/i.test(response.headers.get('content-type') || '')) {
    throw new Error('unexpected upstream content type');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > 2 * 1024 * 1024) throw new Error('upstream evidence response too large');
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

async function findEvidence(version) {
  if (!exact(version, VERSION)) return null;
  const ref = await github('branches/dev');
  const sha = ref?.commit?.sha;
  if (!exact(sha, SHA)) return null;
  const file = await github('contents/mikrotik/tests/evidence/' + version + '.json?ref=' + sha, true);
  if (!file || file.type !== 'file' || file.encoding !== 'base64' ||
      !positive(file.size) || file.size > 16384 || typeof file.content !== 'string' ||
      file.content.length > 24000) return null;
  const bytes = Buffer.from(file.content, 'base64');
  if (bytes.length !== file.size) return null;
  const evidence = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!positive(evidence.runId) || !positive(evidence.runAttempt)) return null;
  const run = await github('actions/runs/' + evidence.runId);
  const jobs = await github('actions/runs/' + evidence.runId + '/attempts/' +
    evidence.runAttempt + '/jobs?per_page=100');
  if (!validateEvidence(evidence, version, run, jobs.jobs)) return null;
  // The evidence's tested source must be in the reviewed branch history.
  // The scheduled workflow is defined on master but checks out dev for testing.
  const ancestry = await github('compare/' + evidence.testedCommit + '...' + sha);
  if (!['ahead', 'identical'].includes(ancestry.status)) return null;
  return evidence;
}

async function main() {
  const [before, output] = process.argv.slice(2);
  const releases = read('src/data/releases.json');
  const security = read('src/data/security.json');
  const stable = releases.releases.find((row) => row.vendor === 'mikrotik' &&
    row.family === 'RouterOS' && row.stage === 'release' && row.line === 'stable');
  let result = null;
  let version = '';
  if (stable && exact(stable.version, VERSION) && stable.build === stable.version) {
    const directory = 'results/mikrotik/RouterOS';
    const path = join(directory, stable.version + '.json');
    if (!existsSync(path) && !existsSync(join(directory, stable.version))) {
      try {
        const evidence = await findEvidence(stable.version);
        if (evidence) {
          result = orbitResult(evidence);
          version = stable.version;
          mkdirSync(directory, { recursive: true });
          writeJson(path, result);
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
  writeJson(join(output, 'releases.json'), releases);
  writeJson(join(output, 'security.json'), security);
  if (result) writeJson(join(output, 'result.json'), result);
  console.log('candidate=' + key);
  console.log('result_version=' + version);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
