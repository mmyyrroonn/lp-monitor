import type Database from 'better-sqlite3';
import type { PoolEvent } from '../domain/types.js';
import { countWork } from '../ops/work-counters.js';
import { poolRegistrationId } from '../registry/pools.js';
import { comparePosition } from '../state/observations.js';
import { rawLogKey } from './manifest.js';

/** The events one projection sync added, revised or removed, collected where their rows were written. */
export type EventDelta = {
  upserts: readonly PoolEvent[];
  /** `rawLogKey` of every event this round removed, taken before its row was deleted. */
  deletedKeys: readonly string[];
};

/** The bounded window a live evaluation reads. */
export type EventWindowBounds = {
  /** Minutes that start before this are outside the window. */
  sinceSec: number;
  /**
   * The height of the verified boundary at or below `sinceSec`. An event with no resolved minute
   * cannot leave until a boundary can bound it, so `null` — no such boundary exists — keeps every
   * one of them and says the window context is incomplete rather than dropping them on arrival.
   */
  sinceBlock: bigint | null;
};

export interface LiveEventIndex {
  apply(delta: EventDelta): void;
  eventsFor(poolIds: ReadonlySet<string>): readonly PoolEvent[];
  poolsForToken(address: string): ReadonlySet<string>;
  expire(bounds: EventWindowBounds): ReadonlySet<string>;
}

/** Every event, for a caller that has no window yet. Only the first round of a fresh process. */
const UNBOUNDED: EventWindowBounds = { sinceSec: 0, sinceBlock: null };
const EMPTY: ReadonlySet<string> = new Set<string>();
const WINDOW_ROWS = `select payload_json from live_events where scope_id=? and (
     (minute_start_sec is not null and minute_start_sec>=?)
     or (minute_start_sec is null and (? is null or block_number>=?))
   )`;

type Indexed = { poolId: string | null; event: PoolEvent };

/** The tokens an event's valuation can depend on. Liquidity actions carry no quote of their own. */
function tokensOf(event: PoolEvent): readonly string[] {
  return event.kind === 'swap' ? [event.tokenIn.toLowerCase(), event.tokenOut.toLowerCase()] : [];
}

function insideWindow(event: PoolEvent, bounds: EventWindowBounds | null): boolean {
  if (bounds === null) return true;
  if (event.time.minuteStartSec !== null) return event.time.minuteStartSec >= bounds.sinceSec;
  return bounds.sinceBlock === null || event.ref.blockNumber >= bounds.sinceBlock;
}

/** Revive the bigint fields a JSON round trip turned into strings. */
export function reviveEvent(event: PoolEvent): PoolEvent {
  event.ref.blockNumber = BigInt(event.ref.blockNumber);
  if (event.kind === 'swap')
    for (const key of [
      'rawAmount0',
      'rawAmount1',
      'amountIn',
      'amountOut',
      'sqrtPriceX96After',
      'liquidityAfter',
    ] as const)
      event[key] = BigInt(event[key]);
  else if (event.kind === 'liquidity') event.delta = BigInt(event.delta);
  return event;
}

/**
 * The live events a bounded window still reads, indexed by log key, by pool and by the tokens a
 * swap names.
 *
 * The projection's own store keeps every event it ever derived, on disk and indexed by minute; this
 * index keeps the part of that history a read can still name, in memory, and is advanced by the
 * delta the projection collects at its own INSERT/UPDATE/DELETE sites. No round reads `live_events`
 * to discover what changed, and no round evaluates a pool whose events left the window.
 *
 * A mutation here is only as durable as the transaction that produced it. Every mutation marks the
 * index with the cursor token that same transaction writes, and every later entry point compares
 * the two: a transaction that rolled back left the cursor at its previous token, so the
 * disagreement is exactly the case where this window outlived the rows it came from, and the
 * window is derived again from the rows that survived. The check is one indexed row read.
 */
export class LiveEventIndexStore implements LiveEventIndex {
  readonly #byKey = new Map<string, Indexed>();
  readonly #keysByPool = new Map<string, Set<string>>();
  readonly #poolsByToken = new Map<string, Set<string>>();
  /** token -> pool -> how many of that pool's windowed events name the token. */
  readonly #tokenRefs = new Map<string, Map<string, number>>();
  #bounds: EventWindowBounds | null = null;
  #loaded = false;
  #contextIncomplete = false;
  #token: string | null = null;
  #recentlyExpired = new Set<string>();
  #generation = 0;

  constructor(
    private readonly db: Database.Database,
    private readonly scopeId: string,
  ) {}

  /** The window this index currently describes. */
  get bounds(): EventWindowBounds | null {
    return this.#bounds;
  }
  /** How many events are held, for benchmarks and for tests that assert an input stayed bounded. */
  get size(): number {
    return this.#byKey.size;
  }
  /** True when unknown-time events are held without a boundary that could ever release them. */
  get windowContextIncomplete(): boolean {
    return this.#contextIncomplete;
  }
  /** The pools that currently hold at least one windowed event. */
  pools(): ReadonlySet<string> {
    return new Set(this.#keysByPool.keys());
  }
  /**
   * The pools whose last windowed event left in this round's expirations. They still owe one
   * evaluation: being carried here is what turns "its events are gone" into a cooling result
   * instead of a pool that silently stops being watched.
   */
  get recentlyExpired(): ReadonlySet<string> {
    return this.#recentlyExpired;
  }
  /**
   * Bumped every time the window is derived from the rows again. A round that sees it change is
   * looking at a window the previous round did not have, and may not assume the previous round's
   * evaluation survived.
   */
  get generation(): number {
    return this.#generation;
  }

  /**
   * Name the cursor token the enclosing transaction is writing. Called after the projection stores
   * its cursor, so a later round can tell from the cursor alone whether this round committed.
   */
  mark(token: string): void {
    this.#token = token;
  }

  /** Drop the in-memory window and derive it again from the rows that survive. */
  reload(bounds: EventWindowBounds = this.#bounds ?? UNBOUNDED): void {
    this.#byKey.clear();
    this.#keysByPool.clear();
    this.#poolsByToken.clear();
    this.#tokenRefs.clear();
    this.#bounds = bounds;
    this.#loaded = true;
    this.#generation += 1;
    const sinceBlock = bounds.sinceBlock === null ? null : Number(bounds.sinceBlock);
    const rows = this.db
      .prepare(WINDOW_ROWS)
      .all(this.scopeId, bounds.sinceSec, sinceBlock, sinceBlock) as { payload_json: string }[];
    countWork('liveEventRowsRead', rows.length);
    for (const row of rows) {
      const event = reviveEvent(JSON.parse(row.payload_json) as PoolEvent);
      this.install(rawLogKey(event.ref), event);
    }
    this.#token = this.cursorToken();
    this.#contextIncomplete = this.contextIncomplete(bounds);
  }

  apply(delta: EventDelta): void {
    this.ensureCurrent();
    // A delta is the start of a round, and a round expires against the window it ends with: what
    // the previous round's expiry carried has either been evaluated by now or belongs to a round
    // that never committed.
    this.#recentlyExpired = new Set<string>();
    // A removal is taken by key, so a revision that moved an event to another pool or another
    // token retires the contribution it made before rather than leaving it behind.
    for (const key of delta.deletedKeys) this.remove(key);
    for (const event of delta.upserts) {
      const key = rawLogKey(event.ref);
      if (!insideWindow(event, this.#bounds)) this.remove(key);
      else this.install(key, event);
    }
  }

  eventsFor(poolIds: ReadonlySet<string>): readonly PoolEvent[] {
    this.ensureLoaded();
    this.ensureCurrent();
    const events: PoolEvent[] = [];
    for (const poolId of poolIds) {
      const keys = this.#keysByPool.get(poolId);
      if (keys === undefined) continue;
      for (const key of keys) events.push(this.#byKey.get(key)!.event);
    }
    return events.sort((left, right) => comparePosition(left.ref, right.ref));
  }

  poolsForToken(address: string): ReadonlySet<string> {
    this.ensureLoaded();
    this.ensureCurrent();
    const pools = this.#poolsByToken.get(address.toLowerCase());
    return pools === undefined ? EMPTY : new Set(pools);
  }

  /**
   * Apply a window bound and report the pools whose last windowed event left with it. Each of them
   * still owes one evaluation — a pool does not cool by being forgotten — and only a caller that
   * has confirmed it has no window input, no signal memory and no revision left may drop it.
   */
  expire(bounds: EventWindowBounds): ReadonlySet<string> {
    const first = !this.#loaded;
    this.ensureLoaded(bounds);
    this.ensureCurrent();
    this.#bounds = bounds;
    if (first) return EMPTY;
    const expired = new Set<string>();
    const carried = new Set(this.#recentlyExpired);
    // The window is bounded and this list holds only its keys, so the copy is the size of the
    // window, never of the scope's history.
    for (const key of [...this.#byKey.keys()]) {
      const entry = this.#byKey.get(key)!;
      if (insideWindow(entry.event, bounds)) continue;
      const poolId = entry.poolId;
      this.remove(key);
      if (poolId !== null && !this.#keysByPool.has(poolId)) expired.add(poolId);
    }
    this.#contextIncomplete = this.contextIncomplete(bounds);
    // Union rather than replace: a round that reads its window twice must not lose the pools the
    // first read expired, and an extra carried pool only ever costs one more evaluation.
    this.#recentlyExpired = new Set([...carried, ...expired]);
    return expired;
  }

  private install(key: string, event: PoolEvent): void {
    const previous = this.#byKey.get(key);
    if (previous !== undefined) this.unlink(key, previous);
    const poolId = event.pool ? poolRegistrationId({ pool: event.pool }) : null;
    this.#byKey.set(key, { poolId, event });
    if (poolId === null) return;
    const keys = this.#keysByPool.get(poolId) ?? new Set<string>();
    keys.add(key);
    this.#keysByPool.set(poolId, keys);
    for (const token of tokensOf(event)) this.refToken(token, poolId);
  }

  private remove(key: string): void {
    const entry = this.#byKey.get(key);
    if (entry !== undefined) this.unlink(key, entry);
  }

  private unlink(key: string, entry: Indexed): void {
    this.#byKey.delete(key);
    const poolId = entry.poolId;
    if (poolId === null) return;
    const keys = this.#keysByPool.get(poolId);
    if (keys !== undefined) {
      keys.delete(key);
      if (keys.size === 0) this.#keysByPool.delete(poolId);
    }
    for (const token of tokensOf(entry.event)) this.unrefToken(token, poolId);
  }

  private refToken(token: string, poolId: string): void {
    const refs = this.#tokenRefs.get(token) ?? new Map<string, number>();
    const count = (refs.get(poolId) ?? 0) + 1;
    refs.set(poolId, count);
    this.#tokenRefs.set(token, refs);
    if (count > 1) return;
    const pools = this.#poolsByToken.get(token) ?? new Set<string>();
    pools.add(poolId);
    this.#poolsByToken.set(token, pools);
  }

  private unrefToken(token: string, poolId: string): void {
    const refs = this.#tokenRefs.get(token);
    if (refs === undefined) return;
    const count = (refs.get(poolId) ?? 0) - 1;
    if (count > 0) {
      refs.set(poolId, count);
      return;
    }
    refs.delete(poolId);
    if (refs.size === 0) this.#tokenRefs.delete(token);
    const pools = this.#poolsByToken.get(token);
    if (pools === undefined) return;
    pools.delete(poolId);
    if (pools.size === 0) this.#poolsByToken.delete(token);
  }

  private ensureLoaded(bounds: EventWindowBounds = this.#bounds ?? UNBOUNDED): void {
    if (!this.#loaded) this.reload(bounds);
  }

  /**
   * Confirm this window still describes the rows the scope has, and derive it again when it does
   * not. An index that was never marked is left alone: no round has claimed it yet.
   */
  private ensureCurrent(): void {
    if (!this.#loaded || this.#token === null) return;
    if (this.cursorToken() === this.#token) return;
    this.reload();
  }

  private cursorToken(): string | null {
    const row = this.db
      .prepare('select source_hash from live_projection_cursors where scope_id=?')
      .pluck()
      .get(this.scopeId);
    return row === undefined ? null : (row as string);
  }

  /** Whether a boundary is missing while unknown-time events are held, exactly as `read` reports it. */
  private contextIncomplete(bounds: EventWindowBounds): boolean {
    if (bounds.sinceSec <= 0 || bounds.sinceBlock !== null) return false;
    return Boolean(
      this.db
        .prepare('select 1 from live_events where scope_id=? and minute_start_sec is null limit 1')
        .get(this.scopeId),
    );
  }
}

const sharedIndexes = new WeakMap<Database.Database, Map<string, LiveEventIndexStore>>();

/**
 * The event index one scope of one database is evaluated through. Two stores over the same database
 * share it, so a round that advanced it is the round the next reader sees. A read-only database
 * keeps its own `read` path and never reaches here.
 */
export function eventIndexFor(db: Database.Database, scopeId: string): LiveEventIndexStore {
  let byScope = sharedIndexes.get(db);
  if (!byScope) {
    byScope = new Map();
    sharedIndexes.set(db, byScope);
  }
  let index = byScope.get(scopeId);
  if (!index) {
    index = new LiveEventIndexStore(db, scopeId);
    byScope.set(scopeId, index);
  }
  return index;
}
