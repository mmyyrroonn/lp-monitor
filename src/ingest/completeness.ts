import { encodeCheckedInteger } from '../domain/codec.js';
import type { FetchShardManifest, RecordedRangeBatch } from '../storage/manifest.js';
import { rawLogKey } from '../storage/manifest.js';

export class IncompleteRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompleteRangeError';
  }
}

export function verifySuccessfulShardCoverage(
  batch: RecordedRangeBatch,
): readonly FetchShardManifest[] {
  checkedHeight(batch.fromBlock);
  checkedHeight(batch.toBlock);
  checkedHeight(batch.end.number);
  if (batch.fromBlock < 0n || batch.toBlock < batch.fromBlock)
    throw new IncompleteRangeError('Invalid batch range');
  if (batch.end.number !== batch.toBlock)
    throw new IncompleteRangeError('End anchor must identify toBlock');
  if (batch.completeness !== 'complete') throw new IncompleteRangeError('Range is not complete');
  if (batch.manifest.version !== 1 || batch.manifest.filterVersion.length === 0)
    throw new IncompleteRangeError('Missing filter manifest version');

  const expected = new Set(batch.manifest.expectedShardIds);
  if (expected.size === 0 || expected.size !== batch.manifest.expectedShardIds.length)
    throw new IncompleteRangeError('Expected shard IDs must be non-empty and unique');
  const actual = new Map<string, FetchShardManifest>();
  for (const shard of batch.manifest.shards) {
    if (actual.has(shard.shardId)) throw new IncompleteRangeError('Duplicate fetch shard ID');
    actual.set(shard.shardId, shard);
  }
  if (actual.size !== expected.size || [...expected].some((id) => !actual.has(id)))
    throw new IncompleteRangeError('Fetch shard set does not match expected shards');

  const batchLogs = new Map<string, (typeof batch.logs)[number]>();
  for (const log of batch.logs) {
    checkedHeight(log.blockNumber);
    if (log.blockNumber < batch.fromBlock || log.blockNumber > batch.toBlock)
      throw new IncompleteRangeError('Batch log lies outside the covered range');
    const key = rawLogKey(log);
    if (batchLogs.has(key)) throw new IncompleteRangeError('Duplicate raw log in batch');
    batchLogs.set(key, log);
  }

  const coveredLogKeys = new Set<string>();
  const byFilter = new Map<string, FetchShardManifest[]>();
  for (const id of batch.manifest.expectedShardIds) {
    const shard = actual.get(id);
    if (shard === undefined) throw new IncompleteRangeError('Missing fetch shard');
    checkedHeight(shard.request.fromBlock);
    checkedHeight(shard.request.toBlock);
    if (shard.status !== 'success')
      throw new IncompleteRangeError(`Fetch shard ${id} is not complete`);
    if (shard.responseHash === null || shard.responseHash.length === 0 || shard.error !== null)
      throw new IncompleteRangeError(`Fetch shard ${id} lacks successful response evidence`);
    if (
      shard.filterId.length === 0 ||
      shard.request.address.length === 0 ||
      shard.request.fromBlock < batch.fromBlock ||
      shard.request.toBlock > batch.toBlock ||
      shard.request.toBlock < shard.request.fromBlock
    )
      throw new IncompleteRangeError(`Fetch shard ${id} has invalid filter coverage`);
    if (!Number.isSafeInteger(shard.logCount) || shard.logCount < 0)
      throw new IncompleteRangeError(`Fetch shard ${id} has invalid log count`);
    const uniqueKeys = new Set(shard.logKeys);
    if (uniqueKeys.size !== shard.logKeys.length || shard.logCount !== shard.logKeys.length)
      throw new IncompleteRangeError(`Fetch shard ${id} log count does not match its keys`);
    for (const key of uniqueKeys) {
      const log = batchLogs.get(key);
      if (log === undefined)
        throw new IncompleteRangeError(`Fetch shard ${id} references unknown log`);
      if (log.blockNumber < shard.request.fromBlock || log.blockNumber > shard.request.toBlock)
        throw new IncompleteRangeError(`Fetch shard ${id} references a log outside its range`);
      if (!matchesRequest(log, shard.request))
        throw new IncompleteRangeError(`Fetch shard ${id} returned a log outside its filter`);
      coveredLogKeys.add(key);
    }
    const ranges = byFilter.get(shard.filterId) ?? [];
    ranges.push(shard);
    byFilter.set(shard.filterId, ranges);
  }

  for (const [filterId, shards] of byFilter) {
    shards.sort((left, right) =>
      left.request.fromBlock < right.request.fromBlock
        ? -1
        : left.request.fromBlock > right.request.fromBlock
          ? 1
          : 0,
    );
    let coveredThrough = batch.fromBlock - 1n;
    for (const shard of shards) {
      if (shard.request.fromBlock > coveredThrough + 1n)
        throw new IncompleteRangeError(`Filter ${filterId} has a coverage gap`);
      if (shard.request.toBlock > coveredThrough) coveredThrough = shard.request.toBlock;
    }
    if (coveredThrough < batch.toBlock)
      throw new IncompleteRangeError(`Filter ${filterId} does not cover the complete batch range`);
  }
  if (coveredLogKeys.size !== batchLogs.size)
    throw new IncompleteRangeError('Not every batch log is covered by a successful shard');
  return batch.manifest.expectedShardIds.map((id) => actual.get(id)!);
}

function checkedHeight(value: bigint): number {
  try {
    return encodeCheckedInteger(value, 0, Number.MAX_SAFE_INTEGER);
  } catch (error) {
    throw new IncompleteRangeError(
      error instanceof Error
        ? `Height is outside the safe INTEGER range: ${error.message}`
        : 'Unsafe height',
    );
  }
}

function matchesRequest(
  log: RecordedRangeBatch['logs'][number],
  request: FetchShardManifest['request'],
): boolean {
  const addresses = new Set(request.address.map((item) => item.toLowerCase()));
  if (!addresses.has(log.address.toLowerCase())) return false;
  for (let index = 0; index < request.topics.length; index++) {
    const expected = request.topics[index];
    if (expected === null || expected === undefined) continue;
    const actual = log.topics[index]?.toLowerCase();
    if (actual === undefined) return false;
    if (typeof expected === 'string') {
      if (actual !== expected.toLowerCase()) return false;
    } else if (!expected.some((candidate) => candidate.toLowerCase() === actual)) {
      return false;
    }
  }
  return true;
}
