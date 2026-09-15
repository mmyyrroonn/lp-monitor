/**
 * Optional structural work counters for the offline live-runtime benchmarks.
 *
 * The sink is disabled by default, so production paths pay a single null check per counted
 * site. Counters are incremented where the real work happens (SQL reads, registry
 * serialization, raw batch decoding, valuation and pool evaluation, metadata candidate
 * selection, registry journal rows) so a caller cannot report an idealized number.
 */
export type WorkCounts = {
  /** Pool registration rows read from SQLite. */
  registryRowsRead: number;
  /** Pool registration rows serialized to JSON for comparison or cursor persistence. */
  registryRowsSerialized: number;
  /** Recorded range batches decoded from inline JSON or compact payload references. */
  rawBatchDecodes: number;
  /** Swap valuations performed by the notional/valuation path. */
  valuationComputes: number;
  /** Pools whose metric windows were assembled. */
  evaluatedPools: number;
  /** Token metadata candidates proposed to the refresh queue. */
  metadataCandidates: number;
  /** Minute indexes built over a coverage set (one per coverage set per build). */
  coverageIndexBuilds: number;
  /** Registry journal rows read to advance a live registry instead of reloading the catalogue. */
  registryChangesRead: number;
  /** Operation request templates rebuilt from a protocol's pool values. */
  operationFilterRebuilds: number;
  /** Pool identity values sorted into a rebuilt operation request template. */
  operationFilterValuesScanned: number;
};

export type WorkCounterKey = keyof WorkCounts;

export const WORK_COUNTER_KEYS: readonly WorkCounterKey[] = [
  'registryRowsRead',
  'registryRowsSerialized',
  'rawBatchDecodes',
  'valuationComputes',
  'evaluatedPools',
  'metadataCandidates',
  'coverageIndexBuilds',
  'registryChangesRead',
  'operationFilterRebuilds',
  'operationFilterValuesScanned',
];

export function emptyWorkCounts(): WorkCounts {
  return {
    registryRowsRead: 0,
    registryRowsSerialized: 0,
    rawBatchDecodes: 0,
    valuationComputes: 0,
    evaluatedPools: 0,
    metadataCandidates: 0,
    coverageIndexBuilds: 0,
    registryChangesRead: 0,
    operationFilterRebuilds: 0,
    operationFilterValuesScanned: 0,
  };
}

type WorkCounterSink = (key: WorkCounterKey, delta: number) => void;

let sink: WorkCounterSink | null = null;

/** Install or clear the counter sink. Pass null to disable counting again. */
export function setWorkCounter(next: WorkCounterSink | null): void {
  sink = next;
}

export function countWork(key: WorkCounterKey, delta = 1): void {
  if (sink !== null) sink(key, delta);
}

/**
 * Collect the structural work of one scope (a live batch, a benchmark round) into a fresh
 * `WorkCounts`. An already installed sink is suspended for the duration and restored by
 * `close()`, so a scope never reports work it did not do — but a nested scope's work is
 * attributed to the inner scope only.
 */
export function openWorkCounts(): { counts: WorkCounts; close: () => void } {
  const counts = emptyWorkCounts();
  const previous = sink;
  sink = (key, delta) => {
    counts[key] += delta;
  };
  return {
    counts,
    close: () => {
      sink = previous;
    },
  };
}
