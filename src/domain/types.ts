import type { Address, Hex } from 'viem';
import type { CHAIN_ID } from './chain.js';
// P1-P4 contracts declared ahead of their implementations.
export type PoolRef =
  | { chainId: typeof CHAIN_ID; protocol: 'v3'; address: Address }
  | { chainId: typeof CHAIN_ID; protocol: 'v4'; manager: Address; poolId: Hex };
export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};
export type LogRef = {
  blockHash: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
};
export type BlockAnchor = { number: bigint; hash: Hex; timestampSec: number };
export type WatchScopeId = string;
export type RawLog = LogRef & {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  rawBlockTimestamp: Hex | null;
};
export type LogTime = {
  minuteStartSec: number | null;
  exactTimestampSec: number | null;
  source: 'log-verified' | 'minute-boundary' | 'unresolved';
};
export type MinuteBoundary = {
  timestampSec: number;
  firstBlock: bigint;
  before: BlockAnchor;
  at: BlockAnchor;
};
export type RangeBatch = {
  id: string;
  scopeId: WatchScopeId;
  fromBlock: bigint;
  toBlock: bigint;
  end: BlockAnchor;
  previous: BlockAnchor | null;
  logs: readonly RawLog[];
  observedAtMs: number;
  captureMode: 'live' | 'backfill' | 'synthetic';
  filterPlanHash: string;
  manifestHash: string;
  completeness: 'complete' | 'incomplete';
};
export type RangeChangeSet = {
  added: readonly LogRef[];
  removed: readonly LogRef[];
  retimed: readonly LogRef[];
  affectedFromBlock: bigint;
};
export type Quality = {
  coverage: 'complete' | 'gap' | 'warming' | 'rechecking';
  timing: 'second' | 'minute' | 'unresolved';
  valuation: 'usd-estimate' | 'usdg-only' | 'unpriced';
};
export type Swap = {
  kind: 'swap';
  ref: LogRef;
  time: LogTime;
  pool: PoolRef;
  rawAmount0: bigint;
  rawAmount1: bigint;
  tokenIn: Address;
  amountIn: bigint;
  tokenOut: Address;
  amountOut: bigint;
  sqrtPriceX96After: bigint;
  liquidityAfter: bigint;
  tickAfter: number;
  effectiveSwapFeePips: number | null;
};
export type LiquidityChange = {
  kind: 'liquidity';
  ref: LogRef;
  time: LogTime;
  pool: PoolRef;
  tickLower: number;
  tickUpper: number;
  delta: bigint;
  /** V3 position owner; V4 caller/sender, which may be a router. Never a cross-protocol user count. */
  actor: Address;
  salt: Hex | null;
};
export type AncillaryEvent = {
  kind: 'initialize' | 'collect' | 'donate' | 'other' | 'swap-nontrade';
  ref: LogRef;
  time: LogTime;
  pool: PoolRef | null;
  decoded: Readonly<Record<string, string | number | boolean>>;
};
export type PoolEvent = Swap | LiquidityChange | AncillaryEvent;
export type PoolObservation = {
  pool: PoolRef;
  lastSwap: Swap | null;
  lastLiquidityAction: LiquidityChange | null;
};
export type QuoteObservation = {
  token: Address;
  quote: Address;
  numerator: bigint;
  denominator: bigint;
  effectiveAt: LogRef;
  time: LogTime;
  source: string;
  maxAgeSec: number;
};
export type Alert = {
  id: string;
  revision: number;
  pool: PoolRef;
  kind: 'candidate' | 'hot' | 'reheat' | 'cooling' | 'liquidity-watch' | 'retracted';
  atBatchId: string;
  atBlockHash: Hex;
  atBlockNumber: bigint;
  observedAtMs: number;
  windowStartSec: number;
  windowEndSec: number;
  finality: 'provisional';
  quality: Quality;
  reasonCodes: readonly string[];
  evidenceEventIds: readonly string[];
  metrics: Readonly<Record<string, string | null>>;
};
export interface ChainReader {
  getAnchor(block: bigint | 'latest'): Promise<BlockAnchor>;
  getLogs(filter: {
    fromBlock: bigint;
    toBlock: bigint;
    address: readonly Address[];
    topics: readonly (Hex | readonly Hex[] | null)[];
  }): Promise<readonly RawLog[]>;
}
export interface RangeStore {
  saveRaw(batch: RangeBatch): void;
  acceptedTip(scopeId: WatchScopeId): BlockAnchor | null;
  acceptRange(batch: RangeBatch): RangeChangeSet;
  invalidateAfter(scopeId: WatchScopeId, anchor: BlockAnchor): void;
}
export interface PoolDecoder {
  decode(log: RawLog, time: LogTime, pool: PoolRef): PoolEvent;
}
export interface Clock {
  nowMs(): number;
}
