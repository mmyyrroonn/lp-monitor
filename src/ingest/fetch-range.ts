import type { Hex } from 'viem';
import type { ChainReader, RawLog } from '../domain/types.js';
import { encodeJson } from '../domain/json.js';
import { sha256 } from '../ops/files.js';
import { classifyRpcError } from '../rpc/errors.js';

type Filter = Parameters<ChainReader['getLogs']>[0];

export interface FetchFragment {
  filter: Filter;
  status: 'success' | 'failed' | 'truncated';
  logs: readonly RawLog[];
  responseHash: string | null;
  reason: string | null;
}
export interface FetchResult {
  logs: RawLog[];
  complete: boolean;
  failures: { fromBlock: bigint; toBlock: bigint; reason: string }[];
  ranges: { fromBlock: bigint; toBlock: bigint; count: number }[];
  fragments: FetchFragment[];
}
export interface FetchBoundedOptions {
  /** Keep successful earlier leaves and represent terminal failures in the result. */
  captureCriticalFailures?: boolean;
}

const rawLogKey = (log: RawLog) =>
  `${log.blockHash.toLowerCase()}:${log.transactionHash.toLowerCase()}:${log.logIndex}`;

function splitFilter(filter: Filter): readonly [Filter, Filter] | null {
  if (filter.fromBlock < filter.toBlock) {
    const middle = (filter.fromBlock + filter.toBlock) / 2n;
    return [
      { ...filter, toBlock: middle },
      { ...filter, fromBlock: middle + 1n },
    ];
  }
  if (filter.address.length > 1) {
    const middle = Math.ceil(filter.address.length / 2);
    return [
      { ...filter, address: filter.address.slice(0, middle) },
      { ...filter, address: filter.address.slice(middle) },
    ];
  }
  const topicIndex = filter.topics.findIndex((topic) => Array.isArray(topic) && topic.length > 1);
  if (topicIndex < 0) return null;
  const alternatives = filter.topics[topicIndex] as readonly Hex[];
  const middle = Math.ceil(alternatives.length / 2);
  const withAlternatives = (values: readonly Hex[]): Filter => {
    const topics = [...filter.topics];
    topics[topicIndex] = values.length === 1 ? values[0]! : values;
    return { ...filter, topics };
  };
  return [
    withAlternatives(alternatives.slice(0, middle)),
    withAlternatives(alternatives.slice(middle)),
  ];
}

function splitFilterValuesFirst(filter: Filter): readonly [Filter, Filter] | null {
  if (filter.address.length > 1) {
    const middle = Math.ceil(filter.address.length / 2);
    return [
      { ...filter, address: filter.address.slice(0, middle) },
      { ...filter, address: filter.address.slice(middle) },
    ];
  }
  const topicIndex = filter.topics.findIndex((topic) => Array.isArray(topic) && topic.length > 1);
  if (topicIndex >= 0) {
    const alternatives = filter.topics[topicIndex] as readonly Hex[];
    const middle = Math.ceil(alternatives.length / 2);
    const withAlternatives = (values: readonly Hex[]): Filter => {
      const topics = [...filter.topics];
      topics[topicIndex] = values.length === 1 ? values[0]! : values;
      return { ...filter, topics };
    };
    return [
      withAlternatives(alternatives.slice(0, middle)),
      withAlternatives(alternatives.slice(middle)),
    ];
  }
  if (filter.fromBlock < filter.toBlock) {
    const middle = (filter.fromBlock + filter.toBlock) / 2n;
    return [
      { ...filter, toBlock: middle },
      { ...filter, fromBlock: middle + 1n },
    ];
  }
  return null;
}

export async function fetchBoundedLogs(
  reader: Pick<ChainReader, 'getLogs'>,
  filter: Filter,
  guard: number,
  maxRangeBlocks?: bigint,
  options: FetchBoundedOptions = {},
): Promise<FetchResult> {
  if (!Number.isSafeInteger(guard) || guard <= 0) {
    throw new RangeError('guard must be a positive safe integer');
  }
  if (maxRangeBlocks !== undefined && maxRangeBlocks <= 0n) {
    throw new RangeError('maxRangeBlocks must be positive');
  }
  if (filter.fromBlock < 0n || filter.toBlock < filter.fromBlock) {
    throw new RangeError('Invalid log range');
  }

  const result: FetchResult = {
    logs: [],
    complete: true,
    failures: [],
    ranges: [],
    fragments: [],
  };
  const fingerprints = new Map<string, string>();

  const recordLeaf = (current: Filter, status: 'failed' | 'truncated', reason: string) => {
    result.complete = false;
    result.failures.push({
      fromBlock: current.fromBlock,
      toBlock: current.toBlock,
      reason,
    });
    result.fragments.push({
      filter: current,
      status,
      logs: [],
      responseHash: null,
      reason,
    });
  };

  async function splitOrRecord(
    current: Filter,
    reason: string,
    status: 'failed' | 'truncated',
  ): Promise<void> {
    const halves = status === 'truncated' ? splitFilter(current) : null;
    if (halves === null) {
      recordLeaf(current, status, reason);
      return;
    }
    await fetch(halves[0]);
    await fetch(halves[1]);
  }

  async function fetch(current: Filter): Promise<void> {
    try {
      const logs = await reader.getLogs(current);
      if (logs.length >= guard) {
        await splitOrRecord(current, 'range-limit', 'truncated');
        return;
      }
      const responseHash = sha256(encodeJson(logs));
      const responseLogs = new Map<string, RawLog>();
      let conflict = false;
      for (const log of logs) {
        const key = rawLogKey(log);
        const fingerprint = encodeJson(log);
        const sameResponse = responseLogs.get(key);
        if (sameResponse !== undefined && encodeJson(sameResponse) !== fingerprint) {
          conflict = true;
          continue;
        }
        responseLogs.set(key, log);
        const prior = fingerprints.get(key);
        if (prior !== undefined && prior !== fingerprint) {
          conflict = true;
          continue;
        }
        if (prior === undefined) {
          fingerprints.set(key, fingerprint);
          result.logs.push(log);
        }
      }
      const uniqueResponseLogs = [...responseLogs.values()];
      if (conflict) {
        result.complete = false;
        result.failures.push({
          fromBlock: current.fromBlock,
          toBlock: current.toBlock,
          reason: 'conflicting-log-identity',
        });
        result.fragments.push({
          filter: current,
          status: 'failed',
          logs: uniqueResponseLogs,
          responseHash,
          reason: 'conflicting-log-identity',
        });
        return;
      }
      result.ranges.push({
        fromBlock: current.fromBlock,
        toBlock: current.toBlock,
        count: uniqueResponseLogs.length,
      });
      result.fragments.push({
        filter: current,
        status: 'success',
        logs: uniqueResponseLogs,
        responseHash,
        reason: null,
      });
    } catch (error) {
      const failure = classifyRpcError(error);
      if (
        failure.evidenceFailure ||
        failure.kind === 'budget' ||
        failure.kind === 'deadline' ||
        failure.kind === 'rate-limit'
      ) {
        if (!options.captureCriticalFailures) throw failure;
        const reason = failure.evidenceFailure
          ? `${failure.kind}:evidence-${failure.evidenceFailure.kind}`
          : failure.kind;
        recordLeaf(current, 'failed', reason);
        return;
      }
      if (failure.kind === 'filter-limit') {
        const halves = splitFilterValuesFirst(current);
        if (halves === null) {
          recordLeaf(current, 'failed', failure.kind);
        } else {
          await fetch(halves[0]);
          await fetch(halves[1]);
        }
        return;
      }
      await splitOrRecord(
        current,
        failure.kind,
        failure.kind === 'range-limit' ? 'truncated' : 'failed',
      );
    }
  }

  const chunkSize = maxRangeBlocks ?? filter.toBlock - filter.fromBlock + 1n;
  for (let fromBlock = filter.fromBlock; fromBlock <= filter.toBlock; fromBlock += chunkSize) {
    const requestedEnd = fromBlock + chunkSize - 1n;
    await fetch({
      ...filter,
      fromBlock,
      toBlock: requestedEnd < filter.toBlock ? requestedEnd : filter.toBlock,
    });
  }
  return result;
}
