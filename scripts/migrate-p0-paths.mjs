import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
if (existsSync('artifacts/p0/path-migration-2026-09-08.json'))
  throw new Error('Migration already recorded; refusing to overwrite provenance');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = execFileSync('git', ['ls-files', 'artifacts'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(
    (path) =>
      path.endsWith('.json') &&
      !/\/(logs|anchors|time-boundaries|.*\.logs)\.json$/.test(path) &&
      !path.includes('/upstream/'),
  );
const changes = [];
function migrate(value) {
  if (typeof value === 'string')
    return value.replace(/^E:[\\/]lp-monitor[\\/]/i, '').replaceAll('\\', '/');
  if (Array.isArray(value)) return value.map(migrate);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        ['path', 'file', 'evidenceFile', 'name'].includes(key)
          ? migrate(child)
          : typeof child === 'object'
            ? migrate(child)
            : child,
      ]),
    );
  return value;
}
for (const path of files.filter((path) => !path.endsWith('/acceptance.json'))) {
  const original = readFileSync(path);
  const parsed = JSON.parse(original.toString());
  const result = migrate(parsed);
  if (path.endsWith('/manifest.json') || path.endsWith('/capabilities.json'))
    result.pathBase = 'repository';
  if (path.endsWith('/dependency-evidence.json'))
    for (const entry of result.entries)
      if (entry.importTest?.result === 'passed') {
        entry.importTest.result = 'historically-declared-passed';
        entry.importTest.provenance =
          'Legacy generator --verified flag did not execute tests; retained as declaration only.';
      }
  if (JSON.stringify(result) !== JSON.stringify(parsed)) {
    const bytes = JSON.stringify(result, null, 2) + '\n';
    writeFileSync(path, bytes);
    changes.push({ path, beforeSha256: hash(original), afterSha256: hash(bytes) });
  }
}
const path = 'artifacts/p0/acceptance.json';
const original = readFileSync(path);
const result = migrate(JSON.parse(original.toString()));
for (const file of result.evidence) file.sha256 = hash(readFileSync(file.path));
result.pathBase = 'repository';
result.metadataMigration = 'artifacts/p0/path-migration-2026-09-08.json';
const bytes = JSON.stringify(result, null, 2) + '\n';
writeFileSync(path, bytes);
changes.push({ path, beforeSha256: hash(original), afterSha256: hash(bytes) });
writeFileSync(
  'artifacts/p0/path-migration-2026-09-08.json',
  JSON.stringify(
    {
      at: new Date().toISOString(),
      reason:
        'Portable POSIX repository-relative metadata; historical verification declarations clarified. Raw logs and RPC requests unchanged. Source snapshot hashes retain their historical meaning; this is not a new live capture or verification.',
      changes,
    },
    null,
    2,
  ) + '\n',
);
