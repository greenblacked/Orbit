import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { canonical } from '../deploy/refresh_bot.mjs';

const workflow = readFileSync(new URL('../.github/workflows/release-validation-bot.yml',
  import.meta.url), 'utf8');
const proposal = workflow.split('      - name: Open reviewed snapshot proposal\n')[1]
  .split('\n  validate:')[0].split('        run: |\n')[1]
  .split('\n').map((line) => line.slice(10)).join('\n');

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-proposal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const origin = pathToFileURL(remote).href;
  const seed = join(root, 'seed');
  const bin = join(root, 'bin');
  const candidate = join(root, 'candidate');
  mkdirSync(bin);
  mkdirSync(candidate);
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(root, 'init', '-q', '--bare', remote);
  git(root, 'init', '-q', '-b', 'dev', seed);
  mkdirSync(join(seed, 'src/data'), { recursive: true });
  mkdirSync(join(seed, 'deploy'));
  for (const file of ['refresh_bot.mjs', 'verify_snapshot_candidate.mjs']) {
    cpSync(new URL('../deploy/' + file, import.meta.url), join(seed, 'deploy', file));
  }
  writeFileSync(join(seed, 'src/data/releases.json'), '{"releases":[]}');
  writeFileSync(join(seed, 'src/data/security.json'), '{"security":[]}');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'Base');
  const base = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'push', origin, 'dev');
  const log = join(root, 'gh.log');
  const output = join(root, 'output');
  writeFileSync(join(bin, 'gh'), `#!/bin/bash
set -eu
case "$1 $2" in
  "pr list") if [[ "$*" == *"--state open"* ]]; then
      printf '%s\\n' "$MOCK_OPEN"
    else
      printf '%s\\n' "$MOCK_SEEN"
    fi ;;
  "api repos/example/Orbit/actions/permissions/workflow")
    if [[ "$MOCK_CAPABILITY" == forbidden ]]; then echo 'HTTP 403' >&2; exit 1; fi
    printf '%s\\n' "$MOCK_CAPABILITY" ;;
  "pr create")
    echo create >> "$MOCK_LOG"
    if [[ "$MOCK_CREATE" == fail ]]; then echo 'PR creation denied' >&2; exit 1; fi ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
  function generate(timestamp) {
    const releases = { fetchedAt: timestamp, releases: [{ version: '7.25.2' }] };
    const security = { generatedAt: timestamp, security: [{ checkedAt: timestamp, id: 'one' }] };
    const result = { status: 'warn' };
    writeFileSync(join(candidate, 'releases.json'), JSON.stringify(releases));
    writeFileSync(join(candidate, 'security.json'), JSON.stringify(security));
    writeFileSync(join(candidate, 'result.json'), JSON.stringify(result));
    return createHash('sha256').update(JSON.stringify(canonical({ releases, security, result })))
      .digest('hex').slice(0, 24);
  }
  const key = generate('first');
  const branch = 'chore/snapshot-' + key;
  const ref = 'refs/heads/' + branch;

  let runCount = 0;
  function run(overrides = {}) {
    const checkout = join(root, 'run-' + ++runCount);
    git(root, 'clone', '--depth=1', '--branch=dev', origin, checkout);
    writeFileSync(output, '');
    return spawnSync('bash', ['-c', proposal], {
      cwd: checkout, encoding: 'utf8',
      env: { ...process.env, PATH: bin + ':' + process.env.PATH,
        GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'example/Orbit',
        GITHUB_SERVER_URL: 'https://github.example', GITHUB_RUN_ID: '1',
        GH_TOKEN: 'mock-token', RUNNER_TEMP: root, BASE_SHA: base,
        CANDIDATE: key, RESULT_VERSION: '7.25.2',
        MOCK_OPEN: '0', MOCK_SEEN: '0', MOCK_CAPABILITY: 'true', MOCK_CREATE: 'ok', MOCK_LOG: log,
        ...overrides },
    });
  }
  function tip() {
    return git(seed, 'ls-remote', origin, ref).split('\t')[0];
  }
  return { seed, origin, git, base, branch, ref, key, tip, generate, run, log, output };
}

test('PR creation failure leaves a candidate which a fresh run resumes after timestamp churn', (t) => {
  const env = setup(t);
  const first = env.run({ MOCK_CAPABILITY: 'forbidden', MOCK_CREATE: 'fail' });
  assert.equal(first.status, 1);
  assert.match(first.stdout, /capability could not be read/);
  assert.match(first.stderr, /PR creation denied/);
  const pushed = env.tip();
  assert.match(pushed, /^[0-9a-f]{40}$/);
  assert.equal(readFileSync(env.output, 'utf8'), '');

  assert.equal(env.generate('retry'), env.key);
  const retry = env.run();
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(env.tip(), pushed);
  assert.equal(readFileSync(env.log, 'utf8'), 'create\ncreate\n');
  assert.equal(readFileSync(env.output, 'utf8'), 'branch=' + env.branch + '\n');
});

for (const mismatch of ['candidate JSON', 'extra path', 'file mode', 'wrong parent']) {
  test('refuse to reuse a proposal with ' + mismatch, (t) => {
    const env = setup(t);
    const first = env.run({ MOCK_CREATE: 'fail' });
    assert.equal(first.status, 1);
    const { git, seed, origin, ref } = env;
    git(seed, 'fetch', origin, ref);
    git(seed, 'checkout', '--detach', 'FETCH_HEAD');
    if (mismatch === 'candidate JSON') {
      writeFileSync(join(seed, 'src/data/security.json'), '{"security":[{"id":"different"}]}');
    } else if (mismatch === 'extra path' || mismatch === 'wrong parent') {
      writeFileSync(join(seed, 'unexpected.txt'), 'unexpected');
    }
    git(seed, 'add', '.');
    if (mismatch === 'file mode') git(seed, 'update-index', '--chmod=+x', 'src/data/security.json');
    const tree = git(seed, 'write-tree');
    const parent = mismatch === 'wrong parent' ? 'HEAD' : env.base;
    const wrongTip = git(seed, 'commit-tree', tree, '-p', parent, '-m', 'Mismatching candidate');
    git(join(seed, '..', 'remote.git'), 'fetch', '--no-tags', pathToFileURL(seed).href, wrongTip);
    // Set the fixture ref directly in the isolated bare repository.
    git(join(seed, '..', 'remote.git'), 'update-ref', ref, wrongTip);
    const retry = env.run();
    assert.equal(retry.status, 1, retry.stderr);
    assert.equal(env.tip(), wrongTip);
    assert.equal(readFileSync(env.log, 'utf8'), 'create\n');
    assert.equal(readFileSync(env.output, 'utf8'), '');
  });
}

test('known disabled capability stops before pushing', (t) => {
  const env = setup(t);
  const run = env.run({ MOCK_CAPABILITY: 'false' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /Enable GitHub Actions/);
  assert.equal(env.tip(), '');
  assert.throws(() => readFileSync(env.log), { code: 'ENOENT' });
});

for (const [setting, message] of [
  ['MOCK_OPEN', /existing snapshot proposal/],
  ['MOCK_SEEN', /already has a review decision/],
]) {
  test('deduplicate proposals via ' + setting, (t) => {
    const env = setup(t);
    const run = env.run({ [setting]: '1' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, message);
    assert.equal(env.tip(), '');
    assert.throws(() => readFileSync(env.log), { code: 'ENOENT' });
  });
}
