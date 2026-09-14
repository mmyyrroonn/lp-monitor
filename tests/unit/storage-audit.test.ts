import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import { auditStorage } from '../../src/ops/storage-audit.js';

test('storage audit reports database tables, payload bytes and artifacts without writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-storage-audit-'));
  const databasePath = join(dir, 'recorder.sqlite');
  const artifacts = join(dir, 'artifacts');
  mkdirSync(artifacts);
  writeFileSync(join(artifacts, 'one.json'), '12345');
  const db = openDatabase(databasePath);
  try {
    db.prepare(
      'insert into scope_cursors(scope_id,block_number,block_hash,timestamp_sec) values(?,?,?,?)',
    ).run('scope', 1, '0x1', 3_600);
    db.prepare(
      'insert into scope_cursors(scope_id,block_number,block_hash,timestamp_sec) values(?,?,?,?)',
    ).run('scope-2', 2, '0x2', 7_200);
  } finally {
    db.close();
  }
  try {
    const before = auditStorage(databasePath, artifacts);
    const after = auditStorage(databasePath, artifacts);
    expect(before.artifactBytes).toBe(5);
    expect(before.databaseBytes).toBeGreaterThan(0);
    expect(before.tables.some((table) => table.name === 'payload_objects')).toBe(true);
    expect(before.coverageHours).toBe(1);
    expect(before.rawPayloadBytes).toBe(0);
    expect(after.sampledAtMs).toBeGreaterThanOrEqual(before.sampledAtMs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('storage audit makes missing artifact input explicit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-storage-audit-missing-'));
  const databasePath = join(dir, 'recorder.sqlite');
  const db = openDatabase(databasePath);
  db.close();
  try {
    const result = auditStorage(databasePath, join(dir, 'missing'));
    expect(result.artifactBytes).toBe(0);
    expect(result.notes).toContain('Artifact directory does not exist');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
