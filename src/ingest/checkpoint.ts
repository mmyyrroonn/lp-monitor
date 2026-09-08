import type { BlockAnchor, ChainReader } from '../domain/types.js';
import { createTimeResolver } from '../rpc/resolve-time.js';

/** Chain-time lower_bound; never estimate heights using an average block rate. */
export async function warmupStart(
  reader: ChainReader,
  head: BlockAnchor,
  deploymentFloor = 0n,
  warmupMinutes = 60,
): Promise<bigint> {
  if (
    deploymentFloor < 0n ||
    deploymentFloor > head.number ||
    !Number.isSafeInteger(warmupMinutes) ||
    warmupMinutes < 1
  )
    throw new RangeError('Invalid warmup bounds');
  const lower = deploymentFloor === head.number ? head : await reader.getAnchor(deploymentFloor);
  const target = Math.floor((head.timestampSec - warmupMinutes * 60) / 60) * 60;
  if (target <= lower.timestampSec) return deploymentFloor;
  const resolver = createTimeResolver(
    reader,
    new Map([
      [lower.number, lower],
      [head.number, head],
    ]),
  );
  return (
    await resolver.resolveMinuteBoundary(target, { fromBlock: lower.number, toBlock: head.number })
  ).firstBlock;
}
