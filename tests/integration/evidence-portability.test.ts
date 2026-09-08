import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
test('archived final evidence passes offline acceptance in a relocated checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'p0-relocated-'));
  try {
    for (const directory of ['artifacts', 'config', 'scripts'])
      cpSync(directory, join(root, directory), { recursive: true });
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'scripts/p0-acceptance.mjs'),
        'artifacts/p0/raw/2026-09-08T06-10-51-129Z/manifest.json',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const report = JSON.parse(readFileSync(join(root, 'artifacts/p0/acceptance.json'), 'utf8'));
    expect(report.passed).toBe(true);
    expect(
      report.evidence.every(
        (file: { path: string }) => !file.path.includes('\\') && !file.path.includes(':'),
      ),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('acceptance diagnoses missing inputs without echoing supplied secret paths', () => {
  const result = spawnSync(
    process.execPath,
    [resolve('scripts/p0-acceptance.mjs'), 'missing-SECRET.json'],
    { encoding: 'utf8' },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ENOENT');
  expect(result.stderr).not.toContain('SECRET');
});
