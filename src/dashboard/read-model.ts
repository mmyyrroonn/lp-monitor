import { createHash } from 'node:crypto';
import type { AssetRegistration } from '../registry/assets.js';
import { poolRegistrationId, type PoolRegistration } from '../registry/pools.js';
import { aggregateRwa } from '../metrics/rwa-aggregate.js';
import {
  inRollingWindow,
  prepareRollingCoverage,
  rollingCoverage,
  ROLLING_DURATIONS,
} from '../metrics/rolling.js';
import type { MetricCoverage } from '../metrics/coverage.js';
import type { SwapValuation } from '../metrics/notional.js';
import { countWork } from '../ops/work-counters.js';
import type {
  DashboardCoverage,
  DashboardPool,
  DashboardSummary,
  DashboardTokenSummary,
  Metric,
  PoolPage,
  RuntimeHealth,
  TokenHistory,
  TokenMinute,
  WindowName,
} from './types.js';

export const POOL_PAGE_DEFAULT_LIMIT = 20;
export const POOL_PAGE_MAX_LIMIT = 100;
/** Bound on the generation string a request may name. */
export const GENERATION_MAX_LENGTH = 128;
const HISTORY_MINUTES = 180;
const WINDOW_NAMES = Object.keys(ROLLING_DURATIONS) as WindowName[];

/** One committed registry mutation, reduced to what the read model has to follow. */
export type RegistryDeltaRow = {
  poolKey: string;
  before: PoolRegistration | null;
  after: PoolRegistration | null;
};

export type StockInput = { asset: AssetRegistration; valuations: readonly SwapValuation[] };

export type GenerationInput = {
  scopeId: string;
  registryScopeId: string;
  configVersion: string;
  assetVersion: string;
  sourceHash: string | null;
  registryRevision: number;
  metadataRevision: string | number | null;
  /** Selected historical cutoff (the final second of a minute), or null to follow the watermark. */
  cutoffSec: number | null;
  /** Accepted chain time the bounded inputs end at. */
  sourceChainTimeSec: number;
  /** End of this generation's windows: the cutoff when one was selected, else the watermark. */
  selectedEndSec: number;
  /** Start of the bounded hot window every retained input came from. */
  availableFromSec: number;
  nowMs: number;
  status: 'ok' | 'stale';
  message: string | null;
  health: RuntimeHealth;
  notes: readonly string[];
  coverage: readonly MetricCoverage[];
  stocks: readonly StockInput[];
  /** Whether a newer generation is already being computed; defaults to false. */
  refreshing?: boolean;
};

/** The parts of a publication that make two generations the same business version. */
export type GenerationKeyParts = {
  scopeId: string;
  registryScopeId: string;
  configVersion: string;
  assetVersion: string;
  sourceHash: string | null;
  registryRevision: number;
  metadataRevision: string | number | null;
  cutoffSec: number | null;
};

/** Stable, path-free identity of one generation: sha256 truncated to 32 hexadecimal characters. */
export function generationKey(parts: GenerationKeyParts): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        parts.scopeId,
        parts.registryScopeId,
        parts.configVersion,
        parts.assetVersion,
        parts.sourceHash,
        parts.registryRevision,
        parts.metadataRevision,
        parts.cutoffSec,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
}

/** A request named a generation this reader no longer holds. */
export class SnapshotExpiredError extends Error {
  constructor(generation: string) {
    super(`Snapshot generation ${generation} is no longer retained`);
    this.name = 'SnapshotExpiredError';
  }
}

type CoverageReasons = (start: number, end: number, birth: bigint | null) => string[];

/**
 * The one window rule. Coverage reasons are taken for the window and again for every pool's
 * discovery height, the events inside `(start, end]` are selected, and a value is published only
 * when nothing about the window is unknown. The legacy snapshot and the read model both answer
 * through this function, so the same window cannot come to mean two different things.
 */
function aggregateWith(
  swaps: readonly SwapValuation[],
  reasonsOf: CoverageReasons,
  watermark: number,
  startSec: number,
  endSec: number,
  pools: readonly PoolRegistration[],
): Metric {
  const coverageStart = startSec % 60 === 59 ? startSec + 1 : startSec;
  const reasons = reasonsOf(coverageStart, endSec, null);
  for (const pool of pools)
    if (pool.source !== 'seed-config')
      reasons.push(...reasonsOf(coverageStart, endSec, pool.discoveredAt.blockNumber));
  if (pools.length === 0) reasons.push('no-registered-pools');
  const selected = swaps.filter((s) => {
    const included = inRollingWindow(s.time, startSec, endSec, endSec === watermark);
    if (included === null) reasons.push('boundary-time-unknown');
    return included === true;
  });
  const available = reasons.length === 0;
  const activity = available ? aggregateRwa(selected) : null;
  return {
    available,
    startSec,
    endSec,
    txCount: activity?.txCount ?? null,
    swapCount: activity?.swapCount ?? null,
    usdMicros: activity?.poolActivityUsdMicros?.toString() ?? null,
    reasons: [...new Set(reasons)],
  };
}

/** The legacy entry point: the same output, and the same `rollingCoverage` calls as before. */
export function aggregateWindow(
  swaps: readonly SwapValuation[],
  coverage: readonly MetricCoverage[],
  watermark: number,
  startSec: number,
  endSec: number,
  pools: readonly PoolRegistration[],
): Metric {
  return aggregateWith(
    swaps,
    (start, end, birth) => rollingCoverage(coverage, start, end, watermark, birth),
    watermark,
    startSec,
    endSec,
    pools,
  );
}

const minimumOf = (values: readonly bigint[]): bigint =>
  values.reduce((left, right) => (right < left ? right : left));

/** Rank-minimum table over the eligible minutes, so a window costs O(1) after the build. */
function sparseMinimums(values: readonly bigint[]): readonly (readonly bigint[])[] {
  const table: (readonly bigint[])[] = [values];
  for (let span = 1; 1 << span <= values.length; span++) {
    const previous = table[span - 1]!,
      width = 1 << (span - 1),
      row: bigint[] = [];
    for (let index = 0; index + (1 << span) <= values.length; index++)
      row.push(minimumOf([previous[index]!, previous[index + width]!]));
    table.push(row);
  }
  return table;
}

/** First index whose value is not below `value`. */
function lowerBound(values: readonly number[], value: number): number {
  let low = 0,
    high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * One generation's coverage, prepared once: the reason rule for any window plus the smallest
 * `fromBlock` over any minute range.
 *
 * The interval minimum is what the per-pool discovery check reduces to — a pool shortens a window
 * exactly when its discovery height is above that window's smallest known height — so a stock can
 * answer for all of its pools with one comparison instead of one call per pool.
 */
export class CoverageQuery {
  readonly watermark: number;
  readonly #index: ReturnType<typeof prepareRollingCoverage>;
  readonly #minutes: number[] = [];
  readonly #minimums: bigint[] = [];
  readonly #sparse: readonly (readonly bigint[])[];
  /** Lowest height this coverage can verify: every height at or below it is settled for good. */
  readonly earliestFromBlock: bigint | null;

  constructor(coverage: readonly MetricCoverage[], watermark: number) {
    this.watermark = watermark;
    this.#index = prepareRollingCoverage(coverage);
    // `rollingCoverage` keeps the last row of a minute; the eligible minutes below have to agree
    // with that view, or a window's reason and its interval minimum would describe two coverages.
    const byMinute = new Map<number, MetricCoverage>();
    for (const row of coverage) byMinute.set(row.minuteStartSec, row);
    const eligible = [...byMinute.values()]
      .filter((row) => row.fromBlock !== null && row.toBlock !== null)
      .sort((left, right) => left.minuteStartSec - right.minuteStartSec);
    for (const row of eligible) {
      this.#minutes.push(row.minuteStartSec);
      this.#minimums.push(row.fromBlock!);
    }
    this.#sparse = sparseMinimums(this.#minimums);
    this.earliestFromBlock = this.#minimums.length === 0 ? null : minimumOf(this.#minimums);
  }

  reasons(start: number, end: number, birth: bigint | null): string[] {
    return this.#index.reasons(start, end, this.watermark, birth);
  }

  /** Smallest known `fromBlock` over the minutes the reason rule would visit, or null for none. */
  rangeMin(start: number, end: number): bigint | null {
    const first = lowerBound(this.#minutes, Math.max(0, Math.floor(start / 60) * 60)),
      after = lowerBound(this.#minutes, Math.floor(end / 60) * 60 + 1);
    if (first >= after) return null;
    const span = 31 - Math.clz32(after - first),
      row = this.#sparse[span]!;
    return minimumOf([row[first]!, row[after - (1 << span)]!]);
  }
}

/** The shared window rule over an already prepared coverage set. */
function aggregatePrepared(
  swaps: readonly SwapValuation[],
  query: CoverageQuery,
  startSec: number,
  endSec: number,
  pools: readonly PoolRegistration[],
): Metric {
  return aggregateWith(
    swaps,
    (start, end, birth) => query.reasons(start, end, birth),
    query.watermark,
    startSec,
    endSec,
    pools,
  );
}

type BirthEntry = { birth: bigint; poolId: string };

/**
 * The discovery heights of one stock's pools, ascending, behind a cursor that drops what the
 * coverage has already left behind.
 *
 * A pool can only deny a window while its discovery height is above that window's smallest known
 * height, and the smallest known height only rises as the coverage moves forward. Everything the
 * cursor consumed is therefore settled forever, which is what keeps a silent pool from costing a
 * window object of its own — and what makes the whole stock one comparison instead of a loop.
 *
 * Pools with no known height — seed records, and records whose discovery height is absent — never
 * deny a window, so they never enter the entries at all and cost nothing to weigh.
 */
class BirthGroups {
  readonly #entries: readonly BirthEntry[];
  #retired = 0;
  #retiredTo: bigint | null = null;

  constructor(entries: readonly BirthEntry[]) {
    this.#entries = entries;
  }

  /** Highest height that can still deny a window, or null when none can. */
  maxActive(threshold: bigint | null): bigint | null {
    this.#retire(threshold);
    if (this.#retired < this.#entries.length) return this.#entries[this.#entries.length - 1]!.birth;
    // Everything is consumed: only heights above this query's own threshold still count, and the
    // consumed prefix is ascending, so its last entry is the largest one that could.
    const last = this.#retired === 0 ? null : this.#entries[this.#retired - 1]!.birth;
    return last !== null && threshold !== null && last > threshold ? last : null;
  }

  /** The pools whose discovery height is above `floor`, in pool id order. */
  above(floor: bigint): string[] {
    let low = 0,
      high = this.#entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.#entries[middle]!.birth <= floor) low = middle + 1;
      else high = middle;
    }
    const ids: string[] = [];
    for (let index = low; index < this.#entries.length; index++)
      ids.push(this.#entries[index]!.poolId);
    return ids.sort((left, right) => left.localeCompare(right));
  }

  #retire(threshold: bigint | null): void {
    if (threshold === null) return;
    // Retirement never rolls back. A later query with a lower threshold is still answered exactly,
    // because the consumed prefix is ascending and holds at most one candidate for it.
    if (this.#retiredTo !== null && threshold <= this.#retiredTo) return;
    while (this.#retired < this.#entries.length && this.#entries[this.#retired]!.birth <= threshold)
      this.#retired++;
    this.#retiredTo = threshold;
  }
}

/** One stock's derived views: its pool ids in a stable order, and the heights that can still deny. */
type AssetView = { ids: readonly string[]; births: BirthGroups };

const tokensOf = (record: PoolRegistration): readonly string[] => [
  ...new Set([record.token0.toLowerCase(), record.token1.toLowerCase()]),
];
const birthOf = (record: PoolRegistration): bigint | null =>
  record.source === 'seed-config' ? null : record.discoveredAt.blockNumber;

/**
 * The registry as one indexed state: identity lookup, membership per token, and per-asset views
 * built on demand. A delta marks only the tokens it touched, so an untouched stock keeps the arrays
 * it already had instead of being rebuilt from the catalogue on every round.
 */
class PoolIndex {
  readonly #byId = new Map<string, PoolRegistration>();
  readonly #byAsset = new Map<string, Set<string>>();
  readonly #views = new Map<string, AssetView>();
  readonly #stale = new Set<string>();

  get(poolId: string): PoolRegistration | undefined {
    return this.#byId.get(poolId);
  }

  count(asset: string): number {
    return this.#byAsset.get(asset)?.size ?? 0;
  }

  member(asset: string, poolId: string): boolean {
    return this.#byAsset.get(asset)?.has(poolId) ?? false;
  }

  add(record: PoolRegistration): void {
    const id = poolRegistrationId(record),
      previous = this.#byId.get(id);
    if (previous !== undefined) this.#detach(previous, id);
    this.#byId.set(id, record);
    for (const token of tokensOf(record)) {
      const members = this.#byAsset.get(token) ?? new Set<string>();
      members.add(id);
      this.#byAsset.set(token, members);
      this.#stale.add(token);
    }
  }

  remove(poolId: string): PoolRegistration | null {
    const record = this.#byId.get(poolId);
    if (record === undefined) return null;
    this.#byId.delete(poolId);
    this.#detach(record, poolId);
    return record;
  }

  /** Pool ids of one token, ascending, sorted once per version of the membership. */
  ids(asset: string): readonly string[] {
    return this.#view(asset).ids;
  }

  /** Discovery heights of one token's pools; the coverage cursor consumes them as it advances. */
  births(asset: string): BirthGroups {
    return this.#view(asset).births;
  }

  #detach(record: PoolRegistration, poolId: string): void {
    for (const token of tokensOf(record)) {
      const members = this.#byAsset.get(token);
      if (members === undefined) continue;
      members.delete(poolId);
      if (members.size === 0) this.#byAsset.delete(token);
      this.#stale.add(token);
    }
  }

  #view(asset: string): AssetView {
    const cached = this.#views.get(asset);
    if (cached !== undefined && !this.#stale.has(asset)) return cached;
    const ids = [...(this.#byAsset.get(asset) ?? [])].sort((left, right) =>
      left.localeCompare(right),
    );
    countWork('readModelRegistryScans', ids.length);
    const entries: BirthEntry[] = [];
    for (const id of ids) {
      const record = this.#byId.get(id);
      if (record === undefined) continue;
      const birth = birthOf(record);
      if (birth !== null) entries.push({ birth, poolId: id });
    }
    entries.sort((left, right) =>
      left.birth === right.birth
        ? left.poolId.localeCompare(right.poolId)
        : left.birth < right.birth
          ? -1
          : 1,
    );
    const view: AssetView = { ids, births: new BirthGroups(entries) };
    this.#views.set(asset, view);
    this.#stale.delete(asset);
    return view;
  }
}

/** Membership an older generation holds that the base no longer does, and the reverse. */
type MemberCorrections = { entries: Map<string, boolean>; added: number; removed: number };

/**
 * One generation's registry: the shared base plus the small undo overlay that keeps the pools a
 * later delta moved or removed visible to the generation published before it. The base is never
 * copied — only the identities that really moved are recorded, and only for the generations alive
 * when they moved.
 */
class GenerationRegistry {
  readonly records = new Map<string, PoolRegistration | null>();
  readonly corrections = new Map<string, MemberCorrections>();
  /** Assets whose heights may have moved since publication: they answer from their own members. */
  readonly touched = new Set<string>();
  readonly #maxBirth = new Map<string, bigint | null>();

  constructor(private readonly index: PoolIndex) {}

  record(poolId: string): PoolRegistration | null {
    const own = this.records.get(poolId);
    if (own !== undefined) return own;
    return this.index.get(poolId) ?? null;
  }

  count(asset: string): number {
    const own = this.correctionsFor(asset);
    return this.index.count(asset) - (own?.added ?? 0) + (own?.removed ?? 0);
  }

  /** Whether this generation attributes the pool to the stock, overlay included. */
  member(asset: string, poolId: string): boolean {
    const fixed = this.correctionsFor(asset)?.entries.get(poolId);
    return fixed ?? this.index.member(asset, poolId);
  }

  /** Members of this generation in pool id order, merging the base array with the overlay's fixes. */
  *memberIds(asset: string): Iterable<string> {
    const own = this.correctionsFor(asset);
    if (own === undefined) {
      yield* this.index.ids(asset);
      return;
    }
    const restored: string[] = [];
    for (const [poolId, member] of own.entries) if (member) restored.push(poolId);
    restored.sort((left, right) => left.localeCompare(right));
    let next = 0;
    for (const poolId of this.index.ids(asset)) {
      while (next < restored.length && restored[next]!.localeCompare(poolId) < 0) {
        yield restored[next]!;
        next++;
      }
      if (own.entries.get(poolId) === false) continue;
      yield poolId;
    }
    while (next < restored.length) {
      yield restored[next]!;
      next++;
    }
  }

  /**
   * Highest discovery height that can still deny this generation's windows. A touched stock is
   * answered from its own members, because a delta can move a height that no membership correction
   * covers; an untouched stock keeps the shared view, which is the same one it published with.
   */
  maxBirth(asset: string, threshold: bigint | null): bigint | null {
    if (!this.touched.has(asset)) return this.index.births(asset).maxActive(threshold);
    if (this.#maxBirth.has(asset)) return this.#maxBirth.get(asset)!;
    let highest: bigint | null = null;
    for (const poolId of this.memberIds(asset)) {
      const record = this.record(poolId);
      if (record === null) continue;
      const birth = birthOf(record);
      if (birth !== null && (highest === null || birth > highest)) highest = birth;
    }
    this.#maxBirth.set(asset, highest);
    return highest;
  }

  /** Members whose discovery height is above `floor`, in pool id order. */
  aboveBirth(asset: string, floor: bigint): string[] {
    if (!this.touched.has(asset)) return this.index.births(asset).above(floor);
    const ids: string[] = [];
    for (const poolId of this.memberIds(asset)) {
      const record = this.record(poolId);
      if (record === null) continue;
      const birth = birthOf(record);
      if (birth !== null && birth > floor) ids.push(poolId);
    }
    return ids.sort((left, right) => left.localeCompare(right));
  }

  private correctionsFor(asset: string): MemberCorrections | undefined {
    const own = this.corrections.get(asset);
    return own === undefined || own.entries.size === 0 ? undefined : own;
  }
}

type StockView = {
  address: string;
  symbol: string;
  valuations: readonly SwapValuation[];
  /** Valuations per pool in event order, grouped once per generation on the first detail request. */
  byPool: Map<string, SwapValuation[]> | null;
};

/** One readable version of the dashboard: fixed registry view, coverage, cutoff and inputs. */
class Generation {
  readonly stocks = new Map<string, StockView>();
  readonly registry: GenerationRegistry;
  summary: DashboardSummary;

  constructor(
    readonly key: string,
    summary: DashboardSummary,
    readonly cutoffSec: number | null,
    readonly selectedEndSec: number,
    readonly watermark: number,
    readonly availableFromSec: number,
    readonly coverage: readonly MetricCoverage[],
    readonly query: CoverageQuery,
    registry: GenerationRegistry,
    inputs: readonly StockInput[],
  ) {
    this.summary = summary;
    this.registry = registry;
    for (const input of inputs) {
      const address = input.asset.address.toLowerCase();
      this.stocks.set(address, {
        address,
        symbol: input.asset.symbol,
        valuations: input.valuations,
        byPool: null,
      });
    }
  }

  valuationsOf(asset: string): readonly SwapValuation[] {
    return this.stocks.get(asset)?.valuations ?? [];
  }

  byPoolOf(asset: string): Map<string, SwapValuation[]> {
    const stock = this.stocks.get(asset);
    if (stock === undefined) return new Map();
    stock.byPool ??= groupByPool(stock.valuations);
    return stock.byPool;
  }
}

/** Page order for one window, as the app's comparator would produce it, without building pools. */
type WindowOrder = {
  hot: readonly { poolId: string; txCount: number }[];
  hotIds: ReadonlySet<string>;
  /** Ranked last by the comparator: unknown value, or a window the pool's own discovery denies. */
  nullIds: readonly string[];
  nullSet: ReadonlySet<string>;
  /** The window is unknown for every pool, so the whole page is in pool id order. */
  allNull: boolean;
};

function groupByPool(valuations: readonly SwapValuation[]): Map<string, SwapValuation[]> {
  const grouped = new Map<string, SwapValuation[]>();
  for (const valuation of valuations) {
    const poolId = poolRegistrationId({ pool: valuation.pool });
    const group = grouped.get(poolId) ?? [];
    group.push(valuation);
    grouped.set(poolId, group);
  }
  return grouped;
}

function lruPut<K, V>(cache: Map<K, V>, capacity: number, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > capacity) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function lruTouch<K, V>(cache: Map<K, V>, key: K): V {
  const value = cache.get(key)!;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

/**
 * The dashboard read model: one shared, incrementally advanced registry index, a bounded set of
 * published generations, and per-generation views that answer pages and history from the inputs
 * that generation was published with — never from a later read of the database.
 */
export class DashboardReadModel {
  readonly #index = new PoolIndex();
  readonly #generations = new Map<string, Generation>();
  readonly #pages = new Map<string, PoolPage>();
  readonly #orders = new Map<string, WindowOrder>();
  readonly #retainedGenerations: number;
  readonly #retainedCutoffs: number;
  readonly #pageCapacity: number;
  #loaded = false;
  #indexBuilds = 0;

  constructor(
    options: {
      retainedGenerations?: number;
      retainedCutoffs?: number;
      poolPageCache?: number;
    } = {},
  ) {
    this.#retainedGenerations = options.retainedGenerations ?? 2;
    this.#retainedCutoffs = options.retainedCutoffs ?? 4;
    this.#pageCapacity = options.poolPageCache ?? 64;
  }

  /**
   * Read a whole catalogue. Every later change is supposed to arrive as a delta, so a second call
   * unions more records in rather than replacing what is held: an already published generation
   * answers from this index, and dropping records under it would rewrite a version already served.
   */
  loadRegistry(pools: readonly PoolRegistration[]): void {
    this.#indexBuilds++;
    countWork('readModelIndexBuilds');
    for (const pool of pools) this.#index.add(pool);
    countWork('readModelRegistryScans', pools.length);
    this.#loaded = true;
  }

  /**
   * Follow committed registry mutations. Every generation already published records what the moved
   * pools looked like before this call, so its pages keep answering from its own version even
   * though the shared base moves on.
   */
  applyRegistryDelta(rows: readonly RegistryDeltaRow[]): void {
    if (!this.#loaded) throw new Error('Registry must be loaded before applying deltas');
    const generations = [...this.#generations.values()],
      touched = new Set<string>();
    for (const row of rows) {
      const ids = new Set<string>();
      if (row.before !== null) ids.add(poolRegistrationId(row.before));
      if (row.after !== null) ids.add(poolRegistrationId(row.after));
      for (const generation of generations)
        for (const poolId of ids) {
          // The first delta to move a pool records the version every live generation published
          // with; a later delta must not overwrite that with a version no generation ever showed.
          if (generation.registry.records.has(poolId)) continue;
          generation.registry.records.set(poolId, this.#index.get(poolId) ?? null);
        }
      for (const record of [row.before, row.after])
        if (record !== null) for (const token of tokensOf(record)) touched.add(token);
    }
    for (const row of rows) this.#applyRow(row);
    // Membership is compared only after the base moved: an asset is corrected exactly when the
    // generation and the base disagree, and the correction records which side the generation is on.
    if (touched.size === 0) return;
    for (const generation of generations)
      for (const asset of touched) {
        const corrections = generation.registry.corrections.get(asset) ?? {
          entries: new Map<string, boolean>(),
          added: 0,
          removed: 0,
        };
        for (const row of rows)
          for (const record of [row.before, row.after]) {
            if (record === null || !tokensOf(record).includes(asset)) continue;
            generation.registry.touched.add(asset);
            const poolId = poolRegistrationId(record),
              held = generation.registry.record(poolId),
              has = held !== null && tokensOf(held).includes(asset),
              now = this.#index.member(asset, poolId),
              previous = corrections.entries.get(poolId);
            if (has === now) {
              if (previous === undefined) continue;
              corrections.entries.delete(poolId);
              if (has) corrections.removed--;
              else corrections.added--;
              continue;
            }
            if (previous === has) continue;
            if (previous === undefined) {
              if (has) corrections.removed++;
              else corrections.added++;
            } else if (has) {
              corrections.added--;
              corrections.removed++;
            } else {
              corrections.removed--;
              corrections.added++;
            }
            corrections.entries.set(poolId, has);
          }
        if (corrections.entries.size === 0) generation.registry.corrections.delete(asset);
        else generation.registry.corrections.set(asset, corrections);
      }
  }

  /** Compute one generation from bounded inputs and make it the latest. */
  publish(input: GenerationInput): DashboardSummary {
    if (!this.#loaded) throw new Error('Registry must be loaded before publishing');
    const key = generationKey(input),
      query = new CoverageQuery(input.coverage, input.sourceChainTimeSec),
      // The generation is published against the base registry as it stands now; deltas that arrive
      // afterwards leave this view untouched through the overlay the same instance accumulates.
      registry = new GenerationRegistry(this.#index);
    const tokens = input.stocks.map((stock) => summarize(query, registry, stock, input));
    const summary: DashboardSummary = {
      status: input.status,
      generatedAtMs: input.nowMs,
      sourceChainTimeSec: input.sourceChainTimeSec,
      selectedEndSec: input.selectedEndSec,
      availableFromSec: input.availableFromSec,
      sourceHash: input.sourceHash,
      scopeId: input.scopeId,
      assetVersion: input.assetVersion,
      tokens,
      coverage: input.coverage
        .filter(
          (row) =>
            row.minuteStartSec >= input.availableFromSec &&
            row.minuteStartSec <= input.selectedEndSec,
        )
        .map((row): DashboardCoverage => ({
          minuteStartSec: row.minuteStartSec,
          complete: row.complete,
          reasons: [...row.reasons],
        })),
      health: input.health,
      message: input.message,
      notes: [...input.notes],
      apiVersion: 2,
      generation: key,
      refreshing: input.refreshing ?? false,
    };
    const generation = new Generation(
      key,
      summary,
      input.cutoffSec,
      input.selectedEndSec,
      input.sourceChainTimeSec,
      input.availableFromSec,
      input.coverage,
      query,
      registry,
      input.stocks,
    );
    this.#generations.delete(key);
    // The hot window can move on without any part of the key moving: a round that reports the same
    // business version may still carry fresher data, and the views cached under that identical
    // generation string describe the round it replaces.
    this.#dropViews(key);
    this.#generations.set(key, generation);
    this.#evict();
    return summary;
  }

  latest(): DashboardSummary | null {
    let latest: Generation | undefined;
    for (const generation of this.#generations.values()) latest = generation;
    return latest?.summary ?? null;
  }

  /** Mark the latest summary as being recomputed without changing the data it still reports. */
  setRefreshing(refreshing: boolean): DashboardSummary | null {
    let latest: Generation | undefined;
    for (const generation of this.#generations.values()) latest = generation;
    if (latest === undefined) return null;
    if (latest.summary.refreshing !== refreshing)
      latest.summary = { ...latest.summary, refreshing };
    return latest.summary;
  }

  has(generation: string): boolean {
    return this.#generations.has(generation);
  }

  pools(query: {
    generation: string;
    tokenAddress: string;
    window: WindowName;
    offset: number;
    limit?: number;
  }): PoolPage {
    const request = this.#normalizeQuery(query),
      generation = this.#require(request.generation),
      key = `${request.generation}|${request.asset}|${request.window}|${request.offset}|${request.limit}`,
      cached = this.#pages.get(key);
    if (cached !== undefined) {
      countWork('readModelPageCacheHits');
      return lruTouch(this.#pages, key);
    }
    const total = generation.registry.count(request.asset),
      order = this.#windowOrder(generation, request.asset, request.window),
      ids: string[] = [];
    let position = 0;
    const consider = (poolId: string): boolean => {
      if (position >= request.offset && ids.length < request.limit) ids.push(poolId);
      position++;
      return ids.length >= request.limit;
    };
    if (order.allNull) {
      for (const poolId of generation.registry.memberIds(request.asset))
        if (consider(poolId)) break;
    } else {
      for (const entry of order.hot) if (consider(entry.poolId)) break;
      if (ids.length < request.limit)
        for (const poolId of generation.registry.memberIds(request.asset)) {
          if (order.hotIds.has(poolId) || order.nullSet.has(poolId)) continue;
          if (consider(poolId)) break;
        }
      if (ids.length < request.limit)
        for (const poolId of order.nullIds) if (consider(poolId)) break;
    }
    const items = ids.map((poolId) => poolDetail(generation, request.asset, poolId));
    countWork('readModelPoolsBuilt', items.length);
    const page: PoolPage = {
      generation: request.generation,
      tokenAddress: request.asset,
      window: request.window,
      offset: request.offset,
      limit: request.limit,
      total,
      nextOffset: request.offset + items.length < total ? request.offset + items.length : null,
      items,
    };
    lruPut(this.#pages, this.#pageCapacity, key, page);
    return page;
  }

  /**
   * The minute series the trend chart draws, bounded by the watermark rather than by the selected
   * cutoff: a generation asked for a historical `at` still charts the minutes it was published
   * with, so a minute never means one thing in the summary and another in the chart.
   */
  history(query: { generation: string; tokenAddress: string }): TokenHistory {
    const generation = this.#require(query.generation),
      asset = this.#asset(query.tokenAddress),
      watermark = generation.watermark,
      last = Math.floor(watermark / 60) * 60,
      from = Math.max(
        0,
        last - HISTORY_MINUTES * 60,
        generation.coverage.find((row) => row.fromBlock !== null)?.minuteStartSec ?? watermark,
      );
    const poolCount = generation.registry.count(asset),
      valuations = generation.valuationsOf(asset),
      minutes: TokenMinute[] = [];
    for (let minuteStartSec = from; minuteStartSec <= last; minuteStartSec += 60) {
      const value = windowMetric(
        generation.query,
        generation.registry,
        asset,
        valuations,
        minuteStartSec - 1,
        Math.min(minuteStartSec + 59, watermark),
        poolCount,
      );
      minutes.push({
        minuteStartSec,
        status: !value.available
          ? value.reasons.includes('pool-lifetime-incomplete')
            ? ('warming' as const)
            : ('gap' as const)
          : minuteStartSec + 59 > watermark
            ? ('partial' as const)
            : ('closed' as const),
        txCount: value.txCount,
        swapCount: value.swapCount,
        usdMicros: value.usdMicros,
        reasons: value.reasons,
      });
    }
    return { generation: query.generation, tokenAddress: asset, minutes };
  }

  counts(): { generations: number; poolPages: number; indexBuilds: number } {
    return {
      generations: this.#generations.size,
      poolPages: this.#pages.size,
      indexBuilds: this.#indexBuilds,
    };
  }

  #applyRow(row: RegistryDeltaRow): void {
    const before = row.before === null ? null : poolRegistrationId(row.before);
    if (row.after === null) {
      if (before !== null) this.#index.remove(before);
      return;
    }
    const after = poolRegistrationId(row.after);
    this.#index.add(row.after);
    if (before !== null && before !== after) this.#index.remove(before);
  }

  #require(generation: string): Generation {
    const held = this.#generations.get(generation);
    if (held === undefined) throw new SnapshotExpiredError(generation);
    return held;
  }

  #asset(tokenAddress: string): string {
    if (typeof tokenAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress))
      throw new RangeError('Token address must be a 20-byte hexadecimal address');
    return tokenAddress.toLowerCase();
  }

  #normalizeQuery(query: {
    generation: string;
    tokenAddress: string;
    window: WindowName;
    offset: number;
    limit?: number;
  }): { generation: string; asset: string; window: WindowName; offset: number; limit: number } {
    if (
      typeof query.generation !== 'string' ||
      query.generation.length === 0 ||
      query.generation.length > GENERATION_MAX_LENGTH
    )
      throw new RangeError('Generation must be a non-empty string of at most 128 characters');
    if (!WINDOW_NAMES.includes(query.window))
      throw new RangeError('Window must be one of 1m, 5m, 15m, 1h');
    if (!Number.isSafeInteger(query.offset) || query.offset < 0)
      throw new RangeError('Offset must be a non-negative safe integer');
    const limit = query.limit ?? POOL_PAGE_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > POOL_PAGE_MAX_LIMIT)
      throw new RangeError('Limit must be an integer from 1 through 100');
    return {
      generation: query.generation,
      asset: this.#asset(query.tokenAddress),
      window: query.window,
      offset: query.offset,
      limit,
    };
  }

  #evict(): void {
    const live = [...this.#generations.values()].filter(
      (generation) => generation.cutoffSec === null,
    );
    while (live.length > this.#retainedGenerations) this.#drop(live.shift()!);
    const historical = [...this.#generations.values()].filter(
      (generation) => generation.cutoffSec !== null,
    );
    const cutoffs = [...new Set(historical.map((generation) => generation.cutoffSec!))].sort(
      (left, right) => left - right,
    );
    while (cutoffs.length > this.#retainedCutoffs) {
      const dropped = cutoffs.shift()!;
      for (const generation of historical)
        if (generation.cutoffSec === dropped) this.#drop(generation);
    }
  }

  #drop(generation: Generation): void {
    this.#generations.delete(generation.key);
    this.#dropViews(generation.key);
  }

  /** Drop everything derived from one generation string. */
  #dropViews(key: string): void {
    for (const cached of [...this.#pages.keys()])
      if (cached.startsWith(`${key}|`)) this.#pages.delete(cached);
    for (const cached of [...this.#orders.keys()])
      if (cached.startsWith(`${key}|`)) this.#orders.delete(cached);
  }

  /**
   * The page order of one window: the pools with a transaction first, then the pools whose window
   * is a known zero, then the pools whose window is unknown — exactly what the app's comparator
   * produces, and computed without assembling a single pool detail.
   */
  #windowOrder(generation: Generation, asset: string, window: WindowName): WindowOrder {
    const key = `${generation.key}|${asset}|${window}`,
      cached = this.#orders.get(key);
    if (cached !== undefined) return lruTouch(this.#orders, key);
    const end = generation.selectedEndSec,
      start = end - ROLLING_DURATIONS[window],
      coverageStart = start % 60 === 59 ? start + 1 : start;
    // A window the coverage already denies is denied for every pool in it, so no pool's own
    // discovery can reorder the page: nothing is hot, and every entry sorts by pool id.
    const allNull = generation.query.reasons(coverageStart, end, null).length > 0;
    const hot = allNull
      ? []
      : hotPools(
          generation.query,
          generation.registry,
          asset,
          generation.valuationsOf(asset),
          start,
          end,
        );
    const hotIds = new Set(hot.map((entry) => entry.poolId));
    let nullIds: string[] = [];
    if (!allNull) {
      const floor = generation.query.rangeMin(coverageStart, end),
        byBirth = floor === null ? [] : generation.registry.aboveBirth(asset, floor);
      const byEvent: string[] = [];
      for (const [poolId, swaps] of generation.byPoolOf(asset)) {
        // Ranked only when this generation attributes the pool here, exactly like the hot group:
        // the two groups together with the cold walk have to be the stock's members, once each.
        if (hotIds.has(poolId) || !generation.registry.member(asset, poolId)) continue;
        const record = generation.registry.record(poolId);
        if (record === null) continue;
        if (!aggregatePrepared(swaps, generation.query, start, end, [record]).available)
          byEvent.push(poolId);
      }
      nullIds = [...new Set([...byBirth, ...byEvent])].sort((left, right) =>
        left.localeCompare(right),
      );
    }
    const order: WindowOrder = { hot, hotIds, nullIds, nullSet: new Set(nullIds), allNull };
    lruPut(this.#orders, this.#pageCapacity, key, order);
    return order;
  }
}

/**
 * Pools whose window holds at least one transaction, ranked the way the app ranks them.
 *
 * Only pools this generation registers for the stock are ranked: a valuation names a pool, not the
 * stock that owns it, and a pool the generation does not attribute here is not one of the stock's
 * cards — counting it would put a page out of step with the total it reports.
 */
function hotPools(
  query: CoverageQuery,
  registry: GenerationRegistry,
  asset: string,
  valuations: readonly SwapValuation[],
  startSec: number,
  endSec: number,
): { poolId: string; txCount: number }[] {
  const hot: { poolId: string; txCount: number }[] = [];
  for (const [poolId, swaps] of groupByPool(valuations)) {
    if (!registry.member(asset, poolId)) continue;
    const record = registry.record(poolId);
    if (record === null) continue;
    const metric = aggregatePrepared(swaps, query, startSec, endSec, [record]);
    if (metric.available && (metric.txCount ?? 0) > 0)
      hot.push({ poolId, txCount: metric.txCount! });
  }
  return hot.sort(
    (left, right) => right.txCount - left.txCount || left.poolId.localeCompare(right.poolId),
  );
}

/**
 * One stock window. The per-pool discovery loop the legacy rule runs is replaced by a single
 * interval comparison, which reaches the same verdict: a pool denies the window exactly when its
 * discovery height is above the window's smallest known height.
 */
function windowMetric(
  query: CoverageQuery,
  registry: GenerationRegistry,
  asset: string,
  valuations: readonly SwapValuation[],
  startSec: number,
  endSec: number,
  poolCount: number,
): Metric {
  const coverageStart = startSec % 60 === 59 ? startSec + 1 : startSec;
  const reasons = query.reasons(coverageStart, endSec, null);
  if (poolCount === 0) reasons.push('no-registered-pools');
  else {
    const highest = registry.maxBirth(asset, query.earliestFromBlock),
      floor = query.rangeMin(coverageStart, endSec);
    if (highest !== null && floor !== null && floor < highest)
      reasons.push('pool-lifetime-incomplete');
  }
  const selected = valuations.filter((valuation) => {
    const included = inRollingWindow(valuation.time, startSec, endSec, endSec === query.watermark);
    if (included === null) reasons.push('boundary-time-unknown');
    return included === true;
  });
  const available = reasons.length === 0,
    activity = available ? aggregateRwa(selected) : null;
  return {
    available,
    startSec,
    endSec,
    txCount: activity?.txCount ?? null,
    swapCount: activity?.swapCount ?? null,
    usdMicros: activity?.poolActivityUsdMicros?.toString() ?? null,
    reasons: [...new Set(reasons)],
  };
}

function summarize(
  query: CoverageQuery,
  registry: GenerationRegistry,
  stock: StockInput,
  input: GenerationInput,
): DashboardTokenSummary {
  const asset = stock.asset.address.toLowerCase(),
    poolCount = registry.count(asset),
    end = input.selectedEndSec,
    windows = {} as Record<WindowName, { current: Metric; previous: Metric }>,
    activePoolCount = {} as Record<WindowName, number>;
  for (const name of WINDOW_NAMES) {
    const duration = ROLLING_DURATIONS[name];
    windows[name] = {
      current: windowMetric(
        query,
        registry,
        asset,
        stock.valuations,
        end - duration,
        end,
        poolCount,
      ),
      previous: windowMetric(
        query,
        registry,
        asset,
        stock.valuations,
        end - duration * 2,
        end - duration,
        poolCount,
      ),
    };
    activePoolCount[name] = hotPools(
      query,
      registry,
      asset,
      stock.valuations,
      end - duration,
      end,
    ).length;
  }
  return {
    address: stock.asset.address,
    symbol: stock.asset.symbol,
    category: 'rwa',
    windows,
    poolCount,
    activePoolCount,
  };
}

/** One pool's detail, built only for the pools a page actually returns. */
function poolDetail(generation: Generation, asset: string, poolId: string): DashboardPool {
  const record = generation.registry.record(poolId);
  if (record === null)
    throw new Error(`Page member ${poolId} has no registration in this generation`);
  const swaps = generation.byPoolOf(asset).get(poolId) ?? [],
    end = generation.selectedEndSec,
    windows = {} as Record<WindowName, Metric>;
  for (const name of WINDOW_NAMES)
    windows[name] = aggregatePrepared(swaps, generation.query, end - ROLLING_DURATIONS[name], end, [
      record,
    ]);
  const latest = swaps
    .filter((swap) => inRollingWindow(swap.time, -1, end, end === generation.watermark) !== false)
    .at(-1);
  return {
    poolId,
    protocol: record.pool.protocol,
    token0: record.token0,
    token1: record.token1,
    windows,
    lastSwapTimeSec: latest?.time.exactTimestampSec ?? null,
  };
}
