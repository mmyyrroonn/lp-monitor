import { createHash } from 'node:crypto';
import { encodeJson } from '../../src/domain/json.js';
import { rawLogKey } from '../../src/storage/manifest.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { buildMetricsReport } from '../../src/storage/metric-store.js';
import { getPayload, type PayloadRef } from '../../src/storage/payload-store.js';
import { decodeSignalState } from '../../src/signals/codec.js';
import { expect, test } from 'vitest';
import { openDashboardFixture, POOLS } from '../helpers/dashboard-fixture.js';
import { projectSignals } from '../../src/signals/project.js';
import { initialSignalConfig } from '../../src/signals/config.js';
import { openWorkCounts } from '../../src/ops/work-counters.js';

const context = { batchId: 'prepared', observedAtMs: 100000, captureMode: 'synthetic' as const };

test('prepares configuration once while retaining one audit receipt for every initial pool', () => {
  const f = openDashboardFixture();
  const work = openWorkCounts();
  try {
    projectSignals(f.db, f.input, initialSignalConfig, context);
    const rows = f.db.prepare('select payload_json from signal_evaluations').all() as {
      payload_json: string;
    }[];
    expect(rows).toHaveLength(POOLS.length);
    expect(new Set(rows.map((r) => r.payload_json)).size).toBeLessThan(rows.length);
    expect(work.counts.signalConfigComputes).toBe(1);
    expect(work.counts.signalAuditPayloadWrites).toBe(
      new Set(rows.map((r) => r.payload_json)).size,
    );
  } finally {
    work.close();
    f.close();
  }
});

test('audit payload reuse survives rollback and validates stored objects in a later transaction', () => {
  const f = openDashboardFixture();
  try {
    const countPayloads = () => f.db.prepare('select count(*) from payload_objects').pluck().get();
    const before = countPayloads();
    expect(() =>
      f.db.transaction(() => {
        projectSignals(f.db, f.input, initialSignalConfig, context);
        throw new Error('abort prepared batch');
      })(),
    ).toThrow('abort prepared batch');
    expect(countPayloads()).toBe(before);
    expect(f.db.prepare('select count(*) from signal_evaluations').pluck().get()).toBe(0);
    projectSignals(f.db, f.input, initialSignalConfig, context);
    const rows = f.db.prepare('select payload_json from signal_evaluations').all() as {
      payload_json: string;
    }[];
    expect(rows).toHaveLength(POOLS.length);
    for (const row of rows) {
      const { payload } = JSON.parse(row.payload_json) as { payload: PayloadRef };
      expect(
        decodeSignalState(Buffer.from(getPayload(f.db, payload)).toString('utf8')),
      ).toMatchObject({ observedAtMs: context.observedAtMs });
    }
    const { payload } = JSON.parse(rows[0]!.payload_json) as { payload: PayloadRef };
    f.db
      .prepare('update payload_objects set payload=? where hash=?')
      .run(Buffer.from('corrupt'), payload.hash);
    f.db.exec(
      'delete from signal_snapshots; delete from signal_cursors; delete from signal_evaluations',
    );
    expect(() => projectSignals(f.db, f.input, initialSignalConfig, context)).toThrow(
      'not valid gzip',
    );
  } finally {
    f.close();
  }
});

test('single-pass evidence preserves each legacy log/time/valuation digest', () => {
  const f = openDashboardFixture();
  try {
    const report = buildMetricsReport(f.db, f.input, { live: { historyMinutes: 180 } });
    const raw = new SqliteRangeStore(f.db);
    const times = raw.logTimes('s');
    const valuations = new Map(report.valuations.map((v) => [v.eventId, v]));
    const expected = new Map(
      raw.activeLogs('s').map((log) => {
        const key = rawLogKey(log);
        return [
          key,
          createHash('sha256')
            .update(
              encodeJson({
                log,
                time: times.get(key) ?? null,
                valuation: valuations.get(key) ?? null,
              }),
            )
            .digest('hex'),
        ];
      }),
    );
    projectSignals(f.db, f.input, initialSignalConfig, context);
    const json = f.db
      .prepare('select evidence_json from signal_cursors where scope_id=?')
      .pluck()
      .get('s') as string;
    const evidence = decodeSignalState<{ events: Record<string, { digest: string }> }>(json);
    expect(
      new Map(Object.entries(evidence.events).map(([key, value]) => [key, value.digest])),
    ).toEqual(expected);
  } finally {
    f.close();
  }
});
