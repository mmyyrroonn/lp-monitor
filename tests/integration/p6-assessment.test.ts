import { beforeAll, afterAll, expect, test, vi } from 'vitest';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as rpc from '../../src/rpc/client.js';
import { encodeJson } from '../../src/domain/json.js';
import { loadChainConfig } from '../../src/config/chain.js';
import { loadEnv } from '../../src/config/env.js';
import { loadMetricMetadata } from '../../src/metrics/metadata.js';
import { parseSignalConfig } from '../../src/signals/config.js';
import { runRecorder } from '../../src/ops/recorder.js';
import { openDatabase } from '../../src/storage/database.js';
import { readBatch } from '../../src/storage/payload-store.js';
import { recorderFixture } from '../helpers/recorder-fixture.js';

const root = mkdtempSync(join(tmpdir(), 'p6-assessor-'));
const originalDb = join(root, 'original.sqlite');
let manifestPath: string;
beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  const original = rpc.createChainReader;
  vi.spyOn(rpc, 'createChainReader').mockImplementation((env, opts) =>
    original(env, {
      ...opts,
      perSecond: 5,
      maxBackfillRpcRps: 1,
      maxConcurrentRpc: 2,
    }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const run = runRecorder({
      command: 'follow',
      notify: 'local',
      signalConfig: parseSignalConfig(
        JSON.parse(readFileSync('config/signals.initial.json', 'utf8')),
      ),
      metricMetadata: loadMetricMetadata('config/metric-metadata.json'),
      config: loadChainConfig('config/robinhood.json'),
      env: loadEnv({
        RH_RPC_HTTP: 'https://fixture.invalid',
        RH_PROVIDER_ALIAS: 'p6-assessment-fixture',
      }),
      watchlistPath: 'config/watchlist.amc.json',
      databasePath: originalDb,
      outputDirectory: join(root, 'runs'),
      fromBlock: 100n,
      durationMs: 180000,
      maxCalls: 10000,
      evidenceMode: 'off',
      readerFactory: recorderFixture().factory,
    });
    await vi.runAllTimersAsync();
    expect(await run).toBe(0);
    manifestPath = join(root, 'runs', readdirSync(join(root, 'runs'))[0]!, 'manifest.json');
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function fixture() {
  const dir = mkdtempSync(join(root, 'case-'));
  const dbPath = join(dir, 'snapshot.sqlite');
  const db = openDatabase(originalDb, { readonly: true });
  try {
    await db.backup(dbPath);
  } finally {
    db.close();
  }
  copyFileSync(manifestPath, join(dir, 'manifest.json'));
  copyFileSync(join(manifestPath, '..', 'ops-report.json'), join(dir, 'ops-report.json'));
  return { dir, dbPath, manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) };
}
function assess(f: { dir: string; dbPath: string }, seconds = '1') {
  const output = join(f.dir, 'assessment.json');
  const child = spawnSync(
    process.execPath,
    [
      resolve('artifacts/p6/assess-run.mjs'),
      '--manifest',
      join(f.dir, 'manifest.json'),
      '--db',
      f.dbPath,
      '--out',
      output,
      '--required-seconds',
      seconds,
    ],
    { encoding: 'utf8', timeout: 15000, windowsHide: true },
  );
  expect(child.error).toBeUndefined();
  expect([0, 4], child.stderr).toContain(child.status);
  return { code: child.status, result: JSON.parse(readFileSync(output, 'utf8')) };
}
test('real finalized fixture snapshot passes with measured 5/2/1 budgets and null monetary rates', async () => {
  const f = await fixture();
  const before = readFileSync(f.dbPath);
  const assessed = assess(f);
  expect(assessed.result.issues).toEqual([]);
  expect(assessed.code).toBe(0);
  expect(assessed.result.measured.monetaryCost).toBeNull();
  expect(readFileSync(f.dbPath)).toEqual(before);
});
test('valid manifest cannot pass against an unrelated empty migrated database', async () => {
  const f = await fixture();
  f.dbPath = join(f.dir, 'wrong.sqlite');
  openDatabase(f.dbPath).close();
  const assessed = assess(f);
  expect(assessed.code).toBe(4);
  expect(assessed.result.issues).toContain('database-run-missing');
});
test('external operations report must match the finalized manifest report', async () => {
  const f = await fixture();
  const path = join(f.dir, 'ops-report.json');
  const report = JSON.parse(readFileSync(path, 'utf8'));
  report.sourceAlias = 'unrelated-provider';
  writeFileSync(path, JSON.stringify(report));
  const assessed = assess(f);
  expect(assessed.code).toBe(4);
  expect(assessed.result.issues).toContain('operations-report-binding-mismatch');
});
test.each(['pending', 'failed'])(
  'live %s outbox row blocks acceptance despite healthy manifest',
  async (status) => {
    const f = await fixture();
    const db = openDatabase(f.dbPath);
    try {
      db.prepare(
        "insert into alert_outbox(scope_id,alert_id,revision,capture_mode,status,payload_json) values(?, 'test-alert', 1, 'live', ?, '{}')",
      ).run(f.manifest.scopeId, status);
    } finally {
      db.close();
    }
    const assessed = assess(f);
    expect(assessed.code).toBe(4);
    expect(assessed.result.issues).toContain('live-notifications-pending-or-failed');
  },
);
test('discovery cursor removal cannot pass using operation cursor alone', async () => {
  const f = await fixture();
  const db = openDatabase(f.dbPath);
  try {
    db.prepare('delete from scope_cursors where scope_id=?').run(f.manifest.discoveryScope);
  } finally {
    db.close();
  }
  const assessed = assess(f);
  expect(assessed.code).toBe(4);
  expect(assessed.result.issues).toContain('discovery-cursor-unbound');
});

test.each([
  ['finalized run', "update runs set status='running'", 'database-run-binding-mismatch'],
  [
    'operation tip',
    "update scope_cursors set block_hash='wrong' where scope_id=?",
    'operation-cursor-unbound',
  ],
  [
    'discovery batch',
    "update ingest_batches set manifest_hash='wrong' where scope_id=?",
    'database-batch-binding-mismatch',
  ],
])('%s is bound to the snapshot', async (name, sql, expected) => {
  const f = await fixture();
  const db = openDatabase(f.dbPath);
  try {
    db.prepare(sql).run(
      ...(sql.includes('?')
        ? [name === 'discovery batch' ? f.manifest.discoveryScope : f.manifest.scopeId]
        : []),
    );
  } finally {
    db.close();
  }
  const assessed = assess(f);
  expect(assessed.code).toBe(4);
  expect(assessed.result.issues).toContain(expected);
});
test.each(['peakOneSecond', 'peakConcurrentRpc', 'backfillPeakOneSecond'])(
  'missing %s cannot count as measured budget',
  async (field) => {
    const f = await fixture();
    delete f.manifest.meter[field];
    writeFileSync(join(f.dir, 'manifest.json'), JSON.stringify(f.manifest));
    const db = openDatabase(f.dbPath);
    try {
      db.prepare('update runs set payload_json=? where id=?').run(
        JSON.stringify(f.manifest),
        f.manifest.runId,
      );
    } finally {
      db.close();
    }
    const assessed = assess(f);
    expect(assessed.code).toBe(4);
    expect(assessed.result.issues).toContain('rpc-budget-unmeasured');
  },
);
test('null p95 is unmeasured even when the sample size claims a measurement', async () => {
  const f = await fixture();
  f.manifest.telemetry.report.latency.localProcessingMs.p95 = null;
  writeFileSync(join(f.dir, 'ops-report.json'), JSON.stringify(f.manifest.telemetry.report));
  writeFileSync(join(f.dir, 'manifest.json'), JSON.stringify(f.manifest));
  const db = openDatabase(f.dbPath);
  try {
    db.prepare('update runs set payload_json=? where id=?').run(
      JSON.stringify(f.manifest),
      f.manifest.runId,
    );
  } finally {
    db.close();
  }
  const assessed = assess(f);
  expect(assessed.code).toBe(4);
  expect(assessed.result.issues).toContain('local-processing-unmeasured');
});
test('zero required duration cannot authorize acceptance', async () => {
  const f = await fixture();
  const assessed = assess(f, '0');
  expect(assessed.code).toBe(4);
  expect(assessed.result.issues).toContain('required-duration-invalid');
});
test('confirmed sent outbox payload is exported with JSONL-compatible bigint strings', async () => {
  const f = await fixture();
  const db = openDatabase(f.dbPath);
  try {
    db.prepare(
      "insert into alert_outbox(scope_id,alert_id,revision,capture_mode,status,attempts,payload_json) values(?, 'delivered', 1, 'live', 'sent', 1, ?)",
    ).run(
      f.manifest.scopeId,
      JSON.stringify({ id: 'delivered', revision: 1, amount: { $bigint: '5' } }),
    );
  } finally {
    db.close();
  }
  const assessed = assess(f);
  expect(assessed.code).toBe(0);
  expect(assessed.result.snapshotDatabasePath).toBe(resolve(f.dbPath));
  expect(assessed.result.sentOutbox[0]).toMatchObject({
    alertId: 'delivered',
    revision: 1,
    payload: { id: 'delivered', revision: 1, amount: '5' },
  });
  expect(assessed.result.sentOutbox[0].jsonlPayloadSha256).toMatch(/^[a-f0-9]{64}$/);
});

async function failedAttempt(from = 110, to = 200, discovery = false, oldHash?: string) {
  const f = await fixture();
  const db = openDatabase(f.dbPath);
  try {
    const scope = discovery ? f.manifest.discoveryScope : f.manifest.scopeId;
    const original = db
      .prepare('select * from ingest_batches where scope_id=? order by observed_at_ms limit 1')
      .get(scope) as Record<string, any>;
    const payload = readBatch(db, original.id) as any;
    payload.id = 'failed-attempt';
    payload.fromBlock = String(from);
    payload.toBlock = String(to);
    payload.end = {
      number: String(to),
      hash: oldHash ?? '0x' + to.toString(16).padStart(64, '0'),
      timestampSec: 1000 + to,
    };
    payload.logs = [];
    payload.completeness = 'incomplete';
    payload.manifestHash = 'failed-manifest';
    db.prepare(
      'insert into ingest_batches(id,scope_id,chain_id,from_block,to_block,end_hash,end_timestamp_sec,observed_at_ms,capture_mode,filter_plan_hash,manifest_hash,completeness,payload_json) values(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      payload.id,
      scope,
      original.chain_id,
      from,
      to,
      payload.end.hash,
      payload.end.timestampSec,
      original.observed_at_ms - 1,
      'live',
      original.filter_plan_hash,
      payload.manifestHash,
      'incomplete',
      encodeJson(payload),
    );
    f.manifest.batches.unshift({
      id: payload.id,
      scopeId: scope,
      fromBlock: String(from),
      toBlock: String(to),
      manifestHash: payload.manifestHash,
      completeness: 'incomplete',
      logs: 0,
      accepted: false,
    });
    f.manifest.failures.push('rate-limit');
    db.prepare('update runs set payload_json=? where id=?').run(
      JSON.stringify(f.manifest),
      f.manifest.runId,
    );
    writeFileSync(join(f.dir, 'manifest.json'), JSON.stringify(f.manifest));
  } finally {
    db.close();
  }
  return f;
}
test('later validated full coverage explicitly explains a failed operation attempt without deleting failure evidence', async () => {
  const f = await failedAttempt();
  const assessed = assess(f);
  expect(assessed.code).toBe(0);
  expect(assessed.result.unacceptedBatches).toBe(1);
  expect(assessed.result.failuresRecorded).toContain('rate-limit');
  expect(assessed.result.recoveredUnacceptedBatches).toHaveLength(1);
  expect(assessed.result.recoveredUnacceptedBatches[0]).toMatchObject({
    batchId: 'failed-attempt',
    fromBlock: '110',
    toBlock: '200',
  });
});
test('an uncovered prefix of a failed interval remains incomplete', async () => {
  const f = await failedAttempt(50);
  const assessed = assess(f);
  expect(assessed.code).toBe(4);
  expect(assessed.result.issues).toContain('unaccepted-run-batches-require-explanation');
});
test.each(['partial', 'failed-shards'])(
  '%s accepted evidence cannot prove recovery',
  async (kind) => {
    const f = await failedAttempt();
    const db = openDatabase(f.dbPath);
    try {
      if (kind === 'partial')
        db.prepare(
          'update accepted_ranges set to_block=124 where scope_id=? and from_block=100',
        ).run(f.manifest.scopeId);
      else
        db.prepare(
          "update fetch_shards set status='failed',error='fixture-failure' where batch_id in (select id from ingest_batches where scope_id=?)",
        ).run(f.manifest.scopeId);
    } finally {
      db.close();
    }
    const assessed = assess(f);
    expect(assessed.code).toBe(4);
    expect(assessed.result.issues).toContain('unaccepted-run-batches-require-explanation');
  },
);
test('unaccepted discovery remains incomplete even with overlapping operation coverage', async () => {
  const f = await failedAttempt(110, 200, true);
  const assessed = assess(f);
  expect(assessed.code).toBe(4);
  expect(assessed.result.issues).toContain('unaccepted-run-batches-require-explanation');
});
test('superseded failed endpoint is retained as non-authoritative evidence after complete current coverage', async () => {
  const f = await failedAttempt(110, 200, false, '0x' + 'f'.repeat(64));
  const assessed = assess(f);
  expect(assessed.code).toBe(0);
  expect(assessed.result.recoveredUnacceptedBatches[0].failedEndAnchor.relation).toBe('superseded');
});
