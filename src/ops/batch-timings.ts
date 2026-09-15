import type { WorkCounts } from './work-counters.js';

/** Stages measured at independent real boundaries of one live batch. */
export type BatchStage =
  | 'rpcAcquisition'
  | 'rawPersist'
  | 'artifactPersist'
  | 'registry'
  | 'projection'
  | 'coverage'
  | 'valuation'
  | 'windows'
  | 'signals'
  | 'commitOther'
  | 'notify';

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Measure a stage only when the caller is inside a timed batch. Offline readers
 * (CLI report, dashboard snapshot, replay) share these code paths and pass no
 * timings, so they neither pay for a clock read nor appear in a batch breakdown.
 */
export function measureStage<T>(
  timings: BatchTimings | undefined,
  stage: BatchStage,
  work: () => T,
): T {
  return timings ? timings.measure(stage, work) : work();
}

/**
 * Per-batch stage timing for the live recorder.
 *
 * Stages are measured where the work really happens:
 * - `rpcAcquisition`: the range fetch itself (the only pure network stage).
 * - `rawPersist`: writing raw evidence before anything is committed.
 * - `artifactPersist`: writing the per-range artifact JSON.
 * - `registry`: pool registration reads and merges (before the fetch, and after it
 *   when new registrations arrive, so the stage is visited twice per batch).
 * - `projection`: accepting the range and syncing/reading the live projection cursor.
 * - `coverage`: minute/time evidence — local SQL plus the minute-boundary anchor
 *   RPCs it has to verify, so it is deliberately outside the local-processing total.
 * - `valuation`, `windows`: valuing swaps and assembling rolling/minute windows.
 * - `signals`: signal evaluation, snapshots and alert drafts for every pool window.
 * - `commitOther`: remaining work inside the commit that no stage above owns.
 * - `notify`: alert delivery for the batch.
 *
 * Three rules keep the numbers honest:
 *
 * - `snapshot()` is a breakdown, not a decomposition. A stage visited twice and a stage
 *   whose work contains another measured stage each add their own wall time, so the
 *   totals must never be summed to explain a batch.
 * - The batch's local-processing total is the single independent wall-clock number
 *   (`completeEvidenceAtMs` -> `outboxDurableAtMs`, the window the aggregate report and
 *   the acceptance target use). The stages explain that total; they do not add up to it.
 * - `writeLatencyMs` keeps its legacy definition (raw-save duration plus the commit
 *   duration, so it includes the CPU and SQL inside the commit transaction). It overlaps
 *   local processing and must never be added to it.
 */
export class BatchTimings {
  private readonly stages = new Map<BatchStage, number>();
  private readonly clock: () => number;

  /** `now` defaults to a monotonic clock; tests inject a virtual one. */
  constructor(now: () => number = () => performance.now()) {
    this.clock = now;
  }

  measure<T>(stage: BatchStage, work: () => T): T {
    const startedAt = this.clock();
    try {
      return work();
    } finally {
      this.record(stage, this.clock() - startedAt);
    }
  }

  async measureAsync<T>(stage: BatchStage, work: () => Promise<T>): Promise<T> {
    const startedAt = this.clock();
    try {
      return await work();
    } finally {
      this.record(stage, this.clock() - startedAt);
    }
  }

  /** Measured milliseconds per stage. Stages that never ran are absent, not zero. */
  snapshot(): Partial<Record<BatchStage, number>> {
    return Object.fromEntries([...this.stages].map(([stage, ms]) => [stage, round3(ms)]));
  }

  private record(stage: BatchStage, elapsedMs: number): void {
    // A monotonic clock cannot go backwards; a negative delta would mean the caller
    // injected a misbehaving clock, so it is kept visible instead of clamped away.
    this.stages.set(stage, (this.stages.get(stage) ?? 0) + elapsedMs);
  }
}

/** Per-batch timing record shared by the telemetry manifest and the per-batch log line. */ export interface BatchTimingRecord {
  stageMs: Partial<Record<BatchStage, number>>;
  /** Acceptance metric: one independent wall-clock total for a batch's local work. */
  localProcessingMs: number | null;
  headObservedAgeMs: number | null;
  acceptedDataAgeMs: number | null;
  counts: WorkCounts;
}
