import type { Clock, BlockAnchor } from '../domain/types.js';
import type { RecordedRangeBatch } from '../storage/manifest.js';
import { rawLogKey } from '../storage/manifest.js';
export type ReplayMode = 'minute-close' | 'recorded-observed';
export class ReplayClock implements Clock {
  constructor(private value = 0) {}
  nowMs() {
    return this.value;
  }
  advanceTo(value: number) {
    if (!Number.isSafeInteger(value) || value < this.value)
      throw new Error('Replay clock cannot move backwards');
    this.value = value;
  }
}
/** The boundary block is a watermark witness, never an event from the next minute. */
export function prefixAt(
  batch: RecordedRangeBatch,
  end: BlockAnchor,
  close: number,
  previous: BlockAnchor | null,
  requireTime = true,
): RecordedRangeBatch {
  const to = end.number;
  const times = new Map(batch.logTimes?.map((t) => [rawLogKey(t.ref), t.time]));
  const logs = batch.logs.filter(
    (l) =>
      l.blockNumber < to &&
      (!requireTime || (times.get(rawLogKey(l))?.minuteStartSec ?? Infinity) < close),
  );
  const keys = new Set(logs.map(rawLogKey));
  const shards = batch.manifest.shards
    .filter((s) => s.request.fromBlock <= to)
    .map((s) => ({
      ...s,
      request: { ...s.request, toBlock: s.request.toBlock < to ? s.request.toBlock : to },
      logKeys: s.logKeys.filter((k) => keys.has(k)),
      logCount: s.logKeys.filter((k) => keys.has(k)).length,
    }));
  return {
    ...batch,
    id: `${batch.id}:close:${close}`,
    toBlock: to,
    end,
    previous,
    logs,
    captureMode: 'backfill',
    observedAtMs: Math.max(close, end.timestampSec) * 1000,
    manifest: { ...batch.manifest, expectedShardIds: shards.map((s) => s.shardId), shards },
    logTimes: batch.logTimes?.filter((t) => keys.has(rawLogKey(t.ref))),
    boundaries: batch.boundaries?.filter((b) => b.at.number <= to),
    anchors: batch.anchors?.filter((a) => a.number <= to),
    poolRegistrations: batch.poolRegistrations?.filter((p) => p.discoveredAt.blockNumber < to),
  };
}
/** Derive prefixes only from recorded boundary anchors. Never invent a block or second. */
export function minutePrefixes(batch: RecordedRangeBatch): RecordedRangeBatch[] {
  const boundaries = [...(batch.boundaries ?? [])].sort((a, b) => a.timestampSec - b.timestampSec);
  const result: RecordedRangeBatch[] = [];
  let previous: BlockAnchor | null = null;
  for (const boundary of boundaries) {
    const close = boundary.timestampSec;
    if (
      !boundaries.some((b) => b.timestampSec === close - 60) ||
      boundary.at.number > batch.toBlock ||
      boundary.at.number < batch.fromBlock
    )
      continue;
    const prefix = prefixAt(batch, boundary.at, close, previous);
    result.push(prefix);
    previous = prefix.end;
  }
  return result;
}
/** Preserve unevaluated tails when transport boundaries do not align with minutes. */
export function mergeHistoricalBatches(batches: readonly RecordedRangeBatch[]): RecordedRangeBatch {
  const first = batches[0];
  if (!first) throw new Error('No historical batches');
  const latest = batches.at(-1)!;
  const logs = new Map<string, RecordedRangeBatch['logs'][number]>();
  const times = new Map<string, NonNullable<RecordedRangeBatch['logTimes']>[number]>();
  const boundaries = new Map<number, NonNullable<RecordedRangeBatch['boundaries']>[number]>();
  const anchors = new Map<string, BlockAnchor>();
  const pools = new Map<string, NonNullable<RecordedRangeBatch['poolRegistrations']>[number]>();
  const shards = batches.flatMap((b) =>
    b.manifest.shards.map((s) => ({ ...s, shardId: b.id + ':' + s.shardId })),
  );
  for (const b of batches) {
    for (const l of b.logs) logs.set(rawLogKey(l), l);
    for (const t of b.logTimes ?? []) times.set(rawLogKey(t.ref), t);
    for (const boundary of b.boundaries ?? []) boundaries.set(boundary.timestampSec, boundary);
    for (const a of [b.end, ...(b.anchors ?? [])]) anchors.set(a.number.toString(), a);
    for (const p of b.poolRegistrations ?? []) pools.set(JSON.stringify(p.pool), p);
  }
  return {
    ...latest,
    fromBlock: first.fromBlock,
    previous: first.previous,
    logs: [...logs.values()],
    logTimes: [...times.values()],
    boundaries: [...boundaries.values()],
    anchors: [...anchors.values()],
    poolRegistrations: [...pools.values()],
    // Unioning partial registers cannot produce a complete one: if any input stated only the pools
    // its own events touch, the merged array is still a dependency set, not the catalogue.
    ...(batches.some((b) => b.registryMode === 'referenced-v1')
      ? { registryMode: 'referenced-v1' as const }
      : {}),
    manifest: { ...latest.manifest, expectedShardIds: shards.map((s) => s.shardId), shards },
  };
}
