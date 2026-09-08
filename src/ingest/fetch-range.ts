import type { ChainReader, RawLog } from '../domain/types.js';
import { classifyRpcError, RpcFailure } from '../rpc/errors.js';
type Filter = Parameters<ChainReader['getLogs']>[0];
export interface FetchResult {
  logs: RawLog[];
  complete: boolean;
  failures: { fromBlock: bigint; toBlock: bigint; reason: string }[];
  ranges: { fromBlock: bigint; toBlock: bigint; count: number }[];
}
export async function fetchBoundedLogs(
  reader: Pick<ChainReader, 'getLogs'>,
  filter: Filter,
  guard: number,
  maxRangeBlocks?: bigint,
): Promise<FetchResult> {
  const result: FetchResult = { logs: [], complete: true, failures: [], ranges: [] };
  async function fetch(f: Filter): Promise<void> {
    try {
      const logs = await reader.getLogs(f);
      if (logs.length >= guard) throw new RpcFailure('range-limit');
      result.logs.push(...logs);
      result.ranges.push({ fromBlock: f.fromBlock, toBlock: f.toBlock, count: logs.length });
    } catch (error) {
      const e = classifyRpcError(error);
      if (e.evidenceFailure || e.kind === 'budget' || e.kind === 'rate-limit') throw e;
      if (e.kind === 'range-limit' && f.fromBlock < f.toBlock) {
        const mid = (f.fromBlock + f.toBlock) / 2n;
        await fetch({ ...f, toBlock: mid });
        await fetch({ ...f, fromBlock: mid + 1n });
      } else {
        result.complete = false;
        result.failures.push({ fromBlock: f.fromBlock, toBlock: f.toBlock, reason: e.kind });
      }
    }
  }
  if (maxRangeBlocks !== undefined && maxRangeBlocks <= 0n)
    throw new RangeError('maxRangeBlocks must be positive');
  const chunkSize = maxRangeBlocks ?? filter.toBlock - filter.fromBlock + 1n;
  if (filter.fromBlock < 0n || filter.toBlock < filter.fromBlock)
    throw new RangeError('Invalid log range');
  for (let fromBlock = filter.fromBlock; fromBlock <= filter.toBlock; fromBlock += chunkSize) {
    const end = fromBlock + chunkSize - 1n;
    await fetch({ ...filter, fromBlock, toBlock: end < filter.toBlock ? end : filter.toBlock });
  }
  return result;
}
