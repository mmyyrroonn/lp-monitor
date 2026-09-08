import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

function relocated() {
  const root = mkdtempSync(join(tmpdir(), 'p0-relocated-'));
  for (const directory of ['artifacts', 'scripts'])
    cpSync(directory, join(root, directory), { recursive: true });
  return root;
}
function audit(root: string, script = 'audit-p0-archive.mjs') {
  return spawnSync(
    process.execPath,
    [join(root, 'scripts', script), 'artifacts/p0/raw/2026-09-08T06-10-51-129Z/manifest.json'],
    { cwd: root, encoding: 'utf8' },
  );
}
test('relocated archive audit preserves acceptance bytes and makes no current-source claim', () => {
  const root = relocated();
  try {
    const original = readFileSync(join(root, 'artifacts/p0/acceptance.json'), 'utf8');
    // Current config/source need not exist: this command audits historical evidence only.
    const result = audit(root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const report = JSON.parse(readFileSync(join(root, 'artifacts/p0/archive-audit.json'), 'utf8'));
    expect(report.passed).toBe(true);
    expect(report.scope).toBe('historical archive audit');
    expect(report.currentSourceValidation).toBe('not performed');
    expect(report.pathBase).toBe('repository');
    expect(report.historicalAcceptanceAt).toBe(JSON.parse(original).at);
    expect(report.nextStage).toBeUndefined();
    expect(readFileSync(join(root, 'artifacts/p0/acceptance.json'), 'utf8')).toBe(original);
    expect(
      report.evidence.every(
        (file: { path: string }) => !file.path.includes('\\') && !file.path.includes(':'),
      ),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('archive audit rejects altered historical test evidence even when it still says passed', () => {
  const root = relocated();
  try {
    const path = join(root, 'artifacts/p0/tests.json');
    writeFileSync(path, readFileSync(path, 'utf8') + '\n');
    expect(audit(root).status).toBe(1);
    const report = JSON.parse(readFileSync(join(root, 'artifacts/p0/archive-audit.json'), 'utf8'));
    expect(report.gates.archivedEvidenceHashes).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('legacy acceptance entry point explicitly identifies archive-only compatibility behavior', () => {
  const root = relocated();
  try {
    const original = readFileSync(join(root, 'artifacts/p0/acceptance.json'), 'utf8');
    const result = audit(root, 'p0-acceptance.mjs');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('historical archive audit');
    expect(readFileSync(join(root, 'artifacts/p0/acceptance.json'), 'utf8')).toBe(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('archive audit diagnoses missing inputs without echoing supplied secret paths', () => {
  const result = spawnSync(
    process.execPath,
    [resolve('scripts/audit-p0-archive.mjs'), 'missing-SECRET.json'],
    { encoding: 'utf8' },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ENOENT');
  expect(result.stderr).not.toContain('SECRET');
});

test('archive audit validates identity path metadata against preserved historical bytes', () => {
  const root = relocated();
  try {
    const metadataPath = join(root, 'artifacts/p0/identity-evidence-path-metadata.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    expect(metadata.pathBase).toBe('repository');
    expect(metadata.path).toBe('artifacts/p0/identity-evidence.json');
    metadata.sha256 = '0'.repeat(64);
    writeFileSync(metadataPath, JSON.stringify(metadata));
    expect(audit(root).status).toBe(1);
    const report = JSON.parse(readFileSync(join(root, 'artifacts/p0/archive-audit.json'), 'utf8'));
    expect(report.gates.identityPathMetadata).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('evidence roots use canonical vocabulary while accepting historical aliases', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { strict as assert } from 'node:assert';
    import { join, resolve } from 'node:path';
    import { evidencePathRoot } from './scripts/evidence-paths.mjs';
    const root = resolve('artifacts/p0');
    const artifact = join(root, 'manifest.json');
    for (const base of ['artifact-directory', 'manifest-directory', 'report-directory'])
      assert.equal(evidencePathRoot(base, artifact), root);
    assert.equal(evidencePathRoot('repository', artifact), process.cwd());
    assert.throws(() => evidencePathRoot('other', artifact));
  `,
    ],
    { encoding: 'utf8' },
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});
