export interface BlockWatermark {
  blockNumber: bigint;
  blockHash: string;
  timestampSec: number | null;
}

export interface HealthSnapshotInput {
  sampledAtMs: number;
  sourceAlias: string;
  chainId: number | null;
  head: BlockWatermark | null;
  lastHeadAtMs: number | null;
  scanned: BlockWatermark | null;
  rawSaved: BlockWatermark | null;
  projected: BlockWatermark | null;
  projectedSourceVerified: boolean;
  projectedCursorVerified: boolean;
  queueDepth: number;
  inflight: number;
  rpc: Readonly<Record<string, number>>;
  writeLatencyMs: number | null;
  processingLatencyMs: number | null;
  dbBytes: number;
  walBytes: number;
  outboxPending: number;
  gap?: boolean | null;
  runtimeState?: string | null;
}

export interface HealthSnapshot extends Omit<HealthSnapshotInput, 'projected' | 'gap'> {
  projected: BlockWatermark | null;
  gap: boolean | null;
  headGapBlocks: bigint | null;
  headGapSeconds: number | null;
  headStatus: 'observed' | null;
  headObservationAgeMs: number | null;
}

export function healthSnapshot(input: HealthSnapshotInput): HealthSnapshot {
  const validGap =
    input.head !== null &&
    input.scanned !== null &&
    input.head.blockNumber >= input.scanned.blockNumber;
  return {
    ...input,
    rpc: { ...input.rpc },
    gap: input.gap ?? null,
    projected:
      input.projectedSourceVerified && input.projectedCursorVerified ? input.projected : null,
    headGapBlocks: validGap ? input.head!.blockNumber - input.scanned!.blockNumber : null,
    headStatus: input.head === null ? null : 'observed',
    headObservationAgeMs:
      input.head !== null && input.lastHeadAtMs !== null && input.sampledAtMs >= input.lastHeadAtMs
        ? input.sampledAtMs - input.lastHeadAtMs
        : null,
    headGapSeconds:
      validGap && input.head!.timestampSec !== null && input.scanned!.timestampSec !== null
        ? Math.max(0, input.head!.timestampSec - input.scanned!.timestampSec)
        : null,
  };
}

export type OpsPhase = 'startup' | 'backfill' | 'steady';
export interface BatchTimingSample {
  phase: OpsPhase;
  acquisitionStartedAtMs?: number | null;
  headObservedAtMs?: number | null;
  notifyAttemptCompletedAtMs?: number | null;
  rpcAcquisitionMs: number | null;
  /** Time when a COMPLETE range and all required minute evidence were available. */
  completeEvidenceAtMs: number | null;
  outboxDurableAtMs: number | null;
  deliveredAtMs: number | null;
}
export interface MeterCheckpoint {
  phase: OpsPhase;
  atMs: number;
  calls: number;
  responseBytes: number;
  billingUnits?: number | null;
  methods: Readonly<Record<string, number>>;
}
export interface DiskCheckpoint {
  phase: OpsPhase;
  atMs: number;
  dbBytes: number;
  walBytes: number;
}
export interface VerifiedRates {
  currency: string;
  costPerBillingUnit: number;
  verifiedAtMs: number;
}
export interface OpsReportInput {
  sourceAlias: string;
  startedAtMs: number;
  finishedAtMs: number;
  batchTimings: readonly BatchTimingSample[];
  healthSamples: readonly HealthSnapshot[];
  meterCheckpoints: readonly MeterCheckpoint[];
  diskCheckpoints: readonly DiskCheckpoint[];
  verifiedRates: VerifiedRates | null;
}

interface PercentileSummary {
  sampleSize: number;
  p95: number | null;
}
interface UsageSummary {
  durationMs: number;
  calls: number;
  responseBytes: number;
  billingUnits: number | null;
  methods: Record<string, number>;
  callsPerHour: number | null;
  responseBytesPerHour: number | null;
}
interface DiskSummary {
  durationMs: number;
  /** Signed net change across observed intervals. */
  growthBytes: number;
  growthBytesPerHour: number | null;
  /** Sum of positive interval changes before WAL shrink/checkpoint reductions. */
  positiveGrowthBytes: number;
  positiveGrowthBytesPerHour: number | null;
}

const percentile = (values: readonly number[]): PercentileSummary => {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  return {
    sampleSize: sorted.length,
    p95: sorted.length === 0 ? null : sorted[Math.ceil(0.95 * sorted.length) - 1]!,
  };
};

function phaseIntervals<T extends { phase: OpsPhase; atMs: number }>(
  checkpoints: readonly T[],
  phase: OpsPhase,
): readonly (readonly [T, T])[] {
  return checkpoints
    .toSorted((a, b) => a.atMs - b.atMs)
    .flatMap((current, index, all) => {
      const next = all[index + 1];
      return current.phase === phase && next?.phase === phase && next.atMs >= current.atMs
        ? [[current, next] as const]
        : [];
    });
}

function phaseUsage(checkpoints: readonly MeterCheckpoint[], phase: OpsPhase): UsageSummary {
  const intervals = phaseIntervals(checkpoints, phase);
  let durationMs = 0,
    calls = 0,
    responseBytes = 0;
  const methods: Record<string, number> = {};
  let billingUnits: number | null = intervals.length === 0 ? null : 0;
  for (const [first, last] of intervals) {
    durationMs += last.atMs - first.atMs;
    calls += Math.max(0, last.calls - first.calls);
    responseBytes += Math.max(0, last.responseBytes - first.responseBytes);
    for (const name of new Set([...Object.keys(first.methods), ...Object.keys(last.methods)]))
      methods[name] =
        (methods[name] ?? 0) + Math.max(0, (last.methods[name] ?? 0) - (first.methods[name] ?? 0));
    if (first.billingUnits == null || last.billingUnits == null) billingUnits = null;
    else if (billingUnits !== null)
      billingUnits += Math.max(0, last.billingUnits - first.billingUnits);
  }
  return {
    durationMs,
    calls,
    responseBytes,
    billingUnits,
    methods,
    callsPerHour: durationMs > 0 ? (calls * 3_600_000) / durationMs : null,
    responseBytesPerHour: durationMs > 0 ? (responseBytes * 3_600_000) / durationMs : null,
  };
}

function phaseDisk(checkpoints: readonly DiskCheckpoint[], phase: OpsPhase): DiskSummary {
  const intervals = phaseIntervals(checkpoints, phase);
  let durationMs = 0,
    growthBytes = 0,
    positiveGrowthBytes = 0;
  for (const [first, last] of intervals) {
    durationMs += last.atMs - first.atMs;
    const change = last.dbBytes + last.walBytes - first.dbBytes - first.walBytes;
    growthBytes += change;
    positiveGrowthBytes += Math.max(0, change);
  }
  return {
    durationMs,
    growthBytes,
    growthBytesPerHour: durationMs > 0 ? (growthBytes * 3_600_000) / durationMs : null,
    positiveGrowthBytes,
    positiveGrowthBytesPerHour:
      durationMs > 0 ? (positiveGrowthBytes * 3_600_000) / durationMs : null,
  };
}

export function aggregateOpsReport(input: OpsReportInput) {
  const usage = {
    startup: phaseUsage(input.meterCheckpoints, 'startup'),
    backfill: phaseUsage(input.meterCheckpoints, 'backfill'),
    steady: phaseUsage(input.meterCheckpoints, 'steady'),
  };
  const disk = {
    startup: phaseDisk(input.diskCheckpoints, 'startup'),
    backfill: phaseDisk(input.diskCheckpoints, 'backfill'),
    steady: phaseDisk(input.diskCheckpoints, 'steady'),
  };
  const representedPhases = new Set(input.meterCheckpoints.map((x) => x.phase));
  const units = Object.entries(usage)
    .filter(([phase]) => representedPhases.has(phase as OpsPhase))
    .map(([, value]) => value.billingUnits);
  const monetaryCost =
    input.verifiedRates && units.every((x) => x !== null)
      ? {
          currency: input.verifiedRates.currency,
          amount:
            units.reduce<number>((sum, x) => sum + x!, 0) * input.verifiedRates.costPerBillingUnit,
          verifiedAtMs: input.verifiedRates.verifiedAtMs,
        }
      : null;
  return {
    version: 1,
    sourceAlias: input.sourceAlias,
    startedAtMs: input.startedAtMs,
    finishedAtMs: input.finishedAtMs,
    latency: {
      localProcessingMs: percentile(
        input.batchTimings.flatMap((x) =>
          x.completeEvidenceAtMs !== null &&
          x.outboxDurableAtMs !== null &&
          x.outboxDurableAtMs >= x.completeEvidenceAtMs
            ? [x.outboxDurableAtMs - x.completeEvidenceAtMs]
            : [],
        ),
      ),
      rpcAcquisitionMs: percentile(
        input.batchTimings.flatMap((x) =>
          x.rpcAcquisitionMs === null ? [] : [x.rpcAcquisitionMs],
        ),
      ),
      totalDeliveryMs: percentile(
        input.batchTimings.flatMap((x) =>
          x.acquisitionStartedAtMs != null &&
          x.deliveredAtMs !== null &&
          x.deliveredAtMs >= x.acquisitionStartedAtMs
            ? [x.deliveredAtMs - x.acquisitionStartedAtMs]
            : [],
        ),
      ),
      acquisitionToNotifyAttemptMs: percentile(
        input.batchTimings.flatMap((x) =>
          x.acquisitionStartedAtMs != null &&
          x.notifyAttemptCompletedAtMs != null &&
          x.notifyAttemptCompletedAtMs >= x.acquisitionStartedAtMs
            ? [x.notifyAttemptCompletedAtMs - x.acquisitionStartedAtMs]
            : [],
        ),
      ),
      headLagBlocks: percentile(
        input.healthSamples.flatMap((x) =>
          x.headGapBlocks === null ? [] : [Number(x.headGapBlocks)],
        ),
      ),
      headLagSeconds: percentile(
        input.healthSamples.flatMap((x) => (x.headGapSeconds === null ? [] : [x.headGapSeconds])),
      ),
    },
    usage,
    disk,
    monetaryCost,
  };
}
