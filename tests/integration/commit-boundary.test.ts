import { expect, test } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import { commitAcceptedSignalBatch } from '../../src/signals/project.js';
import { initialSignalConfig } from '../../src/signals/config.js';
import { batch, swap, anchor, metricInput, registration } from '../helpers/alert-fixture.js';
import { eventIndexFor } from '../../src/storage/live-event-index.js';
import { liveWorksetFor } from '../../src/storage/live-workset.js';
import { registryCacheFor } from '../../src/storage/registry-cache.js';
import { withCommitBoundary } from '../../src/storage/commit-boundary.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { poolRegistrationId } from '../../src/registry/pools.js';

test('a committed accepted batch publishes the workset watermark it selected against', () => {
  const db = openDatabase(':memory:');
  try {
    const workset = () => liveWorksetFor(db, 's', eventIndexFor(db, 's'));
    expect(workset().standingWatermarkSec).toBeNull();
    commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('a', [swap(70, 30000)]));
    // The regression this guards: the commit used to sit after a `return` and never ran, so every
    // later round re-answered for a watermark the durable round had already evaluated.
    expect(workset().standingWatermarkSec).toBe(anchor(4800).timestampSec);
    expect(workset().armedWatermarkSec).toBeNull();
  } finally {
    db.close();
  }
});

test('an outer rollback leaves no standing watermark and no accepted range', () => {
  const db = openDatabase(':memory:');
  try {
    const workset = () => liveWorksetFor(db, 's', eventIndexFor(db, 's'));
    expect(() =>
      db.transaction(() => {
        commitAcceptedSignalBatch(
          db,
          metricInput,
          initialSignalConfig,
          batch('a', [swap(70, 30000)]),
        );
        throw new Error('outer abort');
      })(),
    ).toThrow('outer abort');
    expect(new SqliteRangeStore(db).acceptedTip('s')).toBeNull();
    expect(workset().standingWatermarkSec).toBeNull();
    // The failed attempt armed the watermark and then went back with it; nothing it armed may
    // answer for the retry.
    expect(workset().armedWatermarkSec).toBeNull();
  } finally {
    db.close();
  }
});

test('a boundary rollback invalidates a registry context that read uncommitted rows', () => {
  const db = openDatabase(':memory:');
  try {
    const cache = registryCacheFor(db, 's', 's');
    cache.prepare();
    const poolId = poolRegistrationId(registration);
    expect(() =>
      withCommitBoundary(db, () =>
        db.transaction(() => {
          // The accepting batch's own rows, written inside this transaction and read back by a
          // `prepare()` taken while they are still uncommitted.
          new SqliteRangeStore(db).acceptRange(batch('a', [swap(70, 30000)]));
          expect(cache.prepare().view.get(poolId)).toBeDefined();
          throw new Error('abort');
        })(),
      ),
    ).toThrow('abort');
    // SQL rolled the rows back; the context must not keep them as durable knowledge.
    expect(cache.prepare().view.get(poolId)).toBeUndefined();
  } finally {
    db.close();
  }
});
