import { parseRpcQuantity } from '../domain/hex.js';
import { formatLog, keccak256, type Hex } from 'viem';
import type { ChainConfig } from '../config/chain.js';
import type { BlockAnchor, RawLog } from '../domain/types.js';
import { encodeJson } from '../domain/json.js';
import type { EvidenceReader } from '../rpc/client.js';
import { classifyRpcError, RpcFailure, type Support } from '../rpc/errors.js';
import { fetchBoundedLogs } from '../ingest/fetch-range.js';
import { sha256 } from './files.js';
import { v3PoolAbi } from '../protocols/uniswap-v3/abi.js';
import { v4ManagerAbi } from '../protocols/uniswap-v4/abi.js';
export type TimestampQuality = 'valid' | 'missing' | 'zero' | 'mismatch';
export function timestampQuality(
  raw: string | null,
  blockHash: string,
  anchor: { hash: string; timestampSec: number },
): TimestampQuality {
  if (raw === null) return 'missing';
  try {
    const value = BigInt(raw);
    if (value === 0n) return 'zero';
    return value === BigInt(anchor.timestampSec) &&
      blockHash.toLowerCase() === anchor.hash.toLowerCase() &&
      anchor.timestampSec > 0
      ? 'valid'
      : 'mismatch';
  } catch {
    return 'mismatch';
  }
}
export function compareLogSets(a: readonly unknown[], b: readonly unknown[]): boolean {
  const first = [...new Set(a.map(encodeJson))].sort();
  const second = [...new Set(b.map(encodeJson))].sort();
  return first.length === second.length && first.every((v, i) => v === second[i]);
}
interface Capability {
  status: Support;
  required: boolean;
  at: string;
  evidenceFile: string;
  detail: unknown;
}
export interface CapabilityReport {
  schemaVersion: 'p0.1';
  sourceAlias: string;
  chainId: number | null;
  at: string;
  requiredPassed: boolean;
  capabilities: Record<string, Capability>;
  maxLogsPerResponse: number | null;
  logResponseGuard: number;
  logTimestamp: {
    sampled: number;
    quality: Partial<Record<TimestampQuality, number>>;
    sdkPreservesField: boolean | null;
    fallback: string;
  };
  meter: ReturnType<EvidenceReader['meter']['summary']>;
  configHash: string;
  abiHashes: { v3Pool: string; v4Manager: string };
}
export async function probeCapabilities(
  reader: EvidenceReader,
  options: { config: ChainConfig; evidenceFile: string },
): Promise<CapabilityReport> {
  const { config, evidenceFile } = options;
  const capabilities: Record<string, Capability> = {};
  let chainId: number | null = null;
  let head: BlockAnchor | undefined;
  async function probe<T>(
    name: string,
    required: boolean,
    work: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      const detail = await work();
      capabilities[name] = {
        status: 'supported',
        required,
        at: new Date().toISOString(),
        evidenceFile,
        detail,
      };
      return detail;
    } catch (error) {
      const e = classifyRpcError(error);
      if (e.kind === 'budget') throw e;
      capabilities[name] = {
        status: e.status,
        required,
        at: new Date().toISOString(),
        evidenceFile,
        detail: { kind: e.kind },
      };
      return undefined;
    }
  }
  const identity = await probe('chainId', true, async () => {
    const value = await reader.request('eth_chainId', []);
    if (parseRpcQuantity(value) !== BigInt(config.chainId)) throw new RpcFailure('chain-mismatch');
    return config.chainId;
  });
  if (identity !== undefined) chainId = identity;
  // Wrong or unavailable chain must never query the configured addresses.
  if (chainId !== null) head = await probe('recentAnchor', true, () => reader.getAnchor('latest'));
  const samples: RawLog[] = [];
  if (head) {
    for (const size of [10, 20, 100]) {
      const fromBlock = head.number - BigInt(size) + 1n;
      await probe(`rangeLogs${size}`, true, async () => {
        const filter = {
          fromBlock,
          toBlock: head!.number,
          address: [config.v4Manager],
          topics: [],
        };
        try {
          const logs = await reader.getLogs(filter);
          if (logs.length >= config.logResponseGuard) throw new RpcFailure('range-limit');
          if (size === 20) samples.push(...logs);
          return {
            fromBlock,
            toBlock: head!.number,
            count: logs.length,
            decodedResponseBytes: Buffer.byteLength(encodeJson(logs)),
            direct: { status: 'supported', kind: null },
            adaptive: { complete: true, ranges: 1 },
          };
        } catch (error) {
          const direct = classifyRpcError(error);
          if (direct.kind !== 'range-limit') throw direct;
          const adaptive = await fetchBoundedLogs(reader, filter, config.logResponseGuard);
          if (!adaptive.complete)
            throw new RpcFailure(adaptive.failures[0]?.reason ?? 'incomplete-range');
          if (size === 20) samples.push(...adaptive.logs);
          return {
            fromBlock,
            toBlock: head!.number,
            count: adaptive.logs.length,
            decodedResponseBytes: Buffer.byteLength(encodeJson(adaptive.logs)),
            direct: { status: direct.status, kind: direct.kind },
            adaptive: { complete: true, ranges: adaptive.ranges.length },
          };
        }
      });
    }
    await probe('rangeUnionConsistency', true, async () => {
      const f = {
        fromBlock: head!.number - 19n,
        toBlock: head!.number,
        address: [config.v4Manager],
        topics: [],
      };
      const full = await fetchBoundedLogs(reader, f, config.logResponseGuard);
      const left = await fetchBoundedLogs(
        reader,
        { ...f, toBlock: head!.number - 10n },
        config.logResponseGuard,
      );
      const right = await fetchBoundedLogs(
        reader,
        { ...f, fromBlock: head!.number - 9n },
        config.logResponseGuard,
      );
      const after = await reader.getAnchor(head!.number);
      if (
        !full.complete ||
        !left.complete ||
        !right.complete ||
        !compareLogSets(full.logs, [...left.logs, ...right.logs]) ||
        after.hash !== head!.hash
      )
        throw new Error('Range inconsistent');
      return {
        equal: true,
        full: full.logs.length,
        union: left.logs.length + right.logs.length,
        adaptive: true,
        coverage: 'tested range only; provider upper limit unknown',
      };
    });
    await probe('currentCode', true, async () => {
      const code = String(
        await reader.request('eth_getCode', [config.v4Manager, '0x' + head!.number.toString(16)]),
      ) as Hex;
      if (!/^0x(?:[\da-f]{2})*$/i.test(code)) throw new Error('Malformed code');
      return { bytes: (code.length - 2) / 2, codeHash: keccak256(code) };
    });
    // decimals() selector is stable ERC20 ABI encoding; identity module validates the returned value.
    await probe('currentCall', true, async () => {
      const raw = String(
        await reader.request('eth_call', [
          { to: config.tokens.AMC, data: '0x313ce567' },
          '0x' + head!.number.toString(16),
        ]),
      ) as Hex;
      const decimals = Number(BigInt(raw));
      if (!Number.isSafeInteger(decimals)) throw new Error('Malformed decimals');
      return { responseHash: keccak256(raw), decimals };
    });
    const historical = head.number > 1_000_000n ? head.number - 1_000_000n : 0n;
    await probe('historicalAnchor', false, () => reader.getAnchor(historical));
    await probe('historicalLogs', false, async () => {
      const logs = await reader.getLogs({
        fromBlock: historical,
        toBlock: historical + 19n,
        address: [config.v4Manager],
        topics: [],
      });
      return {
        fromBlock: historical,
        toBlock: historical + 19n,
        count: logs.length,
        scope: 'one sampled range; not full P5 coverage',
      };
    });
  }
  const quality: Partial<Record<TimestampQuality, number>> = {};
  let sdkPreservesField: boolean | null = null;
  const sample = [
    ...new Map(
      [samples[0], samples.at(-1)]
        .filter((v): v is RawLog => !!v)
        .map((log) => [
          log.blockHash.toLowerCase() +
            ':' +
            log.transactionHash.toLowerCase() +
            ':' +
            log.logIndex,
          log,
        ]),
    ).values(),
  ];
  for (const log of sample) {
    await probe(`timestampAnchor-${log.blockNumber}`, false, async () => {
      const anchor = await reader.getAnchor(log.blockNumber);
      const q = timestampQuality(log.rawBlockTimestamp, log.blockHash, anchor);
      quality[q] = (quality[q] ?? 0) + 1;
      const formatted = formatLog({
        blockTimestamp: log.rawBlockTimestamp,
      } as never) as unknown as Record<string, unknown>;
      sdkPreservesField =
        (sdkPreservesField ?? true) &&
        Object.hasOwn(formatted, 'blockTimestamp') &&
        (log.rawBlockTimestamp === null
          ? formatted.blockTimestamp === null
          : formatted.blockTimestamp === BigInt(log.rawBlockTimestamp));
      return { blockNumber: log.blockNumber, raw: log.rawBlockTimestamp, quality: q, anchor };
    });
  }
  for (const name of ['historicalState', 'websocket', 'trace'])
    capabilities[name] = {
      status: 'unknown',
      required: false,
      at: new Date().toISOString(),
      evidenceFile,
      detail: 'not probed: optional for P0',
    };
  return {
    schemaVersion: 'p0.1',
    sourceAlias: reader.sourceAlias,
    chainId,
    at: new Date().toISOString(),
    requiredPassed:
      !!head &&
      Object.values(capabilities)
        .filter((c) => c.required)
        .every((c) => c.status === 'supported'),
    capabilities,
    maxLogsPerResponse: null,
    logResponseGuard: config.logResponseGuard,
    logTimestamp: {
      sampled: Object.values(quality).reduce((a, b) => a + b, 0),
      quality,
      sdkPreservesField,
      fallback:
        quality.valid === sample.length && sample.length > 0
          ? 'sample-valid; verify subsequent ranges'
          : 'P1 minute-boundary index; no per-block headers',
    },
    meter: reader.meter.summary(),
    configHash: sha256(encodeJson(config)),
    abiHashes: {
      v3Pool: sha256(encodeJson(v3PoolAbi)),
      v4Manager: sha256(encodeJson(v4ManagerAbi)),
    },
  };
}
