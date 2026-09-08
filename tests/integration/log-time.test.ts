import { expect, test } from 'vitest';
import type { BlockAnchor, ChainReader, RawLog } from '../../src/domain/types.js';
import { logTimeKey, resolveLogTimes } from '../../src/ingest/log-time.js';

const hex = (value: bigint): `0x${string}` => `0x${value.toString(16).padStart(64, '0')}`;
const address = '0x0000000000000000000000000000000000000001' as const;

function anchor(number: bigint, timestampSec: number): BlockAnchor {
  return { number, hash: hex(number), timestampSec };
}

function log(blockNumber: bigint, logIndex: number): RawLog {
  return {
    address,
    topics: [],
    data: '0x',
    blockNumber,
    blockHash: hex(blockNumber),
    transactionHash: hex(BigInt(logIndex + 100)),
    transactionIndex: 0,
    logIndex,
    // This is the documented provider failure fixture, not a usable timestamp.
    rawBlockTimestamp: '0x0',
  };
}

function readerFrom(anchors: readonly BlockAnchor[], failed: readonly bigint[] = []) {
  const byNumber = new Map(anchors.map((value) => [value.number, value]));
  const calls: Array<bigint | 'latest'> = [];
  const reader: ChainReader = {
    async getAnchor(block) {
      calls.push(block);
      if (block === 'latest') return anchors.at(-1)!;
      if (failed.includes(block)) throw new Error(`fixture anchor failure ${block}`);
      const value = byNumber.get(block);
      if (!value) throw new Error(`missing anchor ${block}`);
      return value;
    },
    async getLogs() {
      return [];
    },
  };
  return { reader, calls };
}

test('backfilled logs retain their historical minute despite an unusable 0x0 log timestamp', async () => {
  const anchors = [0, 59, 59, 60, 60, 61].map((timestampSec, number) =>
    anchor(BigInt(number), timestampSec),
  );
  const oldLog = log(2n, 4);
  const newLog = log(4n, 5);
  const { reader, calls } = readerFrom(anchors);

  const result = await resolveLogTimes(reader, [oldLog, newLog], 1n, anchors[5]!);

  expect(result.times.get(logTimeKey(oldLog))).toEqual({
    minuteStartSec: 0,
    exactTimestampSec: null,
    source: 'minute-boundary',
  });
  expect(result.times.get(logTimeKey(newLog))).toEqual({
    minuteStartSec: 60,
    exactTimestampSec: null,
    source: 'minute-boundary',
  });
  expect(calls).not.toContain(4n);
});

test('a failed minute boundary leaves only its affected unsampled logs unresolved', async () => {
  const anchors = [0, 59, 59, 60, 120].map((timestampSec, number) =>
    anchor(BigInt(number), timestampSec),
  );
  const raw = log(3n, 1);
  const { reader } = readerFrom(anchors, [2n]);

  const result = await resolveLogTimes(reader, [raw], 1n, anchors[4]!);

  expect(result.failures).toHaveLength(2);
  expect(result.times.get(logTimeKey(raw))).toEqual({
    minuteStartSec: null,
    exactTimestampSec: null,
    source: 'unresolved',
  });
  expect(raw.rawBlockTimestamp).toBe('0x0');
});

test('resolves existing overlap logs by their enclosing anchors instead of the end minute', async () => {
  const anchors = [
    anchor(0n, 0),
    ...Array.from({ length: 21 }, (_, offset) => {
      const number = BigInt(100 + offset);
      return anchor(number, offset < 10 ? 119 : 120);
    }),
  ];
  const oldLog = log(105n, 1);
  const currentLog = log(115n, 2);
  const { reader, calls } = readerFrom(anchors);

  const before = anchor(99n, 59);
  const result = await resolveLogTimes(
    reader,
    [oldLog, currentLog],
    100n,
    anchors[21]!,
    [before],
    [{ timestampSec: 60, firstBlock: 100n, before, at: anchors[1]! }],
  );

  expect(result.times.get(logTimeKey(oldLog))?.minuteStartSec).toBe(60);
  expect(result.times.get(logTimeKey(currentLog))?.minuteStartSec).toBe(120);
  expect(calls.length).toBeLessThan(anchors.length);
});

test('uses same-minute range endpoints without a genesis lookup', async () => {
  const anchors = [anchor(500n, 601), anchor(520n, 619)];
  const raw = log(510n, 9);
  const { reader, calls } = readerFrom(anchors);

  const result = await resolveLogTimes(reader, [raw], 500n, anchors[1]!);

  expect(result.times.get(logTimeKey(raw))?.minuteStartSec).toBe(600);
  expect(calls).toEqual([500n]);
});

test('uses same-minute sparse anchor brackets at the beginning of a cross-minute range', async () => {
  const anchors = Array.from({ length: 101 }, (_, offset) => {
    const number = BigInt(100 + offset);
    return anchor(number, 1000 + Number(number));
  });
  const early = log(120n, 12);
  const later = log(180n, 18);
  const { reader } = readerFrom(anchors);

  const result = await resolveLogTimes(reader, [early, later], 100n, anchors[100]!);

  expect(result.failures).toEqual([]);
  expect(result.times.get(logTimeKey(early))?.minuteStartSec).toBe(1080);
  expect(result.times.get(logTimeKey(later))?.minuteStartSec).toBe(1140);
});
