import assert from 'node:assert/strict';
import { test } from 'node:test';
import { same, validateEvidence, orbitResult } from '../deploy/refresh_bot.mjs';

const evidence = {
  schema: 1, version: '7.25.2', channel: 'stable', platform: 'chr-x86_64',
  archiveSha256: 'a'.repeat(64), testedCommit: 'b'.repeat(40), runId: 123, runAttempt: 1,
  testedAt: '2026-11-24T11:14:06Z', passed: 72, xfailed: 9, warnings: 7, skipped: 0,
  unexpectedFailures: 0,
};
const source = { full_name: 'greenblacked/ops-toolbox' };
const run = {
  id: 123, run_attempt: 1, repository: source, head_repository: source,
  path: '.github/workflows/routeros-version.yml', head_branch: 'master',
  event: 'schedule', status: 'completed', conclusion: 'success',
  created_at: '2026-11-24T11:00:00Z', updated_at: '2026-11-24T11:15:00Z',
};
const jobs = [{ name: 'Check, test, and propose RouterOS bump', conclusion: 'success',
  steps: [{ name: 'Test candidate on RouterOS CHR', conclusion: 'success' }] }];

test('metadata timestamp churn is not a release change', () => {
  assert.ok(same({ fetchedAt: 'x', rows: [{ checkedAt: 'x', date: 'a' }] },
    { rows: [{ date: 'a', checkedAt: 'y' }], fetchedAt: 'y' }));
  assert.ok(!same({ rows: [{ date: 'a' }] }, { rows: [{ date: 'b' }] }));
  assert.ok(!same({ cves: ['CVE-1'] }, { cves: ['CVE-2'] }));
});
test('trusted CHR evidence yields WARN, never hardware PASS', () => {
  assert.ok(validateEvidence(evidence, '7.25.2', run, jobs));
  const result = orbitResult(evidence);
  assert.equal(result.status, 'warn');
  assert.equal(result.checks.at(-1).status, 'untested');
});
test('reject mismatched, failed, skipped or untrusted evidence', () => {
  for (const patch of [{ version: '7.25.1' }, { runAttempt: 2 }, { passed: 0 },
    { unexpectedFailures: 1 }, { archiveSha256: 'x' }, { testedAt: '2026-11-25T00:00:00Z' }]) {
    assert.equal(validateEvidence({ ...evidence, ...patch }, '7.25.2', run, jobs), false);
  }
  for (const patch of [{ path: '.github/workflows/other.yml' }, { conclusion: 'failure' },
    { event: 'pull_request' }, { head_branch: 'feature/anything' }]) {
    assert.equal(validateEvidence(evidence, '7.25.2', { ...run, ...patch }, jobs), false);
  }
  assert.equal(validateEvidence(evidence, '7.25.2', run, []), false);
});

test('reject unexpected fields, non-string identifiers and unbounded counts', () => {
  for (const patch of [
    { arbitrary: 'unexpected' },
    { archiveSha256: [evidence.archiveSha256] },
    { testedCommit: [evidence.testedCommit] },
    { warnings: 1000001 },
    { testedAt: '2026-11-31T11:14:06Z' },
    { version: '7.25.2\n' },
  ]) {
    assert.equal(validateEvidence({ ...evidence, ...patch }, '7.25.2', run, jobs), false);
  }
});
