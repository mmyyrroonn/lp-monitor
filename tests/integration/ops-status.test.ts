import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import { backupDatabase, inspectDatabaseStatus } from '../../src/ops/status.js';
import { runStatusCli } from '../../src/ops/status-cli.js';

const roots: string[] = [];
afterEach(() => roots.splice(0));

test('offline status opens read-only, reports persisted facts, and does not project stale cursor', () => {
  const root = mkdtempSync(join(tmpdir(), 'lp-status-'));
  roots.push(root);
  const path = join(root, 'live.sqlite');
  const db = openDatabase(path);
  db.prepare('insert into scope_cursors values(?,?,?,?)').run('s', 8, '0x8', 80);
  db.prepare(
    `insert into projection_cursors(scope_id,registry_scope_id,projection_version,config_version,source_hash,batch_id,block_number,block_hash,payload_json)
     values(?,?,?,?,?,?,?,?,?)`,
  ).run('s', 'r', 'v', 'c', 'old-source', 'b', 8, '0x8', '{}');
  db.prepare(
    "insert into alert_outbox(scope_id,alert_id,revision,capture_mode,status,payload_json) values('s','a',1,'live','pending','{}')",
  ).run();
  db.close();
  const before = readFileSync(path);
  const status = inspectDatabaseStatus(path, { scopeId: 's', sourceAlias: 'offline' });
  expect(status).toMatchObject({
    sourceAlias: 'offline',
    head: null,
    scanned: { blockNumber: 8n, blockHash: '0x8', timestampSec: 80 },
    projected: null,
    outboxPending: 1,
  });
  expect(readFileSync(path)).toEqual(before);
});

test('status rehydrates encoded sidecar bigint but rejects stale projection freshness', () => {
  const root = mkdtempSync(join(tmpdir(), 'lp-sidecar-'));
  roots.push(root);
  const path = join(root, 'live.sqlite');
  const db = openDatabase(path);
  db.prepare('insert into scope_cursors values(?,?,?,?)').run('s', 8, '0x8', 80);
  db.prepare(
    'insert into projection_cursors(scope_id,registry_scope_id,projection_version,config_version,source_hash,batch_id,block_number,block_hash,payload_json) values(?,?,?,?,?,?,?,?,?)',
  ).run('s', 'r', 'v', 'c', 'source', 'b', 8, '0x8', '{}');
  db.close();
  writeFileSync(
    path + '.health.json',
    JSON.stringify({
      databasePath: path,
      scopeId: 's',
      sourceAlias: 'safe-alias',
      chainId: 4665,
      head: { blockNumber: '10', blockHash: '0x10', timestampSec: 100 },
      lastHeadAtMs: 123,
      scanned: { blockNumber: '7', blockHash: '0x7', timestampSec: 70 },
      projected: { blockNumber: '8', blockHash: '0x8', timestampSec: 80 },
      projectedSourceVerified: true,
    }),
  );
  const status = inspectDatabaseStatus(path, { scopeId: 's', nowMs: 1123 });
  expect(status.head).toEqual({ blockNumber: 10n, blockHash: '0x10', timestampSec: 100 });
  expect(status.sourceAlias).toBe('safe-alias');
  expect(status).toMatchObject({ headStatus: 'observed', headObservationAgeMs: 1000 });
  expect(status.projected).toBeNull();
});
test('status rehydrates encoded sidecar bigint but rejects stale projection freshness', () => {
  const root = mkdtempSync(join(tmpdir(), 'lp-sidecar-'));
  roots.push(root);
  const path = join(root, 'live.sqlite');
  const db = openDatabase(path);
  db.prepare('insert into scope_cursors values(?,?,?,?)').run('s', 8, '0x8', 80);
  db.prepare(
    'insert into projection_cursors(scope_id,registry_scope_id,projection_version,config_version,source_hash,batch_id,block_number,block_hash,payload_json) values(?,?,?,?,?,?,?,?,?)',
  ).run('s', 'r', 'v', 'c', 'source', 'b', 8, '0x8', '{}');
  db.close();
  writeFileSync(
    path + '.health.json',
    JSON.stringify({
      databasePath: path,
      scopeId: 's',
      sourceAlias: 'safe-alias',
      chainId: 4665,
      head: { blockNumber: '10', blockHash: '0x10', timestampSec: 100 },
      lastHeadAtMs: 123,
      scanned: { blockNumber: '7', blockHash: '0x7', timestampSec: 70 },
      projected: { blockNumber: '8', blockHash: '0x8', timestampSec: 80 },
      projectedSourceVerified: true,
    }),
  );
  const status = inspectDatabaseStatus(path, { scopeId: 's' });
  expect(status.head).toEqual({ blockNumber: 10n, blockHash: '0x10', timestampSec: 100 });
  expect(status.sourceAlias).toBe('safe-alias');
  expect(status.projected).toBeNull();
  writeFileSync(
    path + '.health.json',
    JSON.stringify({
      databasePath: path,
      scopeId: 's',
      scanned: { blockNumber: '8', blockHash: '0x8', timestampSec: 80 },
      projected: { blockNumber: '8', blockHash: '0x8', timestampSec: 80 },
      projectedSourceVerified: true,
      projectionSourceHash: 'wrong',
    }),
  );
  expect(inspectDatabaseStatus(path, { scopeId: 's' }).projected).toBeNull();
  writeFileSync(
    path + '.health.json',
    JSON.stringify({
      databasePath: path,
      scopeId: 's',
      scanned: { blockNumber: '8', blockHash: '0x8', timestampSec: 80 },
      projected: { blockNumber: '8', blockHash: '0x8', timestampSec: 80 },
      projectedSourceVerified: true,
      projectionSourceHash: 'source',
    }),
  );
  expect(inspectDatabaseStatus(path, { scopeId: 's' }).projected).toMatchObject({
    blockNumber: 8n,
  });
});
test('SQLite backup includes committed WAL state and refuses overwrite hazards', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lp-backup-'));
  roots.push(root);
  const source = join(root, 'source.sqlite');
  const target = join(root, 'backup.sqlite');
  const db = openDatabase(source);
  db.prepare('insert into scope_cursors values(?,?,?,?)').run('s', 9, '0x9', 90);
  await backupDatabase(source, target);
  const copy = openDatabase(target, { readonly: true });
  expect(copy.prepare('select block_number from scope_cursors').get()).toEqual({ block_number: 9 });
  copy.close();
  expect(statSync(target).size).toBeGreaterThan(0);
  await expect(backupDatabase(source, source)).rejects.toThrow('source and target');
  writeFileSync(join(root, 'exists.sqlite'), 'occupied');
  await expect(backupDatabase(source, join(root, 'exists.sqlite'))).rejects.toThrow(
    'already exists',
  );
  db.close();
});

test('status CLI emits JSON and backup CLI creates a non-overwriting SQLite backup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lp-status-cli-'));
  const source = join(root, 'source.sqlite');
  const target = join(root, 'target.sqlite');
  const db = openDatabase(source);
  db.close();
  const lines: string[] = [];
  expect(
    await runStatusCli(['status', '--db', source, '--scope', 's'], {}, (line) => lines.push(line)),
  ).toBe(0);
  expect(JSON.parse(lines[0]!)).toMatchObject({ sourceAlias: 'unknown', head: null });
  expect(
    await runStatusCli(['backup', '--db', source, '--out', target], {}, (line) => lines.push(line)),
  ).toBe(0);
  expect(JSON.parse(lines[1]!)).toMatchObject({ status: 'complete', target });
  await expect(
    runStatusCli(['backup', '--db', source, '--out', target], {}, () => {}),
  ).rejects.toThrow('already exists');
});

test('status CLI infers scope only from the matching default health sidecar', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lp-status-scope-'));
  const database = join(root, 'source.sqlite');
  const db = openDatabase(database);
  db.prepare('insert into scope_cursors values(?,?,?,?)').run('scope-from-sidecar', 3, '0x3', 30);
  db.close();
  writeFileSync(
    database + '.health.json',
    JSON.stringify({
      databasePath: database,
      scopeId: 'scope-from-sidecar',
      sourceAlias: 'saved-alias',
    }),
  );
  const lines: string[] = [];
  expect(await runStatusCli(['status', '--db', database], {}, (line) => lines.push(line))).toBe(0);
  expect(JSON.parse(lines[0]!)).toMatchObject({
    sourceAlias: 'saved-alias',
    scanned: { blockNumber: '3' },
  });
  writeFileSync(
    database + '.health.json',
    JSON.stringify({ databasePath: join(root, 'other.sqlite'), scopeId: 'unrelated' }),
  );
  await expect(runStatusCli(['status', '--db', database], {}, () => {})).rejects.toThrow(
    '--scope is required',
  );
});

test('status exposes sidecar age, accepts starting, and marks stale active observations', () => {
  const root = mkdtempSync(join(tmpdir(), 'lp-status-freshness-'));
  const path = join(root, 'live.sqlite');
  const db = openDatabase(path);
  db.close();
  const write = (sampledAtMs: number, runtimeState: string) =>
    writeFileSync(
      path + '.health.json',
      JSON.stringify({
        databasePath: path,
        scopeId: 's',
        sampledAtMs,
        runtimeState,
        queueDepth: 7,
      }),
    );

  write(10_000, 'starting');
  expect(inspectDatabaseStatus(path, { scopeId: 's', nowMs: 10_500 })).toMatchObject({
    runtimeState: 'starting',
    observedRuntimeState: 'starting',
    sidecarSampledAtMs: 10_000,
    sidecarAgeMs: 500,
    sidecarFreshness: 'fresh',
    queueDepth: 7,
  });

  expect(
    inspectDatabaseStatus(path, { scopeId: 's', nowMs: 10_500, staleAfterMs: 100 }),
  ).toMatchObject({
    runtimeState: 'stale',
    observedRuntimeState: 'starting',
    sidecarAgeMs: 500,
    sidecarFreshness: 'stale',
    queueDepth: 7,
  });

  write(11_000, 'healthy');
  expect(inspectDatabaseStatus(path, { scopeId: 's', nowMs: 10_500 })).toMatchObject({
    runtimeState: 'stale',
    observedRuntimeState: 'healthy',
    sidecarAgeMs: null,
    sidecarFreshness: 'invalid',
  });
});

test('status preserves stale terminal history but never trusts an unbound sidecar', () => {
  const root = mkdtempSync(join(tmpdir(), 'lp-status-binding-'));
  const path = join(root, 'live.sqlite');
  const db = openDatabase(path);
  db.close();
  writeFileSync(
    path + '.health.json',
    JSON.stringify({ databasePath: path, scopeId: 's', sampledAtMs: 1, runtimeState: 'complete' }),
  );
  expect(inspectDatabaseStatus(path, { scopeId: 's', nowMs: 100_000 })).toMatchObject({
    runtimeState: 'complete',
    observedRuntimeState: 'complete',
    sidecarAgeMs: 99_999,
    sidecarFreshness: 'stale',
  });

  writeFileSync(
    path + '.health.json',
    JSON.stringify({ scopeId: 's', sampledAtMs: 100_000, runtimeState: 'healthy', queueDepth: 9 }),
  );
  expect(inspectDatabaseStatus(path, { scopeId: 's', nowMs: 100_000 })).toMatchObject({
    runtimeState: null,
    observedRuntimeState: null,
    sidecarSampledAtMs: null,
    sidecarFreshness: 'invalid',
    queueDepth: 0,
  });
});
