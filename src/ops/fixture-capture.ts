import { CHAIN_ID } from '../domain/chain.js';
import { parseRpcQuantity } from '../domain/hex.js';
import { resolve } from 'node:path';
import { toEventSelector, type Hex } from 'viem';
import type { ChainConfig } from '../config/chain.js';
import type { BlockAnchor, ChainReader, RawLog } from '../domain/types.js';
import type { EvidenceReader } from '../rpc/client.js';
import { classifyRpcError, RpcFailure } from '../rpc/errors.js';
import { createTimeResolver, validateTimeAnchor } from '../rpc/resolve-time.js';
import { v3PoolAbi } from '../protocols/uniswap-v3/abi.js';
import { decodeV3PoolEvent } from '../protocols/uniswap-v3/decode.js';
import { v4ManagerAbi } from '../protocols/uniswap-v4/abi.js';
import { computeV4PoolId, decodeV4ManagerEvent } from '../protocols/uniswap-v4/pool-key.js';
import { encodeJson } from '../domain/json.js';
import { saveJson, sha256 } from './files.js';

type Filter = Parameters<ChainReader['getLogs']>[0];
export { fetchBoundedLogs, type FetchResult } from '../ingest/fetch-range.js';
import { fetchBoundedLogs, type FetchResult } from '../ingest/fetch-range.js';
const eventTopics = [...v3PoolAbi, ...v4ManagerAbi]
  .filter((e) => e.type === 'event')
  .map((e) => toEventSelector(e));
export const captureTopics = [...new Set(eventTopics)];
const v3CaptureTopics = v3PoolAbi
  .filter((event) => event.type === 'event')
  .map((event) => toEventSelector(event));
const v3SwapTopic = toEventSelector(
  v3PoolAbi.find((event) => event.type === 'event' && event.name === 'Swap')!,
);
const initializeTopic = toEventSelector(
  v4ManagerAbi.find((event) => event.type === 'event' && event.name === 'Initialize')!,
);
export const eventKey = (log: RawLog) =>
  `${log.blockHash.toLowerCase()}:${log.transactionHash.toLowerCase()}:${log.logIndex}`;
export function categorizeLogs(logs: readonly RawLog[], config: ChainConfig) {
  const categories: Record<string, number> = {};
  const initializations: {
    poolId: Hex;
    keyVerified: boolean;
    configuredSeed: boolean;
    blockNumber: bigint;
    blockHash: Hex;
    transactionHash: Hex;
    key: unknown;
  }[] = [];
  const errors: { key: string; reason: string }[] = [];
  for (const log of logs) {
    try {
      const v4 = log.address.toLowerCase() === config.v4Manager.toLowerCase();
      const v4Decoded = v4 ? decodeV4ManagerEvent(log) : null;
      const decoded = v4Decoded ?? decodeV3PoolEvent(log);
      const category = `${v4 ? 'v4' : 'v3'}.${decoded.eventName}`;
      categories[category] = (categories[category] ?? 0) + 1;
      if (v4Decoded?.eventName === 'Initialize') {
        const args = v4Decoded.args;
        const key = {
          currency0: args.currency0,
          currency1: args.currency1,
          fee: args.fee,
          tickSpacing: args.tickSpacing,
          hooks: args.hooks,
        };
        const keyVerified = computeV4PoolId(key) === args.id.toLowerCase();
        initializations.push({
          poolId: args.id,
          keyVerified,
          configuredSeed: config.v4PoolIds.some((id) => id.toLowerCase() === args.id.toLowerCase()),
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
          transactionHash: log.transactionHash,
          key,
        });
        if (!keyVerified) errors.push({ key: eventKey(log), reason: 'pool-id-mismatch' });
      }
    } catch {
      errors.push({ key: eventKey(log), reason: 'unknown-topic-or-decode-failure' });
    }
  }
  const missing = ['v3.Swap', 'v4.Swap', 'v4.Initialize'].filter((c) => !categories[c]);
  if (!['v3.Mint', 'v3.Burn', 'v4.ModifyLiquidity'].some((c) => categories[c]))
    missing.push('liquidity');
  const seedVerifications = config.v4PoolIds.map((poolId) => {
    const matches = initializations.filter(
      (item) => item.poolId.toLowerCase() === poolId.toLowerCase(),
    );
    return {
      poolId,
      status: matches.some((item) => item.keyVerified)
        ? ('verified' as const)
        : matches.length
          ? ('invalid' as const)
          : ('unverified' as const),
    };
  });
  return { categories, initializations, seedVerifications, errors, missing };
}
export async function captureFixture(
  reader: EvidenceReader,
  config: ChainConfig,
  options: {
    fromBlock: bigint;
    toBlock: bigint;
    captureMode: 'live' | 'backfill';
    outDir: string;
    supplementHistory?: boolean;
  },
) {
  const chainId = parseRpcQuantity(await reader.request('eth_chainId', []));
  if (chainId !== BigInt(CHAIN_ID)) throw new RpcFailure('chain-mismatch');
  const runDir = resolve(options.outDir);
  const filters = {
    fromBlock: options.fromBlock,
    toBlock: options.toBlock,
    address: [...config.v3Pools, config.v4Manager],
    topics: [captureTopics],
  };
  const files: ReturnType<typeof saveJson>[] = [];
  const rangeEvidence: unknown[] = [];
  const allLogs: RawLog[] = [];
  const failures: string[] = [];
  const timeEvidence: unknown[] = [];
  const observedAnchors: BlockAnchor[] = [];
  const anchorByBlock = new Map<bigint, BlockAnchor>();
  const resolver = createTimeResolver(reader, anchorByBlock);
  function observeAnchor(anchor: BlockAnchor, label: string): boolean {
    observedAnchors.push(anchor);
    try {
      validateTimeAnchor(anchor, anchorByBlock.values());
    } catch {
      failures.push(`${label}:invalid-time-anchors`);
      return false;
    }
    const prior = anchorByBlock.get(anchor.number);
    if (prior && (prior.hash !== anchor.hash || prior.timestampSec !== anchor.timestampSec)) {
      if (!failures.includes(`${label}:anchor-conflict`)) failures.push(`${label}:anchor-conflict`);
      return false;
    }
    anchorByBlock.set(anchor.number, anchor);
    return true;
  }
  async function captureRange(filter: Filter, label: string) {
    let before: BlockAnchor | undefined;
    let start: BlockAnchor | undefined;
    try {
      before = await reader.getAnchor(filter.toBlock);
      start = await reader.getAnchor(filter.fromBlock);
      if (!observeAnchor(before, label) || !observeAnchor(start, label))
        throw new RpcFailure('invalid-time-anchors');
      if (
        start.timestampSec < 0 ||
        (start.timestampSec === 0 && start.number !== 0n) ||
        start.timestampSec > before.timestampSec
      )
        throw new RpcFailure('invalid-time-anchors');
    } catch (e) {
      failures.push(`${label}:${classifyRpcError(e).kind}`);
      return;
    }
    let fetched: FetchResult;
    try {
      fetched = await fetchBoundedLogs(
        reader,
        filter,
        config.logResponseGuard,
        BigInt(config.maxRangeBlocks),
      );
    } catch (error) {
      const reason = classifyRpcError(error).kind;
      failures.push(`${label}:${reason}`);
      fetched = {
        logs: [],
        complete: false,
        ranges: [],
        failures: [{ fromBlock: filter.fromBlock, toBlock: filter.toBlock, reason }],
      };
    }
    // Only the small set of boundaries inside this captured range is resolved.
    try {
      for (
        let minute = Math.floor(start.timestampSec / 60) * 60 + 60;
        minute <= before.timestampSec;
        minute += 60
      ) {
        const boundary = await resolver.resolveMinuteBoundary(minute, {
          fromBlock: filter.fromBlock,
          toBlock: filter.toBlock,
        });
        timeEvidence.push({ ...boundary, source: 'minute-boundary' });
      }
      for (const anchor of resolver.queriedAnchors) observeAnchor(anchor, label);
    } catch (e) {
      failures.push(`${label}:time-unresolved:${classifyRpcError(e).kind}`);
    }
    let stable = false;
    try {
      const finalEnd = await reader.getAnchor(filter.toBlock);
      const finalStart = await reader.getAnchor(filter.fromBlock);
      const consistent = observeAnchor(finalEnd, label) && observeAnchor(finalStart, label);
      stable = consistent && finalEnd.hash === before.hash && finalStart.hash === start.hash;
      if (!stable && !failures.includes(`${label}:anchor-conflict`))
        failures.push(`${label}:anchor-conflict`);
    } catch (e) {
      failures.push(`${label}:${classifyRpcError(e).kind}`);
    }
    const complete = stable && fetched.complete;
    if (!complete) failures.push(`${label}:incomplete-range`);
    const file = saveJson(resolve(runDir, `${label}.logs.json`), fetched.logs, runDir);
    files.push(file);
    rangeEvidence.push({
      label,
      filter,
      start,
      end: before,
      complete,
      stable,
      successfulRanges: fetched.ranges,
      failures: fetched.failures,
      file,
    });
    allLogs.push(...fetched.logs);
  }
  await captureRange(filters, 'primary');
  if (options.supplementHistory !== false) {
    // Each configured seed gets a bounded Manager Initialize query around its documented birth hint.
    const resolvedSeeds = new Map<string, BlockAnchor>();
    for (const [index, hint] of config.v4PoolHistoryHints.entries()) {
      const label = `seed-${index + 1}-supplement`;
      try {
        const at = await resolver.resolveBlockAtOrAfter(hint.timestampSec);
        resolvedSeeds.set(hint.poolId.toLowerCase(), at);
        for (const anchor of resolver.queriedAnchors) observeAnchor(anchor, label);
        await captureRange(
          {
            fromBlock: at.number > 20n ? at.number - 20n : 0n,
            toBlock: at.number + 300n,
            address: [config.v4Manager],
            topics: [initializeTopic, hint.poolId],
          },
          label,
        );
      } catch (e) {
        failures.push(`${label}:${classifyRpcError(e).kind}`);
      }
    }
    if (
      !allLogs.some(
        (log) =>
          config.v3Pools.some((pool) => pool.toLowerCase() === log.address.toLowerCase()) &&
          log.topics[0]?.toLowerCase() === v3SwapTopic,
      )
    ) {
      const firstSeed = resolvedSeeds.get(config.v4PoolIds[0]!.toLowerCase());
      if (firstSeed) {
        await captureRange(
          {
            fromBlock: firstSeed.number > 20n ? firstSeed.number - 20n : 0n,
            toBlock: firstSeed.number + 300n,
            address: config.v3Pools,
            topics: [v3CaptureTopics],
          },
          'v3-birth-supplement',
        );
      } else failures.push('v3-birth-supplement:seed-anchor-unavailable');
    }
  }
  const unique = new Map<string, RawLog>();
  for (const log of allLogs) {
    const key = eventKey(log);
    const old = unique.get(key);
    if (old && encodeJson(old) !== encodeJson(log)) failures.push('conflicting-duplicate-log');
    unique.set(key, log);
  }
  const logs = [...unique.values()].sort((a, b) =>
    a.blockNumber < b.blockNumber
      ? -1
      : a.blockNumber > b.blockNumber
        ? 1
        : a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex,
  );
  const classified = categorizeLogs(logs, config);
  files.push(saveJson(resolve(runDir, 'logs.json'), logs, runDir));
  files.push(saveJson(resolve(runDir, 'anchors.json'), observedAnchors, runDir));
  files.push(saveJson(resolve(runDir, 'time-boundaries.json'), timeEvidence, runDir));
  const manifest = {
    schemaVersion: 'p0.1',
    pathBase: 'manifest-directory',
    chainId: CHAIN_ID,
    configVersion: config.version,
    sourceAlias: reader.sourceAlias,
    capturedAt: new Date().toISOString(),
    captureMode: options.captureMode,
    supplementalCaptureMode: 'backfill',
    synthetic: false,
    requestedRange: { fromBlock: options.fromBlock, toBlock: options.toBlock },
    filters,
    filterPlanHash: sha256(encodeJson(filters)),
    configHash: sha256(encodeJson(config)),
    abiHashes: {
      v3Pool: sha256(encodeJson(v3PoolAbi)),
      v4Manager: sha256(encodeJson(v4ManagerAbi)),
    },
    rangeEvidence,
    files,
    ...classified,
    completeness: failures.length || classified.errors.length ? 'incomplete' : 'complete',
    failures,
    acceptancePassed:
      !failures.length &&
      !classified.errors.length &&
      !classified.missing.length &&
      classified.seedVerifications.every((seed) => seed.status === 'verified'),
    note: 'V4 Manager-wide protocol fixtures include pools outside AMC watchlist. No heat/volume metrics or trades. Complete means RPC coverage for declared ranges only.',
    meter: reader.meter.summary(),
  };
  saveJson(resolve(runDir, 'manifest.json'), manifest, runDir);
  return manifest;
}
