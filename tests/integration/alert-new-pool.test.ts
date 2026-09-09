import { expect, test } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import { commitAcceptedSignalBatch } from '../../src/signals/project.js';
import { initialSignalConfig } from '../../src/signals/config.js';
import { buildMetricsReport } from '../../src/storage/metric-store.js';
import { batch, swap, anchor, metricInput } from '../helpers/alert-fixture.js';
test('birth-minute observed 25k produces absolute-only candidate but never prebirth baseline', () => {
  const db = openDatabase(':memory:');
  try {
    const b = batch('birth', [swap(4802, 25000)]);
    b.end = anchor(4805);
    b.toBlock = 4805n;
    b.manifest.shards[0]!.request.toBlock = 4805n;
    const first = commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, b);
    expect(first.alerts[0]).toMatchObject({
      kind: 'candidate',
      reasons: expect.arrayContaining(['warming/absolute-only', 'partial']),
    });
    const m = buildMetricsReport(db, metricInput).windows[0]!;
    expect(m.partialCurrent).toMatchObject({ status: 'partial', usdMicros: 25000000000n });
    expect(
      m.minutes
        .filter((x) => x.minuteStartSec < 4860)
        .every((x) => x.status === 'warming' && x.usdMicros === null),
    ).toBe(true);
    expect(m.partialCurrent!.baselineSampleCount).toBe(0);
    const next = batch('after-birth', [swap(4802, 25000)]);
    next.previous = b.end;
    next.end = anchor(4865);
    next.toBlock = 4865n;
    next.manifest.shards[0]!.request.toBlock = 4865n;
    next.boundaries = [
      ...next.boundaries!,
      { timestampSec: 4920, firstBlock: 4860n, before: anchor(4859), at: anchor(4860) },
    ];
    commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, next);
    const closed = buildMetricsReport(db, metricInput).windows[0]!.minutes.find(
      (x) => x.minuteStartSec === 4860,
    )!;
    expect(closed).toMatchObject({ status: 'warming', usdMicros: null });
  } finally {
    db.close();
  }
});
