export type WindowName = '1m' | '5m' | '15m' | '1h';
export interface Metric {
  available: boolean;
  txCount: number | null;
  swapCount: number | null;
  usdMicros: string | null;
  reasons: string[];
  startSec: number;
  endSec: number;
}
export interface TokenMinute {
  minuteStartSec: number;
  status: 'closed' | 'partial' | 'gap' | 'warming';
  txCount: number | null;
  swapCount: number | null;
  usdMicros: string | null;
  reasons: string[];
}
export interface DashboardPool {
  poolId: string;
  protocol: string;
  token0: string;
  token1: string;
  windows: Record<WindowName, Metric>;
  lastSwapTimeSec: number | null;
}
export interface DashboardToken {
  address: string;
  symbol: string;
  category: 'rwa';
  poolIds: string[];
  windows: Record<WindowName, { current: Metric; previous: Metric }>;
  minutes: TokenMinute[];
  pools: DashboardPool[];
}
export interface DashboardCoverage {
  minuteStartSec: number;
  complete: boolean;
  reasons: string[];
}
export interface RuntimeHealth {
  status: 'available' | 'unavailable';
  updatedAtMs: number | null;
  headLagBlocks: number | null;
  headLagSeconds: number | null;
  coverage: string | null;
  runtimeState?: string | null;
  sidecarFreshness?: string | null;
  scannedBlock?: string | null;
  projectedBlock?: string | null;
  outboxPending?: number | null;
  dbBytes?: number | null;
  walBytes?: number | null;
  processingLatencyMs?: number | null;
  rpcCalls?: number | null;
}
export interface DashboardSnapshot {
  status: 'ok' | 'empty' | 'stale' | 'error';
  generatedAtMs: number;
  sourceChainTimeSec: number | null;
  selectedEndSec: number | null;
  availableFromSec: number | null;
  sourceHash: string | null;
  scopeId: string;
  assetVersion: string;
  tokens: DashboardToken[];
  coverage: DashboardCoverage[];
  health: RuntimeHealth;
  message: string | null;
  notes: string[];
}
