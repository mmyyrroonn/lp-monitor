import { afterEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import { openDatabase } from '../../src/storage/database.js';
import { v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';
import { initialSignalConfig } from '../../src/signals/config.js';
import { decodeSignalState, encodeSignalState } from '../../src/signals/codec.js';
import { initialSignalSnapshot } from '../../src/signals/engine.js';
import { commitAcceptedSignalBatch } from '../../src/signals/project.js';
import { LiveProjectionStore } from '../../src/storage/live-projection.js';
import { storedRegistrationJson } from '../../src/storage/registration-codec.js';
import { openWorkCounts } from '../../src/ops/work-counters.js';
import {
  rawLogKey,
  type PersistedPoolRegistration,
  type RecordedRangeBatch,
} from '../../src/storage/manifest.js';
import type { BlockAnchor, LogRef, MinuteBoundary, RawLog } from '../../src/domain/types.js';
import type { AlertRecord, SignalSnapshot } from '../../src/signals/types.js';
import { addr, anchor, hash, metricInput, rwa, usdg } from '../helpers/alert-fixture.js';

/**
 * C3 golden workset: a fixed twelve-pool, multi-batch sample measured through the real pipeline.
 *
 * The sample is the reference output a performance change must reproduce exactly: alert kinds and
 * their outbox order, alert identity/revision/status, retraction reasons, and the business fields
 * of every pool's persisted `SignalSnapshot`. Every literal below was read from a real run of
 * `commitAcceptedSignalBatch`; none of it is hand-written. If a change makes the frozen tables
 * fail, the change moved signal semantics, and re-freezing them is a decision, not a fix.
 *
 * Twelve pools of one RWA/USDG pair (the same asset registry the single-pool fixture uses), with
 * sparse background trading so every pool has closed five-minute windows to baseline against.
 * Three of them carry the behaviours the sample exists to cover:
 *   - alpha walks watch -> candidate -> hot -> cooling -> watch, and the last batch re-fetches the
 *     retained range without its burst logs, so a repaired history retracts every provisional
 *     reminder the sample produced.
 *   - bravo confirms a hot five-minute window that also carries a Mint and a Burn, so the
 *     liquidity actions a workset must not drop are visible in the alert's own window counts.
 *   - charlie is absent from the catalogue until batch 3 registers it, and reaches `candidate` in
 *     that same batch.
 *
 * Nothing here drives `evaluateSignal` directly: every value comes from committing batches exactly
 * as the live recorder does, which is what makes old and new paths comparable.
 */
const POOL_COUNT = 12;
const POOL_NAMES = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
] as const;
const POOLS = Array.from({ length: POOL_COUNT }, (_, index) => addr(10 + index));
/** The pool the catalogue does not hold until batch 3 registers it. */
const NEWCOMER_INDEX = 2;

/** Chain seconds per batch: every watermark is five minutes after the previous one. */
const BATCH_STEP_SEC = 300;
const FIRST_WATERMARK_SEC = 4860;
/** The first minute of retained history, and the minute the first boundary brackets. */
const FIRST_MINUTE_SEC = 120;
const BACKGROUND_STEP_SEC = 300;
const LAST_BACKGROUND_MINUTE_SEC = 8520;
const BATCH_COUNT = 14;
const WATERMARKS = Array.from(
  { length: BATCH_COUNT },
  (_, index) => FIRST_WATERMARK_SEC + index * BATCH_STEP_SEC,
);
/** The final batch re-fetches the whole retained range with alpha's burst removed, same tip. */
const REVISION_WATERMARK_SEC = WATERMARKS.at(-1)! + 60;

type LogKind = 'swap' | 'mint' | 'burn';
type LogSpec = {
  poolIndex: number;
  /** The minute the log is timestamped into, by the fixture's block-timestamp convention. */
  minuteSec: number;
  kind: LogKind;
  /** Position of the block inside its minute; the minute's first block is 0. */
  offset: number;
  usdgUnits: number;
  liquidity?: bigint;
  /** Dropped from the final full re-fetch, which is how the sample exercises a repaired history. */
  removedByRevision?: boolean;
};

function blockFor(spec: Pick<LogSpec, 'minuteSec' | 'offset'>): number {
  return spec.minuteSec - 60 + spec.offset;
}
function transactionHashFor(spec: LogSpec): Hex {
  const kind = spec.kind === 'swap' ? 1 : spec.kind === 'mint' ? 2 : 3;
  return hash(blockFor(spec) * 100 + spec.poolIndex * 4 + kind);
}
function swapLog(pool: Address, spec: LogSpec): RawLog {
  return {
    address: pool,
    blockNumber: BigInt(blockFor(spec)),
    blockHash: hash(blockFor(spec)),
    transactionHash: transactionHashFor(spec),
    transactionIndex: 0,
    logIndex: 0,
    rawBlockTimestamp: '0x0',
    topics: encodeEventTopics({
      abi: v3PoolAbi,
      eventName: 'Swap',
      args: { sender: pool, recipient: pool },
    }) as Hex[],
    data: encodeAbiParameters(
      [
        { type: 'int256' },
        { type: 'int256' },
        { type: 'uint160' },
        { type: 'uint128' },
        { type: 'int24' },
      ],
      [1000000n, -BigInt(spec.usdgUnits) * 1000000n, 2n ** 96n, 1000n, 0],
    ),
  };
}
/** A v3 Mint (positive delta) or Burn (negative delta) on the pool itself. */
function liquidityLog(pool: Address, spec: LogSpec): RawLog {
  const mint = spec.kind === 'mint';
  const amount = spec.liquidity ?? 0n;
  return {
    address: pool,
    blockNumber: BigInt(blockFor(spec)),
    blockHash: hash(blockFor(spec)),
    transactionHash: transactionHashFor(spec),
    transactionIndex: 0,
    logIndex: 0,
    rawBlockTimestamp: '0x0',
    topics: encodeEventTopics({
      abi: v3PoolAbi,
      eventName: mint ? 'Mint' : 'Burn',
      args: { owner: pool, tickLower: -120, tickUpper: 120 },
    }) as Hex[],
    data: encodeAbiParameters(
      mint
        ? [{ type: 'address' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }]
        : [{ type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }],
      mint ? [pool, amount, 1n, 1n] : [amount, 1n, 1n],
    ),
  };
}
function rawLogFor(pool: Address, spec: LogSpec): RawLog {
  return spec.kind === 'swap' ? swapLog(pool, spec) : liquidityLog(pool, spec);
}

const SPECS = new Map<string, LogSpec>();
function addSpec(spec: LogSpec): void {
  SPECS.set(`${spec.poolIndex}:${spec.minuteSec}:${spec.kind}`, spec);
}
for (let poolIndex = 0; poolIndex < POOL_COUNT; poolIndex++)
  for (
    let minuteSec = FIRST_MINUTE_SEC;
    minuteSec <= LAST_BACKGROUND_MINUTE_SEC;
    minuteSec += BACKGROUND_STEP_SEC
  ) {
    // alpha trades only up to its burst: the cooling and expiry half of its chain needs quiet.
    if (poolIndex === 0 && minuteSec > 4620) continue;
    // charlie cannot trade before the batch that registers it, so it has no background at all.
    if (poolIndex === NEWCOMER_INDEX) continue;
    addSpec({ poolIndex, minuteSec, kind: 'swap', offset: poolIndex, usdgUnits: 2000 });
  }
// alpha: candidate at batch 1 (the burst fills the current minute), then hot at batch 2 (the same
// burst fills the five-minute window ending at the next watermark).
addSpec({
  poolIndex: 0,
  minuteSec: 4800,
  kind: 'swap',
  offset: 1,
  usdgUnits: 30_000,
  removedByRevision: true,
});
for (const minuteSec of [4860, 4920, 4980, 5040, 5100])
  addSpec({
    poolIndex: 0,
    minuteSec,
    kind: 'swap',
    offset: 1,
    usdgUnits: 30_000,
    removedByRevision: true,
  });
// bravo: a hot five-minute window at batch 8 that also carries a Mint and a Burn.
for (const minuteSec of [6660, 6720, 6780, 6840, 6900])
  addSpec({ poolIndex: 1, minuteSec, kind: 'swap', offset: 1, usdgUnits: 30_000 });
addSpec({ poolIndex: 1, minuteSec: 6840, kind: 'mint', offset: 2, usdgUnits: 0, liquidity: 500n });
addSpec({ poolIndex: 1, minuteSec: 6900, kind: 'burn', offset: 3, usdgUnits: 0, liquidity: 300n });
// charlie: discovered by the log at block 5282, trading 30k at the batch-3 watermark block itself.
addSpec({ poolIndex: NEWCOMER_INDEX, minuteSec: 5340, kind: 'swap', offset: 2, usdgUnits: 2000 });
addSpec({ poolIndex: NEWCOMER_INDEX, minuteSec: 5460, kind: 'swap', offset: 0, usdgUnits: 30_000 });

const ALL_SPECS = [...SPECS.values()].sort(
  (left, right) => blockFor(left) - blockFor(right) || left.poolIndex - right.poolIndex,
);
function logsBetween(fromBlock: number, toBlock: number, includeRemoved: boolean): RawLog[] {
  return ALL_SPECS.filter(
    (spec) =>
      (includeRemoved || !spec.removedByRevision) &&
      blockFor(spec) >= fromBlock &&
      blockFor(spec) <= toBlock,
  ).map((spec) => rawLogFor(POOLS[spec.poolIndex]!, spec));
}

function discoveredAtFor(poolIndex: number): LogRef {
  const first = ALL_SPECS.filter((spec) => spec.poolIndex === poolIndex)[0];
  if (!first) throw new Error(`pool ${poolIndex} has no log to be discovered by`);
  return {
    blockNumber: BigInt(blockFor(first)),
    blockHash: hash(blockFor(first)),
    transactionHash: transactionHashFor(first),
    transactionIndex: 0,
    logIndex: 0,
  };
}
function registrationFor(poolIndex: number): PersistedPoolRegistration {
  return {
    pool: { chainId: 4663, protocol: 'v3', address: POOLS[poolIndex]! },
    token0: rwa,
    token1: usdg,
    feePips: 3000,
    tickSpacing: 60,
    hooks: addr(0),
    discoveredAt: discoveredAtFor(poolIndex),
    assetVersion: 'test',
    source: 'synthetic',
  };
}
const REGISTRATIONS = POOLS.map((_, index) => registrationFor(index));
/** Every pool of this sample is a v3 pool, so its identity address is its own address. */
function registrationAddress(registration: PersistedPoolRegistration): Address {
  return registration.pool.protocol === 'v3'
    ? registration.pool.address
    : registration.pool.manager;
}
/** The catalogue a batch was planned from: the newcomer is unknown until batch 3 registers it. */
function catalogueFor(batchNumber: number): PersistedPoolRegistration[] {
  return REGISTRATIONS.filter((_, index) => index !== NEWCOMER_INDEX || batchNumber >= 3);
}
/** The fixture's boundary convention: boundary(t).firstBlock is the first block of minute t-60. */
function minuteBoundaries(fromSec: number, toSec: number): MinuteBoundary[] {
  const rows: MinuteBoundary[] = [];
  for (let timestampSec = fromSec; timestampSec <= toSec; timestampSec += 60) {
    const n = timestampSec - 60;
    rows.push({ timestampSec, firstBlock: BigInt(n), before: anchor(n - 1), at: anchor(n) });
  }
  return rows;
}
function worksetBatch(options: {
  id: string;
  batchNumber: number;
  fromBlock: number;
  toBlock: number;
  previous: BlockAnchor | null;
  logs: RawLog[];
  boundaries: MinuteBoundary[];
}): RecordedRangeBatch {
  const { fromBlock, toBlock, logs, previous } = options;
  return {
    id: options.id,
    scopeId: 's',
    fromBlock: BigInt(fromBlock),
    toBlock: BigInt(toBlock),
    end: anchor(toBlock),
    previous,
    logs,
    observedAtMs: 100_000 + options.batchNumber * 1000,
    captureMode: 'live',
    filterPlanHash: 'f',
    manifestHash: options.id,
    completeness: 'complete',
    manifest: {
      version: 1,
      filterVersion: 'f',
      expectedShardIds: ['one'],
      shards: [
        {
          shardId: 'one',
          filterId: 'operation-v3',
          request: {
            fromBlock: BigInt(fromBlock),
            toBlock: BigInt(toBlock),
            address: catalogueFor(options.batchNumber).map(registrationAddress),
            topics: [],
          },
          status: 'success',
          responseHash: 'h',
          error: null,
          logKeys: logs.map(rawLogKey),
          logCount: logs.length,
        },
      ],
    },
    poolRegistrations: catalogueFor(options.batchNumber),
    logTimes: logs.map((ref) => ({
      ref,
      time: {
        minuteStartSec: Math.floor((Number(ref.blockNumber) + 60) / 60) * 60,
        exactTimestampSec: Number(ref.blockNumber) + 60,
        source: 'log-verified' as const,
      },
    })),
    boundaries: options.boundaries,
  };
}
function buildBatches(): RecordedRangeBatch[] {
  const batches: RecordedRangeBatch[] = [];
  for (let index = 0; index < BATCH_COUNT; index++) {
    const batchNumber = index + 1;
    const watermarkSec = WATERMARKS[index]!;
    const toBlock = watermarkSec - 60;
    const fromBlock = index === 0 ? 60 : WATERMARKS[index - 1]! - 59;
    batches.push(
      worksetBatch({
        id: `batch-${String(batchNumber).padStart(2, '0')}`,
        batchNumber,
        fromBlock,
        toBlock,
        previous: index === 0 ? null : anchor(fromBlock - 1),
        logs: logsBetween(fromBlock, toBlock, true),
        boundaries:
          index === 0
            ? minuteBoundaries(FIRST_MINUTE_SEC, watermarkSec)
            : minuteBoundaries(WATERMARKS[index - 1]! + 60, watermarkSec),
      }),
    );
  }
  const revisionNumber = BATCH_COUNT + 1;
  const revisionTip = WATERMARKS.at(-1)! - 60;
  batches.push(
    worksetBatch({
      id: `batch-${String(revisionNumber).padStart(2, '0')}`,
      batchNumber: revisionNumber,
      fromBlock: 60,
      toBlock: revisionTip,
      previous: anchor(revisionTip),
      logs: logsBetween(60, revisionTip, false),
      boundaries: minuteBoundaries(REVISION_WATERMARK_SEC, REVISION_WATERMARK_SEC),
    }),
  );
  return batches;
}

const POOL_LABELS = new Map(
  POOLS.map((pool, index) => [`4663:v3:${pool.toLowerCase()}`, POOL_NAMES[index]!]),
);
function poolLabel(poolId: string): string {
  return POOL_LABELS.get(poolId) ?? poolId;
}
const dbs: Database.Database[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
function setup(): Database.Database {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return db;
}
function records(db: Database.Database): AlertRecord[] {
  return (
    db.prepare('select payload_json from alert_outbox order by sequence').all() as {
      payload_json: string;
    }[]
  ).map((row) => decodeSignalState<AlertRecord>(row.payload_json));
}
function snapshots(db: Database.Database): { poolId: string; snapshot: SignalSnapshot }[] {
  return (
    db.prepare('select pool_id, payload_json from signal_snapshots order by pool_id').all() as {
      pool_id: string;
      payload_json: string;
    }[]
  ).map((row) => ({
    poolId: row.pool_id,
    snapshot: decodeSignalState<SignalSnapshot>(row.payload_json),
  }));
}
/** The snapshot fields that are signal meaning rather than bookkeeping; absent stays null. */
function businessFields(snapshot: SignalSnapshot) {
  return {
    state: snapshot.state,
    episodeId: snapshot.episodeId,
    lastAlertSec: snapshot.lastAlertSec,
    lastAlertKind: snapshot.lastAlertKind,
    lastAlertScale: snapshot.lastAlertScale,
    lastHeatSec: snapshot.lastHeatSec ?? null,
    lastFiveEndSec: snapshot.lastFiveEndSec,
    entryThreshold: snapshot.entryThreshold === null ? null : snapshot.entryThreshold.toString(),
    lowBuckets: snapshot.lowBuckets,
    candidateMinuteStartSec: snapshot.candidateMinuteStartSec ?? null,
    candidateFingerprint: snapshot.candidateFingerprint ?? null,
  };
}

/** Runs the whole sample and returns the database plus what happened batch by batch. */
function runSample() {
  const db = setup();
  const alertsPerBatch: string[][] = [];
  const statesPerBatch: (string | null)[][] = [];
  for (const batch of buildBatches()) {
    const result = commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch);
    alertsPerBatch.push(result.alerts.map((alert) => `${alert.kind}:${poolLabel(alert.poolId)}`));
    const byPool = new Map(snapshots(db).map((row) => [poolLabel(row.poolId), row.snapshot]));
    statesPerBatch.push(POOL_NAMES.map((name) => byPool.get(name)?.state ?? null));
  }
  return { db, alertsPerBatch, statesPerBatch };
}
/** Per-pool state after each batch, with null while the pool has no snapshot row yet. */
function stateSequence(statesPerBatch: (string | null)[][], name: string): (string | null)[] {
  const index = POOL_NAMES.indexOf(name as (typeof POOL_NAMES)[number]);
  return statesPerBatch.map((states) => states[index] ?? null);
}

test('twelve-pool workset sample reproduces its recorded alerts and snapshots', () => {
  const { db, alertsPerBatch, statesPerBatch } = runSample();

  // Only the batches that produced something are named; the quiet ones are frozen as empty.
  expect(alertsPerBatch).toEqual([
    ['candidate:alpha'],
    ['hot:alpha'],
    ['candidate:charlie'],
    [],
    ['cooling:alpha'],
    [],
    [],
    ['hot:bravo'],
    [],
    [],
    ['cooling:bravo'],
    [],
    [],
    [],
    [
      'retracted:bravo',
      'retracted:alpha',
      'retracted:bravo',
      'retracted:alpha',
      'retracted:alpha',
      'retracted:charlie',
    ],
  ]);

  // Outbox order, identity, revision, status, logical time and reasons: one row per delivery.
  expect(
    records(db).map((record) => [
      record.kind,
      record.revision,
      record.status,
      poolLabel(record.poolId),
      record.atBatchId,
      record.logicalTimeSec,
      record.historical ?? false,
      record.reasons.join('|'),
    ]),
  ).toEqual([
    [
      'candidate',
      1,
      'provisional',
      'alpha',
      'batch-01',
      4860,
      false,
      'candidate|zero-baseline/absolute-only|rolling-1m',
    ],
    ['hot', 1, 'provisional', 'alpha', 'batch-02', 5160, false, 'confirmRelative'],
    [
      'candidate',
      1,
      'provisional',
      'charlie',
      'batch-03',
      5460,
      false,
      'candidate|warming/absolute-only|rolling-1m',
    ],
    ['cooling', 1, 'provisional', 'alpha', 'batch-05', 6060, false, 'consecutive-low-rolling5m'],
    ['hot', 1, 'provisional', 'bravo', 'batch-08', 6960, false, 'confirmRelative'],
    ['cooling', 1, 'provisional', 'bravo', 'batch-11', 7860, false, 'consecutive-low-rolling5m'],
    [
      'retracted',
      2,
      'retracted',
      'bravo',
      'batch-15',
      6960,
      false,
      'confirmRelative|source-history-revised|evidence-invalidated-rechecking',
    ],
    [
      'retracted',
      2,
      'retracted',
      'alpha',
      'batch-15',
      5160,
      false,
      'confirmRelative|source-history-revised|evidence-invalidated-rechecking',
    ],
    [
      'retracted',
      2,
      'retracted',
      'bravo',
      'batch-15',
      7860,
      false,
      'consecutive-low-rolling5m|source-history-revised|evidence-invalidated-rechecking',
    ],
    [
      'retracted',
      2,
      'retracted',
      'alpha',
      'batch-15',
      6060,
      false,
      'consecutive-low-rolling5m|source-history-revised|evidence-invalidated-rechecking',
    ],
    [
      'retracted',
      2,
      'retracted',
      'alpha',
      'batch-15',
      4860,
      false,
      'candidate|zero-baseline/absolute-only|rolling-1m|source-history-revised|evidence-invalidated-rechecking',
    ],
    [
      'retracted',
      2,
      'retracted',
      'charlie',
      'batch-15',
      5460,
      false,
      'candidate|warming/absolute-only|rolling-1m|source-history-revised|evidence-invalidated-rechecking',
    ],
  ]);

  // Alert ids and episode ids are the durable identities of these exact decisions.
  expect(
    records(db).map((record) => [
      `${record.kind}:${poolLabel(record.poolId)}`,
      record.id,
      record.episodeId,
    ]),
  ).toEqual([
    [
      'candidate:alpha',
      'c3fdaa2d4937d7efe7ef7df6d4a178c7df94a83d77d4fa2d5b33fc7a8a356c8e',
      '16c258a3faa1ac753017daa109dc45089751ded3f1db3a93021bc14a24bc4c5c',
    ],
    [
      'hot:alpha',
      '43f78e83648422323ae4231656331c89ad86e4d31df80469498eb1df64bec9aa',
      '16c258a3faa1ac753017daa109dc45089751ded3f1db3a93021bc14a24bc4c5c',
    ],
    [
      'candidate:charlie',
      'df50e6cb846c34ce5736ea3881121241e685e2e7b0420fdc9263ecbe9382e436',
      '7f982b256a58d3286a30402de394d71b9331eece31d57125c4c9ab218bd78500',
    ],
    [
      'cooling:alpha',
      'bdbbbcf6261255b259932f4ad3367127451168fb8b7045eed05539b265e5b6cd',
      '16c258a3faa1ac753017daa109dc45089751ded3f1db3a93021bc14a24bc4c5c',
    ],
    [
      'hot:bravo',
      '14b8c7812d4b958d79334499162700cea1fde551652eaba4735f33fff03361a1',
      '3852d4dc85692610bad0e7e56a7b17f2f8f4b7673c70ae405043e81d4ee905da',
    ],
    [
      'cooling:bravo',
      'bb52b612ca037af0a130ac6b55075725b97397583182bee14c0809f21b93216a',
      '3852d4dc85692610bad0e7e56a7b17f2f8f4b7673c70ae405043e81d4ee905da',
    ],
    [
      'retracted:bravo',
      '14b8c7812d4b958d79334499162700cea1fde551652eaba4735f33fff03361a1',
      '3852d4dc85692610bad0e7e56a7b17f2f8f4b7673c70ae405043e81d4ee905da',
    ],
    [
      'retracted:alpha',
      '43f78e83648422323ae4231656331c89ad86e4d31df80469498eb1df64bec9aa',
      '16c258a3faa1ac753017daa109dc45089751ded3f1db3a93021bc14a24bc4c5c',
    ],
    [
      'retracted:bravo',
      'bb52b612ca037af0a130ac6b55075725b97397583182bee14c0809f21b93216a',
      '3852d4dc85692610bad0e7e56a7b17f2f8f4b7673c70ae405043e81d4ee905da',
    ],
    [
      'retracted:alpha',
      'bdbbbcf6261255b259932f4ad3367127451168fb8b7045eed05539b265e5b6cd',
      '16c258a3faa1ac753017daa109dc45089751ded3f1db3a93021bc14a24bc4c5c',
    ],
    [
      'retracted:alpha',
      'c3fdaa2d4937d7efe7ef7df6d4a178c7df94a83d77d4fa2d5b33fc7a8a356c8e',
      '16c258a3faa1ac753017daa109dc45089751ded3f1db3a93021bc14a24bc4c5c',
    ],
    [
      'retracted:charlie',
      'df50e6cb846c34ce5736ea3881121241e685e2e7b0420fdc9263ecbe9382e436',
      '7f982b256a58d3286a30402de394d71b9331eece31d57125c4c9ab218bd78500',
    ],
  ]);

  // The withdrawn reminders, and what each withdrawal was built from.
  expect(
    records(db)
      .filter((record) => record.kind === 'retracted')
      .map((record) => [poolLabel(record.poolId), record.revision, record.status, record.reasons]),
  ).toEqual([
    [
      'bravo',
      2,
      'retracted',
      ['confirmRelative', 'source-history-revised', 'evidence-invalidated-rechecking'],
    ],
    [
      'alpha',
      2,
      'retracted',
      ['confirmRelative', 'source-history-revised', 'evidence-invalidated-rechecking'],
    ],
    [
      'bravo',
      2,
      'retracted',
      ['consecutive-low-rolling5m', 'source-history-revised', 'evidence-invalidated-rechecking'],
    ],
    [
      'alpha',
      2,
      'retracted',
      ['consecutive-low-rolling5m', 'source-history-revised', 'evidence-invalidated-rechecking'],
    ],
    [
      'alpha',
      2,
      'retracted',
      [
        'candidate',
        'zero-baseline/absolute-only',
        'rolling-1m',
        'source-history-revised',
        'evidence-invalidated-rechecking',
      ],
    ],
    [
      'charlie',
      2,
      'retracted',
      [
        'candidate',
        'warming/absolute-only',
        'rolling-1m',
        'source-history-revised',
        'evidence-invalidated-rechecking',
      ],
    ],
  ]);

  // Every registered pool keeps a snapshot: nine of them never warn, three carry the whole sample.
  expect(
    snapshots(db).map(({ poolId, snapshot }) => [poolLabel(poolId), businessFields(snapshot)]),
  ).toEqual([
    [
      'alpha',
      {
        state: 'watch',
        episodeId: null,
        lastAlertSec: null,
        lastAlertKind: null,
        lastAlertScale: '5m',
        lastHeatSec: null,
        lastFiveEndSec: 8760,
        entryThreshold: null,
        lowBuckets: 0,
        candidateMinuteStartSec: 4800,
        candidateFingerprint: 'ef59effcb79755cb6bae09f120e2477c5a4b57134a24e05efa1e76b19391ed78',
      },
    ],
    [
      'bravo',
      {
        state: 'cooling',
        episodeId: '3852d4dc85692610bad0e7e56a7b17f2f8f4b7673c70ae405043e81d4ee905da',
        lastAlertSec: 7860,
        lastAlertKind: 'cooling',
        lastAlertScale: '5m',
        lastHeatSec: 6960,
        lastFiveEndSec: 8760,
        entryThreshold: '100000000000',
        lowBuckets: 0,
        candidateMinuteStartSec: null,
        candidateFingerprint: null,
      },
    ],
    [
      'charlie',
      {
        state: 'candidate',
        episodeId: '7f982b256a58d3286a30402de394d71b9331eece31d57125c4c9ab218bd78500',
        lastAlertSec: 5460,
        lastAlertKind: 'candidate',
        lastAlertScale: '1m',
        lastHeatSec: null,
        lastFiveEndSec: 8760,
        entryThreshold: null,
        lowBuckets: 0,
        candidateMinuteStartSec: 5400,
        candidateFingerprint: 'ef59effcb79755cb6bae09f120e2477c5a4b57134a24e05efa1e76b19391ed78',
      },
    ],
    ...POOL_NAMES.slice(3).map((name) => [
      name,
      {
        state: 'watch',
        episodeId: null,
        lastAlertSec: null,
        lastAlertKind: null,
        lastAlertScale: null,
        lastHeatSec: null,
        lastFiveEndSec: 8760,
        entryThreshold: null,
        lowBuckets: 0,
        candidateMinuteStartSec: null,
        candidateFingerprint: null,
      },
    ]),
  ]);

  // The liquidity actions bravo's hot window carried reach the alert's own window counts, while
  // alpha's window (swaps only) reports none. Every rolling draft is annotated as historical.
  expect(
    records(db)
      .filter((record) => record.kind === 'hot')
      .map((record) => [
        poolLabel(record.poolId),
        record.metrics.rolling?.['5m'].addCount,
        record.metrics.rolling?.['5m'].removeCount,
        record.metrics.rolling?.['5m'].zeroDeltaCount,
        record.presentation?.liquidityNote,
      ]),
  ).toEqual([
    ['alpha', 0, 0, 0, 'unknown (historical liquidity observation unavailable)'],
    ['bravo', 1, 1, 0, 'unknown (historical liquidity observation unavailable)'],
  ]);

  // Delivery state: the six withdrawals retire the six provisional deliveries they revise.
  expect(
    db
      .prepare('select status, count(*) as n from alert_outbox group by status order by status')
      .all(),
  ).toEqual([
    { status: 'pending', n: 6 },
    { status: 'superseded', n: 6 },
  ]);

  // The sample's own coverage claim. These fail first if the fixture ever degrades, before a
  // re-frozen table above could hide it.
  // 1. watch -> candidate -> hot -> cooling -> watch, in that order, for one pool. The leading
  //    `watch` is the engine's initial snapshot: no row exists before the pool's first evaluation.
  const alphaStates = stateSequence(statesPerBatch, 'alpha').map((state) => state ?? 'watch');
  expect(alphaStates[0]).toBe('candidate');
  expect(alphaStates).toContain('hot');
  expect(alphaStates).toContain('cooling');
  expect(alphaStates.at(-1)).toBe('watch');
  expect(
    ['candidate', 'hot', 'cooling', 'watch'].map((state) => alphaStates.indexOf(state)),
  ).toEqual([0, 1, 4, 13]);
  // 2. A pool registered by a batch warns inside that same batch, and has no snapshot before it.
  expect(stateSequence(statesPerBatch, 'charlie').slice(0, 3)).toEqual([null, null, 'candidate']);
  // 3. The liquidity-watch kind exists in `AlertKind` and has a message format, but the engine has
  //    no rule that emits it (`evaluateSignal` only ever drafts candidate/hot/reheat/cooling), so
  //    the sample can only cover liquidity evidence, not a liquidity alert. Recorded here so that
  //    a future rule shows up as this assertion failing rather than as a silently wider kind set.
  expect(records(db).map((record) => record.kind)).not.toContain('liquidity-watch');
  expect(records(db).map((record) => record.kind)).toContain('cooling');
});

/**
 * The sample's catalogue with `count` more registrations that have never traded.
 *
 * These are real rows with real discoveries and no logs of their own, so they enter the registry
 * exactly like a pool a follow batch found, and the event index never hears about them. That is the
 * whole distinction the next test measures: a full scan assembles a window for each of them, a
 * bounded round never looks.
 */
function seedQuietCatalogue(db: Database.Database, count: number): string[] {
  const rawKey = 'quiet-catalogue';
  db.prepare(
    `insert into raw_logs(raw_key, chain_id, block_hash, block_number, transaction_hash,
       transaction_index, log_index, address, topics_json, data, raw_block_timestamp, payload_json)
     values (?, 4663, ?, 0, ?, 0, 0, ?, '[]', '0x', null, '{}')`,
  ).run(rawKey, hash(0), hash(0), addr(0));
  const { id } = db.prepare('select id from raw_logs where raw_key=?').get(rawKey) as {
    id: number;
  };
  const insert = db.prepare(
    `insert into pools(scope_id, pool_key, protocol, discovered_raw_log_id, discovered_block_number,
       discovered_block_hash, payload_json) values (?, ?, 'v3', ?, 0, ?, ?)`,
  );
  return Array.from({ length: count }, (_, index) => {
    const address = addr(1000 + index);
    const poolKey = `4663:v3:${address.toLowerCase()}`;
    const registration: PersistedPoolRegistration = {
      pool: { chainId: 4663, protocol: 'v3', address },
      token0: rwa,
      token1: usdg,
      feePips: 3000,
      tickSpacing: 60,
      hooks: addr(0),
      assetVersion: 'test',
      source: 'synthetic',
      discoveredAt: {
        blockNumber: 0n,
        blockHash: hash(0),
        transactionHash: hash(0),
        transactionIndex: 0,
        logIndex: 0,
      },
    };
    insert.run('s', poolKey, id, hash(0), storedRegistrationJson(registration));
    return poolKey;
  });
}

/**
 * The sample's own catalogues are twelve pools wide and all twelve trade, so nothing in it can tell
 * a round that walks the catalogue from one that walks its activity. This adds the missing half: a
 * catalogue that grew by four hundred registrations nothing ever happened in.
 *
 * The counts are the ones the real path reports, not the ideal ones: `evaluatedWorksetPools` is the
 * selection `LiveWorksetStore.select` made and `evaluatedPools` is the windows the metric build
 * assembled, counted where they are assembled. A round that stopped consulting the workset would
 * report four hundred and twelve of the latter while reporting nothing at all for the former, which
 * is what makes this the test that fails when the wiring comes out.
 */
test('a live batch evaluates the pools it has input for, not the catalogue it was registered in', () => {
  const { db } = runSample();
  const CROWD = 400;
  seedQuietCatalogue(db, CROWD);
  // Absorb the new registrations into the projection before the measured round, the way a batch
  // would have: otherwise the round is the one that discovers them and they are the round's own
  // input rather than catalogue. This is the only sync the test takes outside the batch.
  new LiveProjectionStore(db).sync('s', 's', 'c');

  const watermarkSec = REVISION_WATERMARK_SEC;
  const toBlock = watermarkSec - 60;
  // The revision batch left the accepted range at the sample's last block, so this one continues
  // from it with a quiet range: no pool traded after the sample, so every pool the round still has
  // something for is a pool whose snapshot carries it.
  const fromBlock = toBlock - 59;
  const batch = worksetBatch({
    id: 'batch-16',
    batchNumber: BATCH_COUNT + 2,
    fromBlock,
    toBlock,
    previous: anchor(fromBlock - 1),
    logs: logsBetween(fromBlock, toBlock, false),
    boundaries: minuteBoundaries(WATERMARKS.at(-1)!, watermarkSec),
  });

  const scope = openWorkCounts();
  try {
    commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch);
  } finally {
    scope.close();
  }

  // The crowd is in the catalogue the round reads: this is a registered-but-quiet difference, not
  // a missing-data one.
  expect(db.prepare('select count(*) as n from pools').get()).toEqual({ n: POOL_COUNT + CROWD });
  // Ten of the twelve traded inside this batch's range and the other two still hold window input
  // from the sample, so the round that selected them is the round that assembled their windows.
  expect(scope.counts.evaluatedWorksetPools).toBe(POOL_COUNT);
  expect(scope.counts.evaluatedPools).toBe(scope.counts.evaluatedWorksetPools);
});

/**
 * The one thing a round cannot read off its own inputs is that the chain it read them from was
 * replaced. A branch that moves at the same height under a standing watermark leaves every input
 * where it was — the same tip height, the same logs, no repair — and the pools whose memory is the
 * only reason to look at them again are exactly the ones that would be missed.
 */
test('a branch replaced at the same height reconsiders the pool whose only input is its memory', () => {
  const db = setup();
  // A pool with signal memory and no window input of its own. It is in the sample's snapshot scan
  // — the scan runs once, before the first batch — and nothing after it can put it in a round.
  const SLEEPING = `4663:v3:${addr(30).toLowerCase()}`;
  db.prepare('insert into signal_snapshots(scope_id,pool_id,payload_json) values(?,?,?)').run(
    's',
    SLEEPING,
    encodeSignalState({ ...initialSignalSnapshot(), state: 'cooling', lowBuckets: 2 }),
  );
  for (const batch of buildBatches())
    commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch);

  // The same height as the tip the last round left, with a different hash: this is the branch the
  // chain threw away, not an extension of it.
  const moved = worksetBatch({
    id: 'batch-16',
    batchNumber: BATCH_COUNT + 2,
    fromBlock: WATERMARKS.at(-1)! - 60,
    toBlock: WATERMARKS.at(-1)! - 60,
    previous: anchor(WATERMARKS.at(-1)! - 60),
    logs: [],
    boundaries: minuteBoundaries(WATERMARKS.at(-1)!, REVISION_WATERMARK_SEC),
  });
  moved.end = { ...moved.end, hash: hash(9999) };

  const scope = openWorkCounts();
  try {
    commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, moved);
  } finally {
    scope.close();
  }

  expect(scope.counts.evaluatedWorksetPools).toBe(POOL_COUNT + 1);
  // The sleeping pool is selected but not assembled: it has no registration, and the report does
  // not invent one. The extra count is the selection's, which is what this test is about.
  expect(scope.counts.evaluatedPools).toBe(POOL_COUNT);
});
