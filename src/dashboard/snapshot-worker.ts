import { existsSync } from 'node:fs';
import { isMainThread, parentPort } from 'node:worker_threads';
import type Database from 'better-sqlite3';
import type { Address } from 'viem';
import { encodeJson } from '../domain/json.js';
import type { PoolEvent } from '../domain/types.js';
import type { MetricMetadata } from '../metrics/metadata.js';
import { eventRevision } from '../metrics/valuation-index.js';
import { buildAssetRegistry, type AssetRegistration } from '../registry/assets.js';
import {
  PoolRegistry,
  poolRegistrationId,
  registrationsEqual,
  type PoolRegistration,
} from '../registry/pools.js';
import { openDatabase } from '../storage/database.js';
import { eventIndexFor, type LiveEventIndexStore } from '../storage/live-event-index.js';
import { LiveProjectionStore } from '../storage/live-projection.js';
import { rawLogKey } from '../storage/manifest.js';
import { liveWindowEnd } from '../metrics/rolling.js';
import { metadataJournalPresent, metadataRevision } from '../storage/metadata-queue.js';
import {
  buildMetricsReport,
  StaleMetricProjectionError,
  type MetricInput,
  type MetricsReport,
} from '../storage/metric-store.js';
import { SqliteRangeStore } from '../storage/raw-store.js';
import {
  registryCacheFor,
  type RegistryCache,
  type RegistryView,
} from '../storage/registry-cache.js';
import {
  registryChangesAfter,
  registryJournalAvailable,
  type RegistryChange,
} from '../storage/registry-changes.js';
import {
  DashboardReadModel,
  SnapshotExpiredError,
  type GenerationInput,
  type RegistryDeltaRow,
} from './read-model.js';
import { runtimeHealth, snapshotFreshness, SNAPSHOT_NOTES, unavailableHealth } from './snapshot.js';
import type { DashboardSummary, PoolPage, TokenHistory, WindowName } from './types.js';

/** The bounded hot window every round reads, in minutes: the horizon the legacy path keeps. */
export const SNAPSHOT_HISTORY_MINUTES = 180;
/** The two minutes of margin the windowed read keeps below the horizon, exactly as metric-store does. */
const READ_MARGIN_SEC = 120;
/**
 * What metric-store prefixes the footnotes of a bounded report with. Those footnotes describe the
 * round that produced them, and the summary published here reports the whole catalogue: keeping them
 * would have the page state a scope that is not the one it is answering for.
 */
const SELECTED_REPORT_NOTE = 'Selected-pool report: ';
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/** Everything the worker needs to rebuild its own registries, all of it JSON-safe. */
export type SnapshotWorkerInit = {
  dbPath: string;
  scopeId: string;
  registryScopeId: string;
  configVersion: string;
  assetVersion: string;
  assets: readonly AssetRegistration[];
  usdg: string;
  metadata: MetricMetadata;
};

export type SnapshotWorkerRequest =
  | { type: 'init'; init: SnapshotWorkerInit }
  | { type: 'refresh'; key: string; at?: number }
  | {
      type: 'poolPage';
      id: number;
      generation: string;
      address: string;
      window: WindowName;
      offset: number;
      limit: number;
    }
  | { type: 'tokenHistory'; id: number; generation: string; address: string }
  | { type: 'close' };

/**
 * A failure the worker is willing to name. Never a message: an SQL string, a filesystem path or a
 * configuration value may not travel to the page, so the code is the whole report.
 */
export type SnapshotWorkerFailure =
  | 'SNAPSHOT_NO_DATABASE'
  | 'SNAPSHOT_UNAVAILABLE'
  | 'SNAPSHOT_BAD_REQUEST'
  | 'SNAPSHOT_INCOMPATIBLE_DATABASE'
  | 'SNAPSHOT_ERROR';

export type SnapshotWorkerResponse =
  | { type: 'ready'; scopeId: string }
  | { type: 'summary'; key: string; summary: DashboardSummary }
  | { type: 'unchanged'; key: string }
  | { type: 'page'; id: number; page: PoolPage }
  | { type: 'history'; id: number; history: TokenHistory }
  | { type: 'expired'; id: number }
  | { type: 'failed'; id?: number; code: SnapshotWorkerFailure };

export type SnapshotWorkerPort = { postMessage(value: unknown): void };

/** What one round read, ready to be folded into the read model once the reads are committed. */
type RoundOutcome = {
  token: string;
  unchanged: boolean;
  rows: RegistryDeltaRow[];
  position: number;
  catalogue: Map<string, PoolRegistration> | null;
  summary: DashboardSummary | null;
  report?: MetricsReport;
  revisions?: Map<string, string>;
  at?: number;
};

/** The revision an event contributes: swaps use the valuation index's own, others their content. */
function revisionOf(event: PoolEvent): string {
  return event.kind === 'swap' ? eventRevision(event) : encodeJson(event);
}

function emptySummary(
  input: Pick<MetricInput, 'scopeId' | 'assets'>,
  message: string,
  options: { nowMs: number; selectedEndSec: number | null },
): DashboardSummary {
  return {
    status: 'empty',
    generatedAtMs: options.nowMs,
    sourceChainTimeSec: null,
    selectedEndSec: options.selectedEndSec,
    availableFromSec: null,
    sourceHash: null,
    scopeId: input.scopeId,
    assetVersion: input.assets.version,
    tokens: [],
    coverage: [],
    health: unavailableHealth(),
    message,
    notes: [],
    apiVersion: 2,
    generation: null,
    refreshing: false,
  };
}

/** A RangeError is the caller's own input; a missing projection is this reader's own state. */
function classify(error: unknown): SnapshotWorkerFailure {
  if (error instanceof RangeError) return 'SNAPSHOT_BAD_REQUEST';
  if (error instanceof StaleMetricProjectionError) return 'SNAPSHOT_UNAVAILABLE';
  return 'SNAPSHOT_ERROR';
}

function hasTable(db: Database.Database, name: string): boolean {
  return (
    db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name) !== undefined
  );
}

/**
 * The two statements every round compiles before it can decide anything.
 *
 * They are named once so that the probe below cannot come to describe a different dependency than
 * the one `#sourceToken` has. Unlike `live_source_revisions`, which a round can do without and which
 * is therefore behind a capability flag, these have no flag because no round is answerable without
 * them — a check that guessed at the schema instead would be free to reject a file the reader could
 * actually have read.
 */
const SOURCE_TOKEN_SQL = {
  cursor: 'select source_hash from live_projection_cursors where scope_id=?',
  high: 'select max(raw_log_id) as id from live_events where scope_id=?',
} as const;

/**
 * Compile — never run — what a round's change detection starts with, so a file that cannot answer
 * says so before it is asked.
 *
 * Preparing a statement is where its table names are resolved, so a database missing either table
 * throws here with exactly the error `#sourceToken` would have thrown from inside the round. That is
 * the whole licence for this check: it reads nothing, and a file that compiles both statements is a
 * file whose rounds go on to work. It can only move a failure that was already certain to happen.
 */
function probeSourceToken(db: Database.Database): void {
  db.prepare(SOURCE_TOKEN_SQL.cursor);
  db.prepare(SOURCE_TOKEN_SQL.high);
}

/**
 * The dashboard read model, on its own thread, behind one read-only connection.
 *
 * The catalogue is read exactly once and then advanced by the registry journal, so a round pays for
 * the pools that moved rather than for the eighty thousand that did not. What a round evaluates is
 * the window's own pool set — derived by expiring the in-memory event index to the read window —
 * and never the catalogue again: `report.rwa[].poolIds` answers about the pools a round selected,
 * which is a strictly smaller question than "which pools does this stock own", so it may not be
 * mistaken for the catalogue.
 *
 * Nothing here writes. The connection is opened read-only, the projection is never synced, and a
 * projection that is missing or stale is reported as such rather than repaired in place.
 */
export class SnapshotWorker {
  #db: Database.Database | null = null;
  #dbPath = '';
  #input: MetricInput | null = null;
  #raw: SqliteRangeStore | null = null;
  #index: LiveEventIndexStore | null = null;
  #live: LiveProjectionStore | null = null;
  #cache: RegistryCache | null = null;
  #model: DashboardReadModel | null = null;
  #journal = false;
  #sourceRevisions = false;
  /**
   * Whether this file carries the durable metadata journal. Only the capability is settled here; the
   * revision itself is read fresh on every round, for the reason `#metadataRevision` gives.
   */
  #metadataJournal = false;
  /** Journal position already folded into the read model, or a catalogue counter without one. */
  #registryPosition = 0;
  #catalogue = new Map<string, PoolRegistration>();
  /** Published token per request key; a key whose token is unchanged is not recomputed. */
  readonly #tokens = new Map<string, string>();
  /** Last round's event revisions, committed only once a round has published. */
  #eventRevisions = new Map<string, string>();
  #closed = false;

  constructor(private readonly port: SnapshotWorkerPort) {}

  /** One message in, at most one message out. A throw here would end the thread, so none escapes. */
  handle(message: SnapshotWorkerRequest): void {
    try {
      switch (message.type) {
        case 'init':
          this.#init(message.init);
          return;
        case 'refresh':
          this.#refresh(message.key, message.at);
          return;
        case 'poolPage':
          this.#page(message);
          return;
        case 'tokenHistory':
          this.#history(message.id, message.generation, message.address);
          return;
        case 'close':
          this.close();
          return;
      }
    } catch (error) {
      this.#fail('id' in message ? message.id : undefined, classify(error));
    }
  }

  close(): void {
    this.#closed = true;
    this.#db?.close();
    this.#db = null;
    this.#model = null;
    this.#input = null;
    this.#index = null;
    this.#live = null;
    this.#cache = null;
    this.#raw = null;
    this.#eventRevisions = new Map();
  }

  #init(init: SnapshotWorkerInit): void {
    if (this.#db !== null) {
      this.#fail(undefined, 'SNAPSHOT_BAD_REQUEST');
      return;
    }
    if (!existsSync(init.dbPath)) {
      this.#fail(undefined, 'SNAPSHOT_NO_DATABASE');
      return;
    }
    let db: Database.Database;
    try {
      db = openDatabase(init.dbPath, { readonly: true });
    } catch {
      this.#fail(undefined, 'SNAPSHOT_UNAVAILABLE');
      return;
    }
    // The file is open and its shape is the one thing that can be settled before any work is done:
    // a database predating the live projection answers no round, and would otherwise spend every
    // round failing on its first read while the page reported it as still generating a first one.
    try {
      probeSourceToken(db);
    } catch {
      db.close();
      this.#fail(undefined, 'SNAPSHOT_INCOMPATIBLE_DATABASE');
      return;
    }
    try {
      const input: MetricInput = {
        scopeId: init.scopeId,
        registryScopeId: init.registryScopeId,
        configVersion: init.configVersion,
        assets: buildAssetRegistry(init.assetVersion, init.assets),
        usdg: init.usdg as Address,
        metadata: init.metadata,
      };
      const raw = new SqliteRangeStore(db);
      // Rows and the consumed journal position must describe one SQLite snapshot. A writer
      // committing during startup is either in both, or remains for the first refresh to consume.
      const { catalogue, journal, position } = db.transaction(() => {
        const catalogue = new PoolRegistry([
          ...raw.pools(input.registryScopeId),
          ...raw.pools(input.scopeId),
        ]).snapshot();
        const journal = registryJournalAvailable(db);
        return { catalogue, journal, position: journal ? this.#journalPosition(db, input) : 0 };
      })();
      const model = new DashboardReadModel();
      model.loadRegistry(catalogue);
      this.#db = db;
      this.#dbPath = init.dbPath;
      this.#input = input;
      this.#raw = raw;
      this.#index = eventIndexFor(db, input.scopeId);
      this.#live = new LiveProjectionStore(db);
      this.#cache = registryCacheFor(db, input.registryScopeId, input.scopeId);
      this.#model = model;
      this.#journal = journal;
      this.#sourceRevisions = hasTable(db, 'live_source_revisions');
      this.#metadataJournal = metadataJournalPresent(db);
      this.#catalogue = new Map(catalogue.map((row) => [poolRegistrationId(row), row]));
      this.#registryPosition = position;
      this.port.postMessage({ type: 'ready', scopeId: input.scopeId });
    } catch {
      db.close();
      this.#fail(undefined, 'SNAPSHOT_UNAVAILABLE');
    }
  }

  #refresh(key: string, at: number | undefined): void {
    const db = this.#db,
      input = this.#input,
      model = this.#model;
    if (db === null || input === null || model === null || this.#closed) {
      this.#fail(undefined, 'SNAPSHOT_UNAVAILABLE');
      return;
    }
    // The cheap question first, outside any transaction: did anything the summary reads move at
    // all? A round that answers no costs a handful of indexed maxima and nothing else.
    if (this.#tokens.get(key) === this.#sourceToken()) {
      this.port.postMessage({ type: 'unchanged', key });
      return;
    }
    const outcome = db.transaction((): RoundOutcome => {
      // Asked again inside the read snapshot: the answer that decides the round has to belong to
      // the rows this round reads, not to the rows of a moment ago.
      const token = this.#sourceToken();
      if (this.#tokens.get(key) === token)
        return {
          token,
          unchanged: true,
          rows: [],
          position: this.#registryPosition,
          catalogue: null,
          summary: null,
        };
      const tip = this.#raw!.acceptedTip(input.scopeId);
      if (tip === null)
        return {
          token,
          unchanged: false,
          rows: [],
          position: this.#registryPosition,
          catalogue: null,
          summary: emptySummary(input, '当前范围没有已接受的链上数据。', {
            nowMs: Date.now(),
            selectedEndSec: at ?? null,
          }),
        };
      // Every read below happens inside this one transaction, so the token, the catalogue move and
      // the bounded events all describe the same rows: a generation is never spliced together from
      // two different snapshots of the database.
      const registryView = this.#cache!.prepare().view;
      const registry = this.#registryRows(registryView);
      const sinceSec = Math.floor(tip.timestampSec / 60) * 60 - SNAPSHOT_HISTORY_MINUTES * 60;
      const selected = this.#windowPools(sinceSec);
      const delta = this.#eventDelta();
      const report = buildMetricsReport(db, input, {
        live: {
          historyMinutes: SNAPSHOT_HISTORY_MINUTES,
          poolIds: selected,
          registry: registryView,
          eventIndex: this.#index!,
          // The shape a sync hands back, filled in for the one field the build reads. Nothing was
          // synced here, so there is no repair, no touched pool list and no registry evidence.
          changes: {
            repairFrom: null,
            affectedPoolIds: [],
            registryInitialization: false,
            eventDelta: { upserts: delta.upserts, deletedKeys: delta.deletedKeys },
          },
        },
        includeAssetValuations: true,
      });
      return {
        token,
        unchanged: false,
        ...registry,
        summary: null,
        report,
        revisions: delta.revisions,
        at,
      };
    })();
    if (outcome.unchanged) {
      this.port.postMessage({ type: 'unchanged', key });
      return;
    }
    // The read model only moves once the round's reads committed to a token: a delta folded in for
    // a round that then failed would be a catalogue move no round ever reported.
    model.applyRegistryDelta(outcome.rows);
    this.#registryPosition = outcome.position;
    if (outcome.catalogue !== null) this.#catalogue = outcome.catalogue;
    else
      for (const row of outcome.rows) {
        if (row.before !== null) this.#catalogue.delete(poolRegistrationId(row.before));
        if (row.after !== null) this.#catalogue.set(poolRegistrationId(row.after), row.after);
      }
    const summary = outcome.summary ?? this.#publish(outcome.report!, input, outcome.at);
    this.#tokens.set(key, outcome.token);
    if (outcome.revisions !== undefined) this.#eventRevisions = outcome.revisions;
    this.port.postMessage({ type: 'summary', key, summary });
  }

  /** Publish the round's report as this reader's newest generation. */
  #publish(report: MetricsReport, input: MetricInput, at: number | undefined): DashboardSummary {
    const watermark = report.at.timestampSec,
      availableFromSec = Math.max(
        0,
        Math.floor(watermark / 60) * 60 - SNAPSHOT_HISTORY_MINUTES * 60,
        report.coverage.find((row) => row.fromBlock !== null)?.minuteStartSec ?? watermark,
      ),
      // A live watermark can land mid-minute. A window ending on it would straddle the bucket that
      // contains it, and a minute-precision event cannot be split across the edge, so the window
      // would answer nothing. Ending on the last complete minute is the trade the page makes:
      // at most the current partial minute, in exchange for windows that can actually answer.
      end = at ?? liveWindowEnd(watermark, availableFromSec);
    if (end > watermark || end < availableFromSec)
      throw new RangeError('Cutoff is outside retained chain-time evidence');
    const valuations = new Map(report.rwa.map((row) => [row.asset.address, row.valuations ?? []]));
    // Every registered stock is reported, not only the ones this bounded round selected: a stock
    // whose pools are all quiet still owns them, and dropping it would silently shrink the page.
    const stocks = input.assets.assets.map((asset) => ({
      asset,
      valuations: valuations.get(asset.address) ?? [],
    }));
    const nowMs = Date.now(),
      freshness = snapshotFreshness(report.at.timestampSec, nowMs);
    const generation: GenerationInput = {
      scopeId: input.scopeId,
      registryScopeId: input.registryScopeId,
      configVersion: input.configVersion,
      assetVersion: input.assets.version,
      sourceHash: report.sourceHash,
      registryRevision: this.#registryPosition,
      metadataRevision: input.metadata.version,
      cutoffSec: at ?? null,
      sourceChainTimeSec: report.at.timestampSec,
      selectedEndSec: end,
      availableFromSec,
      nowMs,
      status: freshness.status,
      message: freshness.message,
      health: runtimeHealth(this.#dbPath, input.scopeId),
      notes: [
        ...report.notes.filter((note) => !note.startsWith(SELECTED_REPORT_NOTE)),
        ...SNAPSHOT_NOTES,
      ],
      coverage: report.coverage,
      stocks,
    };
    return this.#model!.publish(generation);
  }

  /**
   * The pools this round evaluates: the ones the window still holds an event for.
   *
   * The index is expired to the round's own window by the same read a bounded projection uses, so
   * the window rule keeps exactly one implementation. A window that cannot be established leaves
   * the index where it was, which is reported as a stale projection rather than computed from it.
   */
  #windowPools(sinceSec: number): ReadonlySet<string> {
    const projection = this.#live!.readSelected(
      this.#input!.scopeId,
      this.#input!.registryScopeId,
      this.#input!.configVersion,
      sinceSec - READ_MARGIN_SEC,
      { pools: EMPTY_SET, tokens: EMPTY_SET, index: this.#index! },
    );
    if (projection === null) throw new StaleMetricProjectionError();
    return this.#index!.pools();
  }

  /**
   * What the round that accepted this batch did to the window, derived here because no caller
   * shares this process: the events the index holds now against the ones it held last round.
   */
  #eventDelta(): {
    upserts: readonly PoolEvent[];
    deletedKeys: readonly string[];
    revisions: Map<string, string>;
  } {
    const events = this.#index!.eventsFor(this.#index!.pools()),
      revisions = new Map<string, string>(),
      upserts: PoolEvent[] = [];
    for (const event of events) {
      const key = rawLogKey(event.ref),
        revision = revisionOf(event);
      revisions.set(key, revision);
      if (this.#eventRevisions.get(key) !== revision) upserts.push(event);
    }
    const deletedKeys: string[] = [];
    for (const key of this.#eventRevisions.keys()) if (!revisions.has(key)) deletedKeys.push(key);
    return { upserts, deletedKeys, revisions };
  }

  /**
   * The registry mutations since the position already folded into the read model.
   *
   * A database with the journal answers this from one indexed maximum and the rows it names. A
   * database without one has no way to name what moved, so its catalogue is read again and the
   * difference is the delta — the cost the journal exists to remove, paid by the file that cannot
   * carry it. Neither path writes anything.
   *
   * The journal's sequence is one global counter, so the position is also the correct lower bound
   * for both scopes at once, and every row at or below it has been consumed for both of them.
   */
  #registryRows(view: RegistryView): {
    rows: RegistryDeltaRow[];
    position: number;
    catalogue: Map<string, PoolRegistration> | null;
  } {
    const db = this.#db!,
      input = this.#input!;
    if (!this.#journal) {
      const catalogue = new Map(
        new PoolRegistry([
          ...this.#raw!.pools(input.registryScopeId),
          ...this.#raw!.pools(input.scopeId),
        ])
          .snapshot()
          .map((row) => [poolRegistrationId(row), row]),
      );
      const rows: RegistryDeltaRow[] = [];
      for (const [poolId, after] of catalogue) {
        const before = this.#catalogue.get(poolId) ?? null;
        if (before !== null && registrationsEqual(before, after)) continue;
        rows.push({ poolKey: poolId, before, after });
      }
      for (const [poolId, before] of this.#catalogue)
        if (!catalogue.has(poolId)) rows.push({ poolKey: poolId, before, after: null });
      return {
        rows,
        position: rows.length === 0 ? this.#registryPosition : this.#registryPosition + 1,
        catalogue,
      };
    }
    const position = this.#journalPosition();
    if (position === this.#registryPosition) return { rows: [], position, catalogue: null };
    const changes: RegistryChange[] = [];
    for (const scopeId of new Set([input.registryScopeId, input.scopeId]))
      changes.push(...registryChangesAfter(db, scopeId, this.#registryPosition));
    // A journal row is one registration, not the merged identity. Only publish the final
    // before/after pool after RegistryCache has folded every surviving row in both scopes.
    const touched = new Map<string, string>();
    for (const change of changes)
      for (const record of [change.before, change.after])
        if (record !== null) touched.set(poolRegistrationId(record), change.poolKey);
    const rows: RegistryDeltaRow[] = [];
    for (const [poolId, poolKey] of touched) {
      const before = this.#catalogue.get(poolId) ?? null;
      const after = view.get(poolId) ?? null;
      if (
        before === after ||
        (before !== null && after !== null && registrationsEqual(before, after))
      )
        continue;
      rows.push({ poolKey, before, after });
    }
    return { rows, position, catalogue: null };
  }

  /** The append-only position of both catalogues this reader follows, in one indexed read. */
  #journalPosition(db = this.#db!, input = this.#input!): number {
    const row = db
      .prepare('select max(seq) as seq from registry_changes where scope_id in (?,?)')
      .get(input.scopeId, input.registryScopeId) as { seq: number | null };
    return row.seq ?? 0;
  }

  /**
   * Everything a round's identity depends on, as one string.
   *
   * The accepted tip alone is not enough: a batch can add live events without moving the tip, so
   * the highest projected log of the scope is read too, together with the two source revisions the
   * projection cursor is built from, the cursor's own token, the registry position and the durable
   * metadata revision. Every one of them is an indexed read; none of them touches a catalogue row.
   */
  #sourceToken(): string {
    const db = this.#db!,
      input = this.#input!,
      tip = this.#raw!.acceptedTip(input.scopeId),
      cursor = db.prepare(SOURCE_TOKEN_SQL.cursor).pluck().get(input.scopeId),
      high = db.prepare(SOURCE_TOKEN_SQL.high).get(input.scopeId) as
        { id: number | null } | undefined;
    return encodeJson([
      tip?.number.toString() ?? null,
      tip?.hash ?? null,
      tip?.timestampSec ?? null,
      cursor ?? null,
      high?.id ?? null,
      this.#sourceRevision(input.scopeId),
      this.#sourceRevision(input.registryScopeId),
      this.#journal ? this.#journalPosition() : this.#registryPosition,
      this.#metadataRevision(),
    ]);
  }

  /**
   * The metadata revision this round would value with, read fresh on every call.
   *
   * `buildMetricsReport` merges the durable `token_metadata` table into the seed on every round, so
   * a lookup that lands while the chain stands still is a round whose answers have changed: no
   * block, no log, no cursor and no registry row moves, and the decimals behind every USD figure do.
   * The revision is therefore read here, as one term of the round's own token, and never remembered
   * on the instance — a value settled at `#init` would be the one input the change detection could
   * not watch, and the page would keep reporting the previous valuation until some unrelated write
   * happened to arrive and carried the new one in behind it.
   *
   * A file that predates the metadata journal cannot report a revision at all — its counter is
   * always 0, which would pin the token to a value that can never move — so it falls back to the
   * seed version it was built with, the only identity such a reader has.
   */
  #metadataRevision(): number | string {
    return this.#metadataJournal ? metadataRevision(this.#db!) : this.#input!.metadata.version;
  }

  #sourceRevision(scopeId: string): number | null {
    if (!this.#sourceRevisions) return null;
    const row = this.#db!.prepare(
      'select revision from live_source_revisions where scope_id=?',
    ).get(scopeId) as { revision: number } | undefined;
    return row?.revision ?? null;
  }

  #page(message: Extract<SnapshotWorkerRequest, { type: 'poolPage' }>): void {
    if (this.#model === null) {
      this.#fail(message.id, 'SNAPSHOT_UNAVAILABLE');
      return;
    }
    try {
      this.port.postMessage({
        type: 'page',
        id: message.id,
        page: this.#model.pools({
          generation: message.generation,
          tokenAddress: message.address,
          window: message.window,
          offset: message.offset,
          limit: message.limit,
        }),
      });
    } catch (error) {
      if (error instanceof SnapshotExpiredError)
        this.port.postMessage({ type: 'expired', id: message.id });
      else this.#fail(message.id, classify(error));
    }
  }

  #history(id: number, generation: string, address: string): void {
    if (this.#model === null) {
      this.#fail(id, 'SNAPSHOT_UNAVAILABLE');
      return;
    }
    try {
      this.port.postMessage({
        type: 'history',
        id,
        history: this.#model.history({ generation, tokenAddress: address }),
      });
    } catch (error) {
      if (error instanceof SnapshotExpiredError) this.port.postMessage({ type: 'expired', id });
      else this.#fail(id, classify(error));
    }
  }

  #fail(id: number | undefined, code: SnapshotWorkerFailure): void {
    this.port.postMessage(
      id === undefined ? { type: 'failed', code } : { type: 'failed', id, code },
    );
  }
}

export function createSnapshotWorker(port: SnapshotWorkerPort): SnapshotWorker {
  return new SnapshotWorker(port);
}

/** A served thread wires itself; an imported module on the main thread wires nothing. */
if (!isMainThread && parentPort !== null) {
  const port = parentPort,
    worker = createSnapshotWorker(port);
  port.on('message', (message: SnapshotWorkerRequest) => {
    worker.handle(message);
    // `close` releases the connection, and then releases the thread: a reader that has been told to
    // stop may not be the reason a process stays alive.
    if (message.type === 'close') port.close();
  });
}
