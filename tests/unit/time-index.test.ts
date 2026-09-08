import { expect, test } from 'vitest';
import type { BlockAnchor, ChainReader, RawLog } from '../../src/domain/types.js';
import { assignLogMinutes, logTimeKey } from '../../src/ingest/log-time.js';
import { resolveMinuteBoundary } from '../../src/ingest/time-index.js';

const hex = (value: bigint): `0x${string}` => `0x${value.toString(16).padStart(64, '0')}`;
const address = '0x0000000000000000000000000000000000000001' as const;

function anchor(number: bigint, timestampSec: number): BlockAnchor {
  return { number, hash: hex(number), timestampSec };
}

function log(blockNumber: bigint, logIndex: number, blockHash = hex(blockNumber)): RawLog {
  return {
    address,
    topics: [],
    data: '0x',
    blockNumber,
    blockHash,
    transactionHash: hex(BigInt(logIndex + 100)),
    transactionIndex: 0,
    logIndex,
    rawBlockTimestamp: '0x0',
  };
}

test('lower_bound selects the first duplicated timestamp and proves its predecessor', async () => {
  const anchors = [59, 59, 60, 60, 61].map((timestampSec, number) =>
    anchor(BigInt(number), timestampSec),
  );
  const calls: bigint[] = [];
  const reader: ChainReader = {
    async getAnchor(block) {
      if (block === 'latest') throw new Error('unexpected latest');
      calls.push(block);
      return anchors[Number(block)]!;
    },
    async getLogs() {
      return [];
    },
  };

  await expect(resolveMinuteBoundary(reader, 60, anchors[0]!, anchors[4]!)).resolves.toEqual({
    timestampSec: 60,
    firstBlock: 2n,
    before: anchors[1],
    at: anchors[2],
  });
  expect(calls).toEqual([2n, 1n]);
});

test('assigns prior and boundary blocks to separate minutes without claiming seconds', () => {
  const anchors = [59, 59, 60, 60, 61].map((timestampSec, number) =>
    anchor(BigInt(number), timestampSec),
  );
  const logs = [log(1n, 1), log(2n, 2), log(3n, 3)];
  const times = assignLogMinutes(logs, anchors, [
    { timestampSec: 60, firstBlock: 2n, before: anchors[1]!, at: anchors[2]! },
  ]);

  expect(times.get(logTimeKey(logs[0]!))).toEqual({
    minuteStartSec: 0,
    exactTimestampSec: null,
    source: 'minute-boundary',
  });
  expect(times.get(logTimeKey(logs[1]!))).toEqual({
    minuteStartSec: 60,
    exactTimestampSec: null,
    source: 'minute-boundary',
  });
  expect(times.get(logTimeKey(logs[2]!))).toEqual({
    minuteStartSec: 60,
    exactTimestampSec: null,
    source: 'minute-boundary',
  });
});

test('marks a sampled hash mismatch unresolved instead of using a conflicting boundary', () => {
  const before = anchor(1n, 59);
  const at = anchor(2n, 60);
  const mismatched = log(2n, 1, hex(999n));

  expect(
    assignLogMinutes(
      [mismatched],
      [before, at],
      [{ timestampSec: 60, firstBlock: 2n, before, at }],
    ).get(logTimeKey(mismatched)),
  ).toEqual({ minuteStartSec: null, exactTimestampSec: null, source: 'unresolved' });
});
