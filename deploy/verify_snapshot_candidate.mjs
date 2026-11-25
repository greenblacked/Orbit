// Compare an existing proposal with the staged candidate without checking out its tree.
import { execFileSync } from 'node:child_process';
import { same } from './refresh_bot.mjs';

const [expected, tip, ...paths] = process.argv.slice(2);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const changes = git('diff-tree', '-r', '-t', '--raw', '--no-abbrev', '--no-renames', '--no-commit-id',
  '-z', expected, tip).split('\0');
for (let i = 0; i < changes.length - 1; i += 2) {
  const [metadata, path] = changes.slice(i, i + 2);
  if (/^:040000 040000 [a-f0-9]+ [a-f0-9]+ M$/.test(metadata) &&
      paths.some((allowed) => allowed.startsWith(path + '/'))) continue;
  // Only regular JSON blobs of the same mode may differ, and only by canonical metadata.
  if (!paths.includes(path) || !/^:100644 100644 [a-f0-9]+ [a-f0-9]+ M$/.test(metadata) ||
      !same(JSON.parse(git('show', expected + ':' + path)),
        JSON.parse(git('show', tip + ':' + path)))) {
    throw new Error('Existing proposal does not match the generated candidate');
  }
}
