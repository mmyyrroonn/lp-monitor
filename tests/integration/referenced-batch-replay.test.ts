import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import { afterAll, describe, expect, test } from 'vitest';
import { CHAIN_ID } from '../../src/domain/chain.js';
import type { RawLog } from '../../src/domain/types.js';
import { v3FactoryAbi } from '../../src/protocols/uniswap-v3/abi.js';
import { poolRegistrationId } from '../../src/registry/pools.js';
import { mergeHistoricalBatches } from '../../src/replay/clock.js';
import { exportReplayDataset } from '../../src/replay/export.js';
import type {
  ReplayCatalogueSnapshot,
  ReplayInputSnapshot,
  ReplayManifest,
} from '../../src/replay/reader.js';
import { replay, type ReplayReport } from '../../src/replay/runner.js';
import { initialSignalConfig } from '../../src/signals/config.js';
import { openDatabase } from '../../src/storage/database.js';
import {
  getPayload,
  putPayload,
  readBatch,
  type PayloadRef,
} from '../../src/storage/payload-store.js';
import {
  rawLogKey,
  type PersistedPoolRegistration,
  type RecordedRangeBatch,
} from '../../src/storage/manifest.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { addr, anchor, hash, metricInput, swap } from '../helpers/alert-fixture.js';

/**
 * A batch recorded after the registry migration states only the pools its own logs touch; the
 * complete register travels beside the dataset instead of inside every batch. These tests read such
 * a dataset back out of the four payload encodings a recording can hold, with the source database
 * deleted, and compare it against the same evidence written the way the un-migrated reader expected.
 *
 * The fixed inputs are one batch per encoding: an old inline batch, an old `batch-ref-v1` batch, a
 * `batch-ref-v2` batch and a post-migration referenced batch. Only the last one is *meant* to carry
 * a dependency set, but an inline batch loses its array to the transport encoder whatever it holds,
 * so the dataset as read back names fewer pools than the register contains. The pool that never
 * trades is in the catalogue and in no batch's own dependency set, which is what makes the one-shot
 * catalogue load-bearing rather than decorative.
 */

/** The pool that trades: `alert-fixture`'s own pool, so its swap logs decode unchanged. */
const traded = addr(1);
const silent = addr(4);
const late = addr(5);
const factory = addr(6);
const zero = addr(0);

const scope = 's';
const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function created(blockNumber: number, logIndex: number, pool: Address): RawLog {
  return {
    address: factory,
    blockNumber: BigInt(blockNumber),
    blockHash: hash(blockNumber),
    transactionHash: hash(20_000 + blockNumber + logIndex),
    transactionIndex: 0,
    logIndex,
    rawBlockTimestamp: '0x0',
    topics: encodeEventTopics({
      abi: v3FactoryAbi,
      eventName: 'PoolCreated',
      args: { token0: metricInput.assets.assets[0]!.address, token1: metricInput.usdg, fee: 3_000 },
    }) as Hex[],
    data: encodeAbiParameters([{ type: 'int24' }, { type: 'address' }], [60, pool]),
  };
}

/** The registration a discovery log proves, read off the log rather than typed beside it. */
function registrationFor(log: RawLog, pool: Address): PersistedPoolRegistration {
  return {
    pool: { chainId: CHAIN_ID, protocol: 'v3', address: pool },
    token0: metricInput.assets.assets[0]!.address,
    token1: metricInput.usdg,
    feePips: 3_000,
    tickSpacing: 60,
    hooks: zero,
    discoveredAt: {
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
    },
    assetVersion: metricInput.assets.version,
    source: 'uniswap-v3:PoolCreated',
  };
}

const birth = {
  traded: created(60, 0, traded),
  silent: created(60, 1, silent),
  // Late enough that every frame the earlier batches close has already been evaluated.
  late: created(2_400, 2, late),
};
/** The one-shot catalogue: every pool the recording knows, including the one that never trades. */
const catalogue = [
  registrationFor(birth.traded, traded),
  registrationFor(birth.silent, silent),
  registrationFor(birth.late, late),
];
const swaps = Array.from({ length: 37 }, (_, index) => swap(120 + index * 60));

const parts = [
  { id: 'inline', from: 60, to: 660 },
  { id: 'ref1', from: 661, to: 1_260 },
  { id: 'ref2', from: 1_261, to: 1_860 },
  { id: 'referenced', from: 1_861, to: 2_460 },
];
/** One payload encoding per batch, in the order a recording would have written them. */
const encodings = ['inline', 'ref-v1', 'ref-v2', 'ref-v1'] as const;

/** One minute of resolved evidence per log, in the convention the replay fixtures already use. */
function timeFor(log: RawLog) {
  return {
    ref: log,
    time: {
      minuteStartSec: Math.floor((Number(log.blockNumber) + 60) / 60) * 60,
      exactTimestampSec: Number(log.blockNumber) + 60,
      source: 'log-verified' as const,
    },
  };
}

/**
 * The minute index through a batch's own close. Every batch carries the index from the start of the
 * recording, because the export hands each one the boundaries the store holds up to its own end;
 * they tile, so the merged index stays contiguous and every recorded log keeps its bracket.
 */
function boundariesThrough(to: number) {
  return Array.from({ length: (to - 60) / 60 + 1 }, (_, index) => {
    const number = 60 + index * 60;
    return {
      timestampSec: number + 60,
      firstBlock: BigInt(number),
      before: anchor(number - 1),
      at: anchor(number),
    };
  });
}

function shardsFor(from: number, to: number, logs: readonly RawLog[]) {
  const inside = (log: RawLog) => Number(log.blockNumber) >= from && Number(log.blockNumber) <= to;
  const discoveries = logs.filter((log) => log.address === factory && inside(log));
  const operations = logs.filter((log) => log.address !== factory && inside(log));
  return [
    {
      shardId: 'discovery',
      filterId: 'discovery-v3',
      request: { fromBlock: BigInt(from), toBlock: BigInt(to), address: [factory], topics: [] },
      status: 'success' as const,
      responseHash: hash(from),
      logKeys: discoveries.map(rawLogKey),
      logCount: discoveries.length,
      error: null,
    },
    {
      shardId: 'operations',
      filterId: 'operation-v3',
      request: {
        fromBlock: BigInt(from),
        toBlock: BigInt(to),
        address: [traded, silent, late],
        topics: [],
      },
      status: 'success' as const,
      responseHash: hash(to),
      logKeys: operations.map(rawLogKey),
      logCount: operations.length,
      error: null,
    },
  ];
}

/** The pools a batch's own logs name: its discovery logs and the pools those logs came from. */
function dependencies(logs: readonly RawLog[]): PersistedPoolRegistration[] {
  const keys = new Set(logs.map(rawLogKey));
  const addresses = new Set(logs.map((log) => log.address.toLowerCase()));
  return catalogue.filter(
    (entry) =>
      keys.has(rawLogKey(entry.discoveredAt)) ||
      (entry.pool.protocol === 'v3' && addresses.has(entry.pool.address.toLowerCase())),
  );
}

type Variant = 'referenced' | 'whole';

function buildPart(part: (typeof parts)[number], variant: Variant): RecordedRangeBatch {
  const logs = [
    ...Object.values(birth).filter(
      (log) => Number(log.blockNumber) >= part.from && Number(log.blockNumber) <= part.to,
    ),
    ...swaps.filter(
      (log) => Number(log.blockNumber) >= part.from && Number(log.blockNumber) <= part.to,
    ),
  ];
  return {
    id: part.id,
    scopeId: scope,
    fromBlock: BigInt(part.from),
    toBlock: BigInt(part.to),
    end: anchor(part.to),
    previous: part.from === 60 ? null : anchor(part.from - 1),
    logs,
    observedAtMs: 100_000 + part.from,
    captureMode: 'synthetic',
    filterPlanHash: 'f',
    manifestHash: part.id,
    completeness: 'complete',
    manifest: {
      version: 1,
      filterVersion: 'f',
      expectedShardIds: ['discovery', 'operations'],
      shards: shardsFor(part.from, part.to, logs),
    },
    // The un-migrated reader took the array for the register as it stood at the batch's own end;
    // the migrated one states exactly the dependencies of this batch's logs.
    poolRegistrations:
      variant === 'referenced'
        ? dependencies(logs)
        : catalogue.filter((entry) => entry.discoveredAt.blockNumber <= BigInt(part.to)),
    ...(variant === 'referenced' ? { registryMode: 'referenced-v1' as const } : {}),
    logTimes: logs.map(timeFor),
    boundaries: boundariesThrough(part.to),
  };
}

/** A batch as it is persisted: the transport, without the minute evidence derived alongside it. */
function withoutEvidence(batch: RecordedRangeBatch): RecordedRangeBatch {
  const { logTimes: _minutes, boundaries: _index, ...transport } = batch;
  return transport as RecordedRangeBatch;
}

/** The transport without its register array: what an inline row stores, whatever it was handed. */
function withoutArray(batch: RecordedRangeBatch): RecordedRangeBatch {
  const { poolRegistrations: _pools, ...transport } = batch;
  return transport as RecordedRangeBatch;
}

/**
 * Re-encode an already-stored batch as a chunked reference. The bytes, the payload object and the
 * whole-payload hash are the producer's own; only the envelope is rebuilt, because the producer
 * splits at 64 MiB and a fixture cannot carry a 64 MiB batch. `tests/unit/payload-store.test.ts`
 * covers the split itself.
 */
function reencodeChunked(db: Database.Database, id: string): void {
  const stored = db
    .prepare('select payload_json from ingest_batches where id=?')
    .pluck()
    .get(id) as string | undefined;
  if (stored === undefined) throw new Error('Batch is missing before re-encoding');
  const { payload } = JSON.parse(stored) as { payload: PayloadRef };
  const bytes = Buffer.from(getPayload(db, payload));
  db.prepare('update ingest_batches set payload_json=? where id=?').run(
    JSON.stringify({
      format: 'batch-ref-v2',
      hash: createHash('sha256').update(bytes).digest('hex'),
      rawBytes: bytes.byteLength,
      payloads: [putPayload(db, bytes)],
    }),
    id,
  );
}

function payloadFormat(db: Database.Database, id: string): string {
  const stored = db
    .prepare('select payload_json from ingest_batches where id=?')
    .pluck()
    .get(id) as string | undefined;
  if (stored === undefined) throw new Error('Batch is missing');
  if (!stored.trimStart().startsWith('{"format"')) return 'inline';
  return (JSON.parse(stored) as { format: string }).format;
}

type Written = { formats: string[]; readBack: RecordedRangeBatch[] };

/** Write the transport in its encoding, then accept the batch with the minute evidence it carries. */
function writeSource(path: string, batches: readonly RecordedRangeBatch[]): Written {
  const db = openDatabase(path);
  try {
    const store = new SqliteRangeStore(db);
    const formats: string[] = [];
    const readBack: RecordedRangeBatch[] = [];
    for (const [index, timed] of batches.entries()) {
      const transport = withoutEvidence(timed);
      if (encodings[index] === 'inline') store.saveRaw(transport);
      else store.saveRaw(transport, { compact: true });
      if (encodings[index] === 'ref-v2') reencodeChunked(db, timed.id);
      const read = readBatch(db, timed.id);
      // The stored transport is the batch's logs, bounds and registry mode. An inline row never held
      // the register array, so reading it back cannot restore one; a compact row holds the batch
      // whole, array included.
      expect(read).toEqual(encodings[index] === 'inline' ? withoutArray(transport) : transport);
      formats.push(payloadFormat(db, timed.id));
      readBack.push(read);
      store.acceptRange(timed);
    }
    return { formats, readBack };
  } finally {
    db.close();
  }
}

const snapshot: ReplayInputSnapshot = {
  configVersion: metricInput.configVersion,
  usdg: metricInput.usdg,
  assets: { version: metricInput.assets.version, rwa: [...metricInput.assets.assets] },
  metadata: metricInput.metadata,
  availableAtSec: 0,
  cohortMode: 'retrospective-cohort',
};

type Bundle = {
  manifest: string;
  source: string;
  directory: string;
  formats: string[];
  readBack: RecordedRangeBatch[];
};

async function bundle(root: string, name: string, variant: Variant): Promise<Bundle> {
  const directory = join(root, name);
  const source = join(root, `${name}.sqlite`);
  const written = writeSource(
    source,
    parts.map((part) => buildPart(part, variant)),
  );
  const exported = await exportReplayDataset({
    databasePath: source,
    outputDirectory: directory,
    scopeId: scope,
    fromBlock: 60n,
    toBlock: 2_460n,
    mode: 'chain-time',
    cohortMode: 'retrospective-cohort',
    inputSnapshot: { ...snapshot },
  });
  expect(exported.issues).toEqual([]);
  // The source is gone before anything is replayed from the bundle.
  rmSync(source);
  return { manifest: exported.manifestPath, source, directory, ...written };
}

type Datasets = { root: string; referenced: Bundle; whole: Bundle };

let datasets: Promise<Datasets> | undefined;
/** One exported pair for the whole file: the same evidence, written two ways. */
function fixture(): Promise<Datasets> {
  datasets ??= (async () => {
    const root = mkdtempSync(join(tmpdir(), 'lp-referenced-replay-'));
    roots.push(root);
    return {
      root,
      referenced: await bundle(root, 'referenced', 'referenced'),
      whole: await bundle(root, 'whole', 'whole'),
    };
  })();
  return datasets;
}

async function replayed(entry: Bundle | string): Promise<ReplayReport> {
  return replay(
    typeof entry === 'string' ? entry : entry.manifest,
    initialSignalConfig,
    'minute-close',
  );
}

/** Copy the referenced bundle so one manifest field can be edited without touching the original. */
function derived(root: string, name: string, edit: (manifest: ReplayManifest) => void): string {
  const directory = join(root, name);
  cpSync(join(root, 'referenced'), directory, { recursive: true });
  const path = join(directory, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as ReplayManifest;
  edit(manifest);
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

function catalogueOf(manifest: ReplayManifest): ReplayCatalogueSnapshot {
  const catalogue = manifest.replay?.input.catalogue;
  if (catalogue === undefined) throw new Error('The exported bundle states no catalogue');
  return catalogue;
}

function segmentsOf(entry: Bundle): RecordedRangeBatch[] {
  const manifest = JSON.parse(readFileSync(entry.manifest, 'utf8')) as ReplayManifest;
  if (manifest.version !== 2) throw new Error('The export writes a version 2 manifest');
  return manifest.segments.map(
    (segment) =>
      JSON.parse(
        gunzipSync(readFileSync(join(entry.directory, segment.path))).toString('utf8'),
        (key, value: unknown) => (key === 'blockNumber' ? BigInt(value as string) : value),
      ) as RecordedRangeBatch,
  );
}

const id = (registration: { pool: PersistedPoolRegistration['pool'] }) =>
  poolRegistrationId(registration);
const ids = (registrations: readonly { pool: PersistedPoolRegistration['pool'] }[]) =>
  registrations.map(id).sort();

describe('a dataset whose batches name only their own dependencies', () => {
  test('replays from four payload encodings with the source gone, as the un-migrated reader did', async () => {
    const data = await fixture();
    expect(data.referenced.formats).toEqual([
      'inline',
      'batch-ref-v1',
      'batch-ref-v2',
      'batch-ref-v1',
    ]);
    expect(existsSync(data.referenced.source)).toBe(false);

    const migrated = await replayed(data.referenced);
    const whole = await replayed(data.whole);

    // The issues are asserted first: a status of "incomplete" says nothing about what went wrong.
    expect(migrated.integrity.issues).toEqual([]);
    expect(migrated.status).toBe('complete');
    // Every pool the catalogue names is in the register: the silent one arrives from the snapshot,
    // and the two the batches happen to name arrive from their own evidence.
    expect(ids(migrated.registrations)).toEqual(ids(catalogue));
    // The same evidence written the un-migrated way registers the same pools and evaluates to the
    // same business result: the array's meaning changed, the dataset did not.
    expect(ids(whole.registrations)).toEqual(ids(catalogue));
    expect(migrated.businessHash).toBe(whole.businessHash);
    expect(migrated.frames.map((frame) => frame.evaluatedAtSec)).toEqual(
      whole.frames.map((frame) => frame.evaluatedAtSec),
    );
  }, 300_000);

  test('states the register once, bounded and attributed, and repeats it in no segment', async () => {
    const data = await fixture();
    const manifest = JSON.parse(readFileSync(data.referenced.manifest, 'utf8')) as ReplayManifest;
    const stated = catalogueOf(manifest);
    expect(stated.version).toBe(1);
    expect(stated.registryScopeId).toBe(scope);
    expect(stated.assetVersion).toBe(metricInput.assets.version);
    expect(stated.asOfBlock).toBe('2460');
    // A read taken while the export ran cannot prove what the study point knew.
    expect(stated.source).toEqual({ reader: 'local-pools', availability: 'retrospective' });
    expect(ids(stated.pools)).toEqual(ids(catalogue));

    const segments = segmentsOf(data.referenced);
    expect(segments).toHaveLength(4);
    // The register is stated once for the dataset: the batches name the traded pool and the late
    // one, and never the pool that never traded.
    const carried = segments.flatMap((segment) => segment.poolRegistrations ?? []);
    expect([...new Set(ids(carried))]).toEqual([id(catalogue[0]!), id(catalogue[2]!)].sort());
    expect(ids(carried)).not.toContain(id(catalogue[1]!));
    if (manifest.version !== 2) throw new Error('The export writes a version 2 manifest');
    expect(manifest.export.inputSnapshot).toMatchObject({
      catalogue: { registryScopeId: scope, asOfBlock: '2460', pools: 3 },
    });
  }, 180_000);

  test('shows a pool that never traded as a zero under complete coverage, never as a gap', async () => {
    const data = await fixture();
    const report = await replayed(data.referenced);
    const quiet = report.finalMetrics!.windows.find((w) => w.poolId === id(catalogue[1]!));
    if (quiet === undefined) throw new Error('The silent pool is missing from the final metrics');
    const closed = quiet.minutes.filter((minute) => minute.status === 'closed');
    expect(closed.length).toBeGreaterThan(30);
    expect(closed.every((minute) => minute.swapCount === 0 && minute.activeMinutes === 0)).toBe(
      true,
    );
    expect(quiet.minutes.filter((minute) => minute.status === 'gap')).toEqual([]);
    expect(quiet.unknownTimeBlockCounts).toEqual([]);
    // The register row has to be in place in the very frame whose accepted range carries its
    // discovery evidence. A row placed one adoption later would leave that frame short of the
    // register it already had the evidence for, and the pool would appear a minute late.
    const silentId = id(catalogue[1]!);
    const carrying = report.frames.filter(
      (frame) => frame.metrics.at.number > birth.silent.blockNumber,
    );
    expect(carrying.length).toBeGreaterThan(0);
    expect(carrying[0]!.metrics.windows.some((w) => w.poolId === silentId)).toBe(true);
  }, 180_000);

  test('withholds a catalogue pool from the frames that close before its discovery', async () => {
    const data = await fixture();
    const report = await replayed(data.referenced);
    const lateId = id(catalogue[2]!);
    expect(report.registrations.map(id)).toContain(lateId);
    const born = report.frames.filter((frame) =>
      frame.metrics.windows.some((window) => window.poolId === lateId),
    );
    // Nothing evaluated before the block that discovered it may show it at all.
    expect(born.length).toBeGreaterThan(0);
    expect(born.length).toBeLessThan(report.frames.length);
    expect(Math.min(...born.map((frame) => frame.evaluatedAtSec))).toBeGreaterThan(2_400);
    // Inside its first frame the pool exists, and its minutes before birth are warming, not zero.
    const window = born[0]!.metrics.windows.find((w) => w.poolId === lateId)!;
    const warming = window.minutes.filter((minute) => minute.status === 'warming');
    expect(warming.length).toBeGreaterThan(0);
    expect(warming.every((minute) => minute.swapCount === null)).toBe(true);
  }, 180_000);

  test('reads a catalogue that belongs to another scope, another assets version or no range', async () => {
    const data = await fixture();
    const otherScope = await replayed(
      derived(data.root, 'scope', (manifest) => {
        catalogueOf(manifest).registryScopeId = 'elsewhere';
      }),
    );
    expect(otherScope.integrity.issues.map((issue) => issue.code)).toContain(
      'catalogue-scope-mismatch',
    );
    // A register that is not this dataset's is no register at all: the silent pool stays unknown.
    expect(ids(otherScope.registrations)).not.toContain(id(catalogue[1]!));

    const otherAssets = await replayed(
      derived(data.root, 'assets', (manifest) => {
        catalogueOf(manifest).assetVersion = 'other';
      }),
    );
    expect(otherAssets.integrity.issues.map((issue) => issue.code)).toContain(
      'catalogue-asset-version-mismatch',
    );
    expect(ids(otherAssets.registrations)).toEqual(ids(catalogue));

    // A catalogue complete past the exported range is read to the export's own bound, and says so.
    const beyond = await replayed(
      derived(data.root, 'beyond', (manifest) => {
        catalogueOf(manifest).asOfBlock = '9999';
      }),
    );
    expect(beyond.integrity.issues.map((issue) => issue.code)).toContain(
      'catalogue-cutoff-beyond-export',
    );
    expect(beyond.registrations).toHaveLength(catalogue.length);
  }, 300_000);

  test('keeps a pool whose discovery evidence the dataset lacks unknown, and never a zero', async () => {
    const data = await fixture();
    // A pool the catalogue claims that no batch of this dataset holds the discovery log for.
    const stranger = registrationFor(created(2_459, 3, addr(7)), addr(7));
    const report = await replayed(
      derived(data.root, 'stranger', (manifest) => {
        catalogueOf(manifest).pools.push({
          ...stranger,
          discoveredAt: { ...stranger.discoveredAt, blockNumber: '2459' },
        } as unknown as PersistedPoolRegistration);
      }),
    );
    expect(report.integrity.issues.map((issue) => issue.code)).toContain('catalogue-pool-unknown');
    expect(report.registrations.map(id)).not.toContain(id(stranger));
    // ...and it is not shown as a silent zero either: an unknown pool has no window at all.
    expect(report.finalMetrics!.windows.some((w) => w.poolId === id(stranger))).toBe(false);
  }, 180_000);

  test('refuses a catalogue row it cannot read rather than reading a smaller one', async () => {
    const data = await fixture();
    const unreadable = await replayed(
      derived(data.root, 'unreadable', (manifest) => {
        catalogueOf(manifest).pools[0]!.discoveredAt.blockNumber =
          'not-a-height' as unknown as bigint;
      }),
    );
    expect(unreadable.integrity.issues.map((issue) => issue.code)).toContain(
      'catalogue-snapshot-invalid',
    );
    // The whole register is refused, including the pools that were readable.
    expect(ids(unreadable.registrations)).not.toContain(id(catalogue[1]!));

    const absent = await replayed(
      derived(data.root, 'absent', (manifest) => {
        delete manifest.replay!.input.catalogue;
      }),
    );
    // Without the snapshot the silent pool is unknowable, and nothing says so: a pool no batch
    // names simply is not there. That silence is what the one-shot catalogue exists to end.
    expect(ids(absent.registrations)).not.toContain(id(catalogue[1]!));
  }, 300_000);

  test('cannot present a catalogue read after the study point as an as-of claim', async () => {
    const data = await fixture();
    const report = await replayed(
      derived(data.root, 'as-of', (manifest) => {
        manifest.replay!.input.cohortMode = 'as-of';
        if (manifest.version === 2) manifest.export.cohortMode = 'as-of';
      }),
    );
    expect(report.integrity.issues.map((issue) => issue.code)).toContain('catalogue-not-as-of');
    expect(report.provenance.cohortMode).toBe('as-of');
  }, 180_000);

  test('keeps a union of referenced histories referenced', async () => {
    const data = await fixture();
    const [first, second] = parts.map((part) => buildPart(part, 'referenced'));
    const merged = mergeHistoricalBatches([first!, second!]);
    expect(merged.registryMode).toBe('referenced-v1');
    expect(merged.fromBlock).toBe(60n);
    expect(merged.toBlock).toBe(1_260n);
    // The pools the two batches named survive the union, and nothing else appears.
    expect(ids(merged.poolRegistrations ?? [])).toEqual(
      [
        ...new Set(
          [...(first!.poolRegistrations ?? []), ...(second!.poolRegistrations ?? [])].map(id),
        ),
      ].sort(),
    );
    // An unmarked history stays unmarked; one referenced batch is enough to mark the union.
    const whole = parts.map((part) => buildPart(part, 'whole'));
    expect(mergeHistoricalBatches(whole).registryMode).toBeUndefined();
    expect(mergeHistoricalBatches([first!, whole[1]!]).registryMode).toBe('referenced-v1');
    expect(data.referenced.formats).toHaveLength(4);
  }, 180_000);

  test('stores the mode with the transport, and refuses a rewrite or a payload that no longer hashes', async () => {
    const data = await fixture();
    const db = openDatabase(join(data.root, 'tamper.sqlite'));
    try {
      const store = new SqliteRangeStore(db);
      const marked = buildPart(parts[0]!, 'referenced');
      const unmarkedBatch = buildPart(parts[1]!, 'whole');
      // The mode is part of the stored transport, so a row that states one cannot be rewritten to
      // state none: that would ask a reader to read the same array the other way.
      store.saveRaw(withoutEvidence(marked), { compact: true });
      expect(readBatch(db, marked.id).registryMode).toBe('referenced-v1');
      expect(() =>
        store.saveRaw({ ...withoutEvidence(marked), registryMode: undefined } as never),
      ).toThrow(/immutable/i);

      // An unmarked row reads its array as the catalogue as it then stood. A referenced one that
      // names two pools is not that, and the store keeps both readings apart.
      store.saveRaw(withoutEvidence(unmarkedBatch), { compact: true });
      const unmarkedRead = readBatch(db, unmarkedBatch.id);
      expect(unmarkedRead.registryMode).toBeUndefined();
      expect(ids(unmarkedRead.poolRegistrations ?? [])).toEqual([
        id(catalogue[0]!),
        id(catalogue[1]!),
      ]);
      expect(ids(marked.poolRegistrations ?? [])).toEqual([id(catalogue[0]!), id(catalogue[1]!)]);

      // An inline row stores the logs and the mode, but never the array: a reader is told how to
      // read a register, and handed none. That is why a dataset cannot rely on its batches to carry
      // the register, whichever reading the array was written under.
      const inline = { ...withoutEvidence(marked), id: 'inline-probe' };
      store.saveRaw(inline);
      const inlineRead = readBatch(db, inline.id);
      expect(inlineRead.registryMode).toBe('referenced-v1');
      expect(inlineRead.poolRegistrations).toBeUndefined();
      expect(inlineRead.logs).toEqual(inline.logs);

      // A payload that no longer decompresses is refused rather than read as something else.
      const envelope = JSON.parse(
        db
          .prepare('select payload_json from ingest_batches where id=?')
          .pluck()
          .get(marked.id) as string,
      ) as { payload: PayloadRef };
      db.prepare('update payload_objects set payload=? where hash=?').run(
        Buffer.from('not gzip'),
        envelope.payload.hash,
      );
      expect(() => readBatch(db, marked.id)).toThrow(/gzip/);
    } finally {
      db.close();
    }
  }, 180_000);
});
