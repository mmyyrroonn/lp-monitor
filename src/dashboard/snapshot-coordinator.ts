import { Worker } from 'node:worker_threads';
import type { MetricMetadata } from '../metrics/metadata.js';
import type { AssetRegistration } from '../registry/assets.js';
import { SnapshotExpiredError } from './read-model.js';
import { snapshotFreshness, unavailableHealth } from './snapshot.js';
import type { DashboardSummary, PoolPage, TokenHistory, WindowName } from './types.js';

/** How often the live summary is asked whether anything moved. */
export const SNAPSHOT_REFRESH_INTERVAL_MS = 5000;
/** How long one ordinary round may take before the worker is treated as stuck. */
export const SNAPSHOT_REFRESH_TIMEOUT_MS = 10000;
/** The first round also starts the worker and reads the catalogue, so it gets its own budget. */
export const SNAPSHOT_INIT_TIMEOUT_MS = 60000;
/** How long a page or a history may wait for the worker before the caller is told to retry. */
export const SNAPSHOT_DETAIL_TIMEOUT_MS = 2000;
/** How many detail requests may be outstanding at once. */
export const SNAPSHOT_DETAIL_CONCURRENCY = 8;
/** The shortest gap between two automatic worker restarts, so a crash loop cannot spin. */
export const SNAPSHOT_RESTART_COOLDOWN_MS = 30000;
/**
 * How long a reader that has never published anything may keep failing before the page stops saying
 * it is generating its first snapshot and states the fault instead. Longer than one restart cooldown
 * plus a round, so a reader that recovers by being restarted is never reported as broken.
 */
export const SNAPSHOT_FAULT_VISIBILITY_MS = 45000;

/** A detail request that could not be served in time and is safe to retry. */
export class SnapshotBusyError extends Error {
  readonly code = 'SNAPSHOT_BUSY';
  constructor(message = 'Snapshot is refreshing') {
    super(message);
    this.name = 'SnapshotBusyError';
  }
}

/** The reader has no worker to answer with: closed, not started, or failed to start. */
export class SnapshotUnavailableError extends Error {
  readonly code = 'SNAPSHOT_UNAVAILABLE';
  constructor(message = 'Snapshot is unavailable') {
    super(message);
    this.name = 'SnapshotUnavailableError';
  }
}

/** The subset of a worker thread this coordinator needs, so a test can hand it its own. */
export type SnapshotWorkerLike = {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (value: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): unknown;
};

export type SnapshotWorkerFactory = () => SnapshotWorkerLike;

/**
 * The reader a dashboard gets when its caller does not supply one.
 *
 * The built artifact is plain JavaScript sitting beside this module, and Node resolves it unaided.
 * The source tree is TypeScript, which a worker thread cannot read on its own, so the source entry
 * is paired with a loader module the worker imports for itself. Both spellings name the same module;
 * which one this is follows from how this file itself was loaded, never from a flag a caller sets.
 */
function defaultWorkerFactory(): SnapshotWorkerLike {
  const source = import.meta.url.endsWith('.ts'),
    entry = new URL(source ? './snapshot-worker.ts' : './snapshot-worker.js', import.meta.url);
  return new Worker(
    entry,
    source
      ? { execArgv: ['--import', new URL('./worker-loader.mjs', import.meta.url).href] }
      : undefined,
  ) as unknown as SnapshotWorkerLike;
}

/** Everything the coordinator needs to start a reader, all of it JSON-safe. */
export type SnapshotCoordinatorOptions = {
  dbPath: string;
  scopeId: string;
  registryScopeId: string;
  configVersion: string;
  assetVersion: string;
  assets: readonly AssetRegistration[];
  usdg: string;
  metadata: MetricMetadata;
  workerFactory?: SnapshotWorkerFactory;
  refreshIntervalMs?: number;
  refreshTimeoutMs?: number;
  initTimeoutMs?: number;
  detailTimeoutMs?: number;
  detailConcurrency?: number;
  restartCooldownMs?: number;
  now?: () => number;
};

/** The published summaries a page can ask for, and the reader that produces them. */
export interface SnapshotCoordinator {
  latest(at?: number): DashboardSummary;
  refresh(at?: number): void;
  pools(query: {
    generation: string;
    address: string;
    window: WindowName;
    offset: number;
    limit: number;
  }): Promise<PoolPage>;
  history(query: { generation: string; address: string }): Promise<TokenHistory>;
  close(): Promise<void>;
}

type WorkerReply = {
  type: string;
  id?: number;
  key?: string;
  code?: string;
  summary?: DashboardSummary;
  page?: PoolPage;
  history?: TokenHistory;
};

type PendingDetail = {
  generation: string;
  pick: (reply: WorkerReply) => unknown;
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type Job = { key: string; at: number | undefined; timer: NodeJS.Timeout | null };

type Resolved = Required<Omit<SnapshotCoordinatorOptions, 'workerFactory' | 'now'>> & {
  workerFactory: SnapshotWorkerFactory;
  now: () => number;
};

const LIVE_KEY = 'live';

function unref(timer: NodeJS.Timeout): NodeJS.Timeout {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/**
 * The dashboard's one reader: a worker that computes, and a main thread that only remembers.
 *
 * `latest` answers from a plain object this process already holds — no worker call, no database, and
 * no arithmetic beyond comparing the watermark with the wall clock. `refresh` says "a newer
 * generation would be welcome" and returns; at most one round is ever in flight, a backlog collapses
 * to the newest live request plus one explicit historical one, and a round whose source has not moved
 * is answered by the worker without recomputing anything.
 *
 * A worker that hangs is a fault this side recovers from rather than a request that waits: the
 * watchdog keeps the summary it already published, drops every waiting detail request with a
 * retryable error and restarts the reader — but never more often than the cooldown allows, so a
 * database that cannot be read at all does not become a restart loop.
 */
export class SnapshotCoordinatorImpl implements SnapshotCoordinator {
  readonly #options: Resolved;
  /** Only finished summaries. Nothing that needs the worker is stored here. */
  readonly #summaries = new Map<string, DashboardSummary>();
  /** Why one historical cutoff could not be produced, so `latest(at)` can say so instead of waiting. */
  readonly #historyFaults = new Map<number, string>();
  readonly #details = new Map<number, PendingDetail>();
  readonly #detailKeys = new Map<number, string>();
  readonly #detailPromises = new Map<string, Promise<unknown>>();
  #worker: SnapshotWorkerLike | null = null;
  #ready = false;
  #closed = false;
  #fatal: 'empty' | 'error' | null = null;
  #fault: string | null = null;
  /** When the current run of faults began. Only the pair with `#fault` separates transient from fatal. */
  #faultSinceMs: number | null = null;
  #job: Job | null = null;
  #pendingLive = false;
  #pendingHistory: { at: number } | null = null;
  #lastRanHistory = false;
  #nextDetailId = 1;
  #interval: NodeJS.Timeout | null = null;
  #initTimer: NodeJS.Timeout | null = null;
  #restartTimer: NodeJS.Timeout | null = null;
  #lastStartAt: number;

  constructor(options: SnapshotCoordinatorOptions) {
    this.#options = {
      ...options,
      workerFactory: options.workerFactory ?? defaultWorkerFactory,
      refreshIntervalMs: options.refreshIntervalMs ?? SNAPSHOT_REFRESH_INTERVAL_MS,
      refreshTimeoutMs: options.refreshTimeoutMs ?? SNAPSHOT_REFRESH_TIMEOUT_MS,
      initTimeoutMs: options.initTimeoutMs ?? SNAPSHOT_INIT_TIMEOUT_MS,
      detailTimeoutMs: options.detailTimeoutMs ?? SNAPSHOT_DETAIL_TIMEOUT_MS,
      detailConcurrency: options.detailConcurrency ?? SNAPSHOT_DETAIL_CONCURRENCY,
      restartCooldownMs: options.restartCooldownMs ?? SNAPSHOT_RESTART_COOLDOWN_MS,
      now: options.now ?? Date.now,
    };
    this.#lastStartAt = this.#options.now();
    this.#start();
    this.#interval = unref(setInterval(() => this.refresh(), this.#options.refreshIntervalMs));
  }

  latest(at?: number): DashboardSummary {
    if (at === undefined) return this.#decorate(this.#summaries.get(LIVE_KEY) ?? null, undefined);
    const cached = this.#summaries.get(String(at));
    if (cached !== undefined) return this.#decorate(cached, at);
    const fault = this.#historyFaults.get(at);
    if (fault === undefined) return this.#decorate(null, at);
    return {
      ...this.#decorate(null, at),
      status: 'error',
      message: fault,
      refreshing: false,
    };
  }

  refresh(at?: number): void {
    if (this.#closed) return;
    if (at === undefined) this.#pendingLive = true;
    else this.#pendingHistory = { at };
    this.#pump();
  }

  pools(query: {
    generation: string;
    address: string;
    window: WindowName;
    offset: number;
    limit: number;
  }): Promise<PoolPage> {
    return this.#detail(
      ['page', query.generation, query.address, query.window, query.offset, query.limit].join('|'),
      (id) => ({ type: 'poolPage', id, ...query }),
      (reply) => reply.page!,
      query.generation,
    );
  }

  history(query: { generation: string; address: string }): Promise<TokenHistory> {
    return this.#detail(
      ['history', query.generation, query.address].join('|'),
      (id) => ({ type: 'tokenHistory', id, ...query }),
      (reply) => reply.history!,
      query.generation,
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#interval !== null) clearInterval(this.#interval);
    this.#interval = null;
    this.#clearTimers();
    this.#job = null;
    this.#pendingLive = false;
    this.#pendingHistory = null;
    this.#failDetails(new SnapshotUnavailableError('Snapshot reader is closed'));
    const worker = this.#worker;
    this.#worker = null;
    if (worker !== null) {
      worker.postMessage({ type: 'close' });
      await worker.terminate();
    }
  }

  /** One reader, started once and restarted only through the cooldown. */
  #start(): void {
    if (this.#closed) return;
    this.#lastStartAt = this.#options.now();
    let worker: SnapshotWorkerLike;
    try {
      worker = this.#options.workerFactory();
    } catch (error) {
      console.error('dashboard snapshot reader could not start:', error);
      this.#fault = 'SNAPSHOT_UNAVAILABLE';
      this.#faultSinceMs ??= this.#options.now();
      this.#scheduleRestart();
      return;
    }
    this.#worker = worker;
    this.#ready = false;
    worker.on('message', (value) => this.#onMessage(value as WorkerReply));
    worker.on('error', (error) => {
      // The thread's own failure is the only account of why it left, and it is not a stack the page
      // may ever be shown. Dropping it is what made this state undiagnosable: the page said it was
      // still generating its first snapshot, and nothing anywhere said otherwise.
      console.error('dashboard snapshot reader failed:', error);
      this.#onWorkerLost('SNAPSHOT_ERROR');
    });
    worker.on('exit', () => {
      if (!this.#closed && this.#worker === worker) this.#onWorkerLost('SNAPSHOT_ERROR');
    });
    worker.postMessage({
      type: 'init',
      init: {
        dbPath: this.#options.dbPath,
        scopeId: this.#options.scopeId,
        registryScopeId: this.#options.registryScopeId,
        configVersion: this.#options.configVersion,
        assetVersion: this.#options.assetVersion,
        assets: [...this.#options.assets],
        usdg: this.#options.usdg,
        metadata: this.#options.metadata,
      },
    });
    this.#initTimer = unref(
      setTimeout(() => {
        this.#initTimer = null;
        if (this.#ready || this.#closed) return;
        this.#fatal = 'error';
        this.#onWorkerLost('SNAPSHOT_UNAVAILABLE');
      }, this.#options.initTimeoutMs),
    );
  }

  #onMessage(reply: WorkerReply): void {
    if (reply.id !== undefined) {
      this.#settleDetail(reply);
      return;
    }
    switch (reply.type) {
      case 'ready':
        this.#clearInitTimer();
        this.#ready = true;
        this.#fatal = null;
        this.#fault = null;
        this.#faultSinceMs = null;
        // The first summary is not something a viewer should have to wait an interval for.
        this.#pendingLive = true;
        this.#pump();
        return;
      case 'summary':
        if (reply.key !== undefined && reply.summary !== undefined) {
          this.#summaries.set(reply.key, reply.summary);
          this.#historyFaults.delete(Number(reply.key));
          this.#finishJob(reply.key);
          this.#fault = null;
          this.#faultSinceMs = null;
          this.#pump();
        }
        return;
      case 'unchanged':
        if (reply.key !== undefined) {
          this.#finishJob(reply.key);
          this.#pump();
        }
        return;
      case 'failed':
        this.#onRoundFailed(reply.code ?? 'SNAPSHOT_ERROR');
        return;
      default:
        return;
    }
  }

  /**
   * A round the worker answered but could not produce: an unwarmed reader has to say why, a warm one
   * keeps the generation it already published. The worker itself is still alive and is kept.
   */
  #onRoundFailed(code: string): void {
    const unwarmed = !this.#ready;
    this.#clearInitTimer();
    if (unwarmed) this.#fatal = code === 'SNAPSHOT_NO_DATABASE' ? 'empty' : 'error';
    this.#fault = code;
    this.#faultSinceMs ??= this.#options.now();
    const job = this.#job;
    if (job !== null) {
      this.#job = null;
      if (job.timer !== null) clearTimeout(job.timer);
      if (job.at !== undefined) this.#historyFaults.set(job.at, reasonFor(code, true));
    }
    // A worker that never warmed up cannot warm up by being asked again; it is replaced instead.
    if (unwarmed) this.#onWorkerLost(code);
    else this.#pump();
  }

  /** The reader is gone or stuck: drop its work, keep what it already published, restart it later. */
  #onWorkerLost(code: string): void {
    if (this.#closed) return;
    this.#fault = this.#fault ?? code;
    this.#faultSinceMs ??= this.#options.now();
    this.#clearInitTimer();
    const worker = this.#worker;
    this.#worker = null;
    this.#ready = false;
    if (worker !== null) void worker.terminate();
    const job = this.#job;
    if (job !== null) {
      this.#job = null;
      if (job.timer !== null) clearTimeout(job.timer);
    }
    // In-flight details died with the worker. That is a transient state — the reader is being
    // replaced — so a caller that retries is told to, rather than told the feature is gone.
    this.#failDetails(new SnapshotBusyError('Snapshot reader is restarting'));
    this.#scheduleRestart();
  }

  #onJobTimeout(): void {
    const job = this.#job;
    if (job === null) return;
    this.#job = null;
    if (job.timer !== null) clearTimeout(job.timer);
    if (job.at === undefined) {
      this.#fault = 'SNAPSHOT_TIMEOUT';
      this.#faultSinceMs ??= this.#options.now();
    } else this.#historyFaults.set(job.at, reasonFor('SNAPSHOT_TIMEOUT', true));
    this.#onWorkerLost('SNAPSHOT_TIMEOUT');
  }

  #scheduleRestart(): void {
    if (this.#closed || this.#restartTimer !== null) return;
    const wait = Math.max(
      0,
      this.#options.restartCooldownMs - (this.#options.now() - this.#lastStartAt),
    );
    this.#restartTimer = unref(
      setTimeout(() => {
        this.#restartTimer = null;
        this.#start();
      }, wait),
    );
  }

  /** At most one round in flight, and a backlog that only ever holds two requests. */
  #pump(): void {
    if (this.#closed || this.#job !== null || !this.#ready || this.#worker === null) return;
    const live = this.#pendingLive,
      history = this.#pendingHistory,
      takeHistory = history !== null && (live ? this.#lastRanHistory : true);
    let at: number | undefined;
    if (takeHistory && history !== null) {
      at = history.at;
      this.#pendingHistory = null;
      this.#lastRanHistory = true;
    } else if (live) {
      this.#pendingLive = false;
      this.#lastRanHistory = false;
    } else return;
    const key = at === undefined ? LIVE_KEY : String(at),
      job: Job = { key, at, timer: null };
    this.#job = job;
    job.timer = unref(
      setTimeout(
        () => this.#onJobTimeout(),
        this.#summaries.has(LIVE_KEY)
          ? this.#options.refreshTimeoutMs
          : this.#options.initTimeoutMs,
      ),
    );
    this.#worker.postMessage(
      at === undefined ? { type: 'refresh', key } : { type: 'refresh', key, at },
    );
  }

  #finishJob(key: string): void {
    if (this.#job === null || this.#job.key !== key) return;
    if (this.#job.timer !== null) clearTimeout(this.#job.timer);
    this.#job = null;
  }

  #isRefreshing(at: number | undefined): boolean {
    if (at === undefined && !this.#summaries.has(LIVE_KEY)) return this.#fatal !== 'error';
    return (
      (at === undefined ? this.#pendingLive : this.#pendingHistory?.at === at) ||
      (this.#job !== null && this.#job.at === at)
    );
  }

  #decorate(summary: DashboardSummary | null, at: number | undefined): DashboardSummary {
    const value = summary === null ? this.#placeholder(at) : { ...summary };
    if (value.sourceChainTimeSec !== null) {
      // Freshness is a function of the wall clock, so it is answered here rather than frozen into
      // the generation: a reader that publishes nothing new must still go stale.
      const freshness = snapshotFreshness(value.sourceChainTimeSec, this.#options.now());
      if (freshness.status === 'stale') {
        value.status = 'stale';
        value.message = freshness.message;
      }
    }
    // A fault this side knows about is only worth reporting over data that exists; before that the
    // placeholder already says there is nothing yet. A historical cutoff never wears a live fault.
    if (at === undefined && this.#fault !== null && this.#summaries.has(LIVE_KEY)) {
      value.status = 'stale';
      value.message = reasonFor(this.#fault, false);
    }
    value.refreshing = this.#isRefreshing(at);
    return value;
  }

  /**
   * The honest answer before any generation exists: nothing is claimed about data not yet read.
   *
   * A reader that has never published anything and has been failing for longer than one restart is
   * not still generating its first snapshot — it is broken, and the fault is the whole answer. That
   * is the only way this state can ever be told apart from a slow first round: `#decorate` reports a
   * fault over published data, and here there is none to report it over. Below the budget the
   * placeholder stays what it was, because a restart may yet succeed and a page that cried wolf on
   * every transient would be worse than one that waits.
   */
  #placeholder(at?: number): DashboardSummary {
    const fatal = this.#fatal,
      since = this.#faultSinceMs;
    const failed =
      at === undefined &&
      fatal === null &&
      this.#fault !== null &&
      since !== null &&
      this.#options.now() - since >= SNAPSHOT_FAULT_VISIBILITY_MS;
    return {
      status: fatal === 'error' || failed ? 'error' : 'empty',
      generatedAtMs: this.#options.now(),
      sourceChainTimeSec: null,
      selectedEndSec: at ?? null,
      availableFromSec: null,
      sourceHash: null,
      scopeId: this.#options.scopeId,
      assetVersion: this.#options.assetVersion,
      tokens: [],
      coverage: [],
      health: unavailableHealth(),
      message:
        fatal === 'error'
          ? // The one fatal whose cause the page can name: the file was read, and what it is missing
            // is a fact about the file rather than a suspicion about the whole stack. Every other
            // fatal keeps the sentence that points at the database and the configuration together,
            // because for those the reader genuinely cannot tell which of them is at fault.
            this.#fault === 'SNAPSHOT_INCOMPATIBLE_DATABASE'
            ? reasonFor(this.#fault, false, false)
            : '无法读取本地数据；请检查数据库与配置版本。'
          : failed
            ? reasonFor(this.#fault!, false, false)
            : fatal === 'empty'
              ? '尚无本地数据库；请先运行已有的有界采集流程。'
              : at === undefined
                ? '正在生成首个快照'
                : '正在生成所选时点的快照',
      notes: [],
      apiVersion: 2,
      generation: null,
      refreshing: fatal !== 'error',
    };
  }

  #detail<T>(
    key: string,
    build: (id: number) => unknown,
    pick: (reply: WorkerReply) => T,
    generation: string,
  ): Promise<T> {
    const held = this.#detailPromises.get(key);
    if (held !== undefined) return held as Promise<T>;
    if (this.#closed)
      return Promise.reject(new SnapshotUnavailableError('Snapshot reader is closed'));
    if (this.#worker === null || !this.#ready)
      return Promise.reject(new SnapshotUnavailableError('Snapshot reader is not ready'));
    if (this.#details.size >= this.#options.detailConcurrency)
      return Promise.reject(new SnapshotBusyError());
    const worker = this.#worker;
    const promise = new Promise<T>((resolve, reject) => {
      const id = this.#nextDetailId++;
      const timer = unref(
        setTimeout(() => {
          this.#forgetDetail(id);
          reject(new SnapshotBusyError());
        }, this.#options.detailTimeoutMs),
      );
      this.#details.set(id, {
        generation,
        pick: pick as (reply: WorkerReply) => unknown,
        resolve: resolve as (value: never) => void,
        reject,
        timer,
      });
      this.#detailKeys.set(id, key);
      worker.postMessage(build(id));
    });
    // A caller that walks away must not turn into an unhandled rejection; the promise it holds
    // still rejects exactly as it would have.
    promise.catch(() => undefined);
    this.#detailPromises.set(key, promise as Promise<unknown>);
    return promise;
  }

  #settleDetail(reply: WorkerReply): void {
    const id = reply.id!,
      pending = this.#details.get(id);
    if (pending === undefined) return;
    this.#forgetDetail(id);
    if (reply.type === 'expired') {
      pending.reject(new SnapshotExpiredError(pending.generation));
      return;
    }
    if (reply.type === 'failed') {
      pending.reject(
        reply.code === 'SNAPSHOT_BAD_REQUEST'
          ? new RangeError('Invalid snapshot detail request')
          : new SnapshotUnavailableError(
              reply.code === 'SNAPSHOT_UNAVAILABLE'
                ? 'Snapshot reader is not ready'
                : 'Snapshot detail request failed',
            ),
      );
      return;
    }
    pending.resolve(pending.pick(reply) as never);
  }

  #forgetDetail(id: number): void {
    const pending = this.#details.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#details.delete(id);
    const key = this.#detailKeys.get(id);
    if (key !== undefined) {
      this.#detailKeys.delete(id);
      this.#detailPromises.delete(key);
    }
  }

  #failDetails(error: Error): void {
    for (const id of [...this.#details.keys()]) {
      const pending = this.#details.get(id)!;
      this.#forgetDetail(id);
      pending.reject(error);
    }
  }

  #clearInitTimer(): void {
    if (this.#initTimer !== null) clearTimeout(this.#initTimer);
    this.#initTimer = null;
  }

  #clearTimers(): void {
    this.#clearInitTimer();
    if (this.#restartTimer !== null) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
  }
}

/** A short, non-leaking reason: no SQL, no path and no configuration value reaches a page. */
function reasonFor(code: string, historical: boolean, warm = true): string {
  if (code === 'SNAPSHOT_TIMEOUT')
    return warm ? '快照刷新超时，正在显示上一次结果。' : '快照刷新超时，尚未生成任何结果。';
  if (code === 'SNAPSHOT_NO_DATABASE') return '尚无本地数据库；请先运行已有的有界采集流程。';
  // Asked before the historical fallback: a file without the projection cannot answer for a past
  // moment either, and "temporarily" would be the wrong word for a property of the file itself.
  if (code === 'SNAPSHOT_INCOMPATIBLE_DATABASE')
    return '本地数据库缺少实时投影表；请指向 recorder 正在写入的数据库。';
  if (historical) return '所选时点的快照暂时无法生成。';
  // "keeping the last result" is a promise only a reader that has one can make.
  return warm
    ? '实时数据暂时不可用，正在显示上一次结果。'
    : '实时数据暂时不可用，尚未生成任何结果。';
}

/** The coordinator a server holds: one reader, one interval, one place to close. */
export function createSnapshotCoordinator(
  options: SnapshotCoordinatorOptions,
): SnapshotCoordinator {
  return new SnapshotCoordinatorImpl(options);
}
