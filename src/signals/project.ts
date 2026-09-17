import { countWork } from '../ops/work-counters.js';
import { inRollingWindow } from '../metrics/rolling.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { encodeJson } from '../domain/json.js';
import type { BlockAnchor } from '../domain/types.js';
import { poolRegistrationId } from '../registry/pools.js';
import { SqliteRangeStore } from '../storage/raw-store.js';
import { encodeBatchReference, putPayload } from '../storage/payload-store.js';
import {
  LiveProjectionStore,
  type LiveProjectionChanges,
  type RegistryEvidence,
} from '../storage/live-projection.js';
import { eventIndexFor } from '../storage/live-event-index.js';
import {
  liveWorksetFor,
  snapshotHasMemory,
  type LiveWorksetStore,
} from '../storage/live-workset.js';
import { StaleMetricProjectionError } from '../storage/metric-store.js';
import { SqliteProjectionStore } from '../storage/projection-store.js';
import { registryCacheFor, type PreparedRegistry } from '../storage/registry-cache.js';
import {
  buildMetricsReport,
  type MetricInput,
  type MetricsReport,
} from '../storage/metric-store.js';
import type { RecordedRangeBatch } from '../storage/manifest.js';
import { rawLogKey } from '../storage/manifest.js';
import { AlertOutbox, type CaptureMode } from '../notify/outbox.js';
import { formatObservedLiquidity } from '../notify/format.js';
import type { BatchTimings } from '../ops/batch-timings.js';
import { measureStage } from '../ops/batch-timings.js';
import { encodeSignalState, decodeSignalState } from './codec.js';
import { type SignalConfig } from './config.js';
import { createSignalEvaluator, initialSignalSnapshot } from './engine.js';
import type { AlertRecord, SignalDecision, SignalInput, SignalSnapshot } from './types.js';

export interface SignalBatchContext {
  batchId: string;
  observedAtMs: number;
  captureMode: CaptureMode;
}
/**
 * What a round selects against, when the caller already prepared it.
 *
 * The registry view has to be the caller's own. A batch stages the pools it discovers on the
 * prepared view before it commits, and a view built here instead would not hold them — so a pool
 * this very batch discovered would be selected and then found to have no registration, and would
 * contribute no window at all. Absent, the shared cache is prepared here, which is what a direct
 * caller with nothing new to publish gets.
 */
export interface SignalSelectionContext {
  registry?: PreparedRegistry;
}
/** Quote dependencies are inputs to a valuation, not pools to evaluate. */
const NO_POOLS: ReadonlySet<string> = new Set();
type EvidenceItem = {
  minuteStartSec?: number | null;
  block: bigint;
  poolIds?: string[];
  digest: string;
  complete?: boolean;
  ordinaryCurrentPartial?: boolean;
};
type Evidence = {
  sinceSec?: number;
  sinceBlock?: bigint;
  contextIncomplete?: boolean;
  branchRecovery?: boolean;
  events: Record<string, EvidenceItem>;
  closedCoverage: Record<string, EvidenceItem>;
  pools: Record<string, EvidenceItem>;
  /**
   * Present when `pools` is a bounded delta rather than the whole catalogue: it names the registry
   * position the delta was taken from, and its presence is what tells `repairedFrom` to read the
   * group that way. One change per identity, and only since the previous window.
   */
  registry?: { format: 'registry-evidence-v1'; revisionKey: string };
};
type Cursor = {
  config_hash: string;
  source_hash: string;
  epoch: string;
  block_number: string;
  block_hash: string;
  evidence_json: string;
};
const outboxes = new WeakMap<Database.Database, AlertOutbox>();
const statements = new WeakMap<Database.Database, Map<string, Database.Statement>>();
function statement(db: Database.Database, sql: string): Database.Statement {
  let cache = statements.get(db);
  if (!cache) {
    cache = new Map();
    statements.set(db, cache);
  }
  let prepared = cache.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    cache.set(sql, prepared);
  }
  return prepared;
}
const digest = (v: unknown) => createHash('sha256').update(encodeJson(v)).digest('hex');

function compactSignalJson(
  db: Database.Database,
  value: unknown,
  memo: Map<string, string>,
): string {
  const encoded = encodeSignalState(value);
  const cached = memo.get(encoded);
  if (cached !== undefined) return cached;
  countWork('signalAuditPayloadWrites');
  const ref = encodeBatchReference(putPayload(db, Buffer.from(encoded, 'utf8')));
  // Bound both cardinality and key size. Only identical bytes share a payload; every pool
  // still receives its own audit row. A new transaction must revalidate stored objects.
  if (memo.size < 64 && encoded.length <= 65536) memo.set(encoded, ref);
  return ref;
}

/** Called within the same outer transaction as range acceptance and P2 rebuild.
 * It never performs I/O to a notification destination. */
export function commitSignalDecision(
  db: Database.Database,
  scopeId: string,
  decision: SignalDecision,
  mode: CaptureMode,
  provenance?: AlertRecord['provenance'],
): AlertRecord | null {
  if (!db.inTransaction) throw new Error('Signal decisions require an enclosing transaction');
  const draft = decision.alertDraft;
  if (!draft) return null;
  const prior = statement(
    db,
    'select revision,payload_json from alerts where scope_id=? and id=?',
  ).get(scopeId, draft.id) as { revision: number; payload_json: string } | undefined;
  const proposed: AlertRecord = { ...draft, ...(provenance ? { provenance } : {}) };
  if (prior) {
    const old = decodeSignalState<AlertRecord>(prior.payload_json);
    const { revision: _oldRevision, ...oldComparable } = old;
    const { revision: _proposedRevision, ...proposedComparable } = proposed;
    if (isDeepStrictEqual(oldComparable, decodeSignalState(encodeSignalState(proposedComparable))))
      return null;
  }
  const record: AlertRecord = { ...proposed, revision: (prior?.revision ?? 0) + 1 };
  saveRecord(db, scopeId, record, mode, true);
  return record;
}
function saveRecord(
  db: Database.Database,
  scopeId: string,
  record: AlertRecord,
  mode: CaptureMode,
  active: boolean,
) {
  // Ledger mode retains whether this identity ever needed a live withdrawal.
  // Each outbox revision still uses its actual capture mode below.
  statement(
    db,
    `insert into alerts(scope_id,id,revision,capture_mode,active,payload_json) values(?,?,?,?,?,?)
    on conflict(scope_id,id) do update set revision=excluded.revision,capture_mode=case when alerts.capture_mode='live' then 'live' else excluded.capture_mode end,active=excluded.active,payload_json=excluded.payload_json`,
  ).run(scopeId, record.id, record.revision, mode, active ? 1 : 0, encodeSignalState(record));
  let outbox = outboxes.get(db);
  if (!outbox) {
    outbox = new AlertOutbox(db);
    outboxes.set(db, outbox);
  }
  outbox.enqueue(scopeId, record, mode);
}

/** Conservative invalidation: all reminders at/after changed history lose their
 * provisional evidence. Preserve identity/cooldown until a real branch change.
 * Does not claim the historical condition was definitely false. P5 may add
 * precise historical replay, but unverified old notifications must not survive. */
export function retractSignals(
  db: Database.Database,
  scopeId: string,
  context: SignalBatchContext,
  reason: string,
  fromBlock = 0n,
  affectedPoolIds?: ReadonlySet<string>,
): AlertRecord[] {
  return db.transaction(() => {
    const rows = statement(
      db,
      'select capture_mode,payload_json from alerts where scope_id=? and active=1',
    ).all(scopeId) as { capture_mode: CaptureMode; payload_json: string }[];
    const records: AlertRecord[] = [];
    for (const row of rows) {
      const prior = decodeSignalState<AlertRecord>(row.payload_json);
      if (
        prior.endAnchor.number < fromBlock ||
        (affectedPoolIds && !affectedPoolIds.has(prior.poolId))
      )
        continue;
      const record: AlertRecord = {
        ...prior,
        revision: prior.revision + 1,
        kind: 'retracted',
        status: 'retracted',
        coverage: 'rechecking',
        atBatchId: context.batchId,
        observedAtMs: context.observedAtMs,
        reasons: [...prior.reasons, reason, 'evidence-invalidated-rechecking'],
      };
      // A historical/backfill record must never be promoted to a live sink.
      saveRecord(db, scopeId, record, row.capture_mode, false);
      records.push(record);
    }
    // Preserve consumed evidence and cooldown across a recovery recheck.
    // Recorder uses scope-rechecking only for detected recovery. Persist this
    // marker until accepted replacement evidence is projected, even if its new
    // tip advances beyond the old tip.
    if (reason === 'scope-rechecking') {
      const cursor = statement(db, 'select evidence_json from signal_cursors where scope_id=?').get(
        scopeId,
      ) as { evidence_json: string } | undefined;
      if (cursor)
        statement(db, 'update signal_cursors set evidence_json=? where scope_id=?').run(
          encodeSignalState({
            ...decodeSignalState<Evidence>(cursor.evidence_json),
            branchRecovery: true,
          }),
          scopeId,
        );
    }
    return records;
  })();
}
/** A pool the registry no longer holds, distinguished from every real registration digest. */
const REMOVED_POOL_DIGEST = 'no-longer-registered';

function readEvidence(
  db: Database.Database,
  input: MetricInput,
  report: MetricsReport,
  registry?: RegistryEvidence,
): Evidence {
  const raw = new SqliteRangeStore(db);
  const bounds =
    report.liveSinceSec === null ? undefined : { sinceSec: Math.max(0, report.liveSinceSec - 120) };
  const boundary = bounds
    ? (db
        .prepare(
          'select first_block from minute_boundaries where scope_id=? and timestamp_sec<=? and timestamp_sec>=? order by timestamp_sec desc limit 1',
        )
        .get(input.scopeId, bounds.sinceSec, Math.floor(bounds.sinceSec / 60) * 60) as
        { first_block: number } | undefined)
    : undefined;
  const blockBounds = boundary ? { fromBlock: BigInt(boundary.first_block) } : undefined;
  const evidenceLogs = raw.activeLogEvidence(input.scopeId, { ...bounds, ...blockBounds });
  const valuations = new Map(report.valuations.map((v) => [v.eventId, v]));
  const dependencies = new Map<string, Set<string>>();
  for (const v of report.valuations) {
    for (const id of [
      v.eventId,
      ...(v.quoteEvidence ? [rawLogKey(v.quoteEvidence.effectiveAt)] : []),
    ]) {
      const owners = dependencies.get(id) ?? new Set<string>();
      owners.add(poolRegistrationId(v));
      dependencies.set(id, owners);
    }
  }
  const events: Evidence['events'] = {};
  for (const { log, time } of evidenceLogs) {
    const key = rawLogKey(log);
    events[key] = {
      block: log.blockNumber,
      minuteStartSec: time?.minuteStartSec ?? null,
      poolIds: [...(dependencies.get(key) ?? [])],
      digest: digest({ log, time: time ?? null, valuation: valuations.get(key) ?? null }),
    };
  }
  const closedCoverage: Evidence['closedCoverage'] = {};
  const currentMinuteSec = Math.floor(report.at.timestampSec / 60) * 60;
  for (const c of report.coverage)
    closedCoverage[String(c.minuteStartSec)] = {
      block: c.toBlock ?? c.fromBlock ?? report.at.number,
      digest: digest(c),
      complete: c.complete,
      ordinaryCurrentPartial:
        c.minuteStartSec === currentMinuteSec &&
        !c.complete &&
        c.reasons.length > 0 &&
        c.reasons.every((reason) => reason === 'watermark-partial'),
    };
  const pools: Evidence['pools'] = {};
  if (registry) {
    // The live path never reads the catalogue here: the journal already named the identities that
    // moved, and each one carries the registration it now holds (or nothing, when it is gone).
    for (const change of registry.changes)
      pools[change.poolId] = {
        block: change.block,
        digest: change.record ? digest(change.record) : REMOVED_POOL_DIGEST,
        poolIds: [change.poolId],
      };
  } else
    for (const p of [...raw.pools(input.registryScopeId), ...raw.pools(input.scopeId)])
      pools[poolRegistrationId(p)] = {
        block: p.discoveredAt.blockNumber,
        digest: digest(p),
        poolIds: [poolRegistrationId(p)],
      };
  return {
    events,
    closedCoverage,
    pools,
    ...(registry
      ? { registry: { format: 'registry-evidence-v1' as const, revisionKey: registry.revisionKey } }
      : {}),
    contextIncomplete: report.windowContextIncomplete,
    ...(bounds
      ? { sinceSec: bounds.sinceSec, ...(blockBounds ? { sinceBlock: blockBounds.fromBlock } : {}) }
      : {}),
  };
}
function repairedFrom(
  old: Evidence,
  current: Evidence,
  tip: bigint,
  affected: Set<string>,
): bigint | null {
  let from: bigint | null = null;
  const add = (block: bigint, owners?: string[]) => {
    for (const owner of owners ?? ['*']) affected.add(owner);
    if (from === null || block < from) from = block;
  };
  // A live registry evidence group is a bounded delta, not a catalogue: it carries one entry per
  // identity that moved since the previous window. An identity the previous window never reported
  // is news only when it already existed at that window's tip; one it did report and that is absent
  // now simply did not move again, which is not a removal.
  const registryDelta = old.registry?.format === 'registry-evidence-v1';
  for (const group of ['events', 'pools', 'closedCoverage'] as const) {
    if (group === 'pools' && registryDelta) {
      for (const [id, item] of Object.entries(current.pools)) {
        const before = old.pools[id];
        if (before !== undefined && before.digest === item.digest) continue;
        if (before === undefined && item.block > tip) continue;
        add(item.block, item.poolIds);
      }
      continue;
    }
    for (const [id, item] of Object.entries(old[group])) {
      const now = current[group][id];
      if (
        group === 'closedCoverage' &&
        item.complete === false &&
        item.ordinaryCurrentPartial === true &&
        (now?.complete === true || now?.ordinaryCurrentPartial === true)
      )
        continue;
      // Coverage evidence is bounded; expiry outside the retained window is
      // not a repair. Missing raw events/registrations still invalidate.
      if (group === 'closedCoverage' && !now) continue;
      if (group === 'events' && !now && item.minuteStartSec == null && current.contextIncomplete)
        continue;
      if (
        group === 'events' &&
        !now &&
        current.sinceSec !== undefined &&
        (item.minuteStartSec != null
          ? item.minuteStartSec < current.sinceSec
          : current.sinceBlock !== undefined && item.block < current.sinceBlock)
      )
        continue;
      if (!now || now.digest !== item.digest)
        add(
          item.block,
          group === 'closedCoverage'
            ? undefined
            : [...(item.poolIds ?? ['*']), ...(now?.poolIds ?? [])],
        );
    }
    if (group !== 'closedCoverage')
      for (const [id, item] of Object.entries(current[group]))
        if (!old[group][id] && item.block <= tip) add(item.block, item.poolIds);
  }
  return from;
}
function presentationIndex(report: MetricsReport, input: MetricInput) {
  const annotations = new Map(report.annotations.map((a) => [a.poolId, a]));
  const rwa = new Map<string, string[]>();
  for (const r of report.rwa)
    for (const id of r.poolIds) rwa.set(id, [...(rwa.get(id) ?? []), r.asset.symbol]);
  const symbols = new Map(input.assets.assets.map((a) => [a.address, a.symbol]));
  const byPool = new Map<string, MetricsReport['valuations']>();
  const tokensByTx = new Map<string, Set<string>>();
  for (const v of report.valuations) {
    const id = poolRegistrationId(v);
    const group = byPool.get(id) ?? [];
    group.push(v);
    byPool.set(id, group);
    const tokens = tokensByTx.get(v.transactionHash) ?? new Set<string>();
    const a = annotations.get(id);
    for (const token of a ? [a.pair.token0, a.pair.token1] : [])
      if (token !== input.usdg && !input.assets.has(token)) tokens.add(token);
    tokensByTx.set(v.transactionHash, tokens);
  }
  return (
    poolId: string,
    endSec: number,
    closed = false,
  ): { presentation: SignalInput['presentation']; evidenceEventIds: string[] } => {
    const a = annotations.get(poolId);
    const local = (byPool.get(poolId) ?? []).filter(
      (v) =>
        v.time.minuteStartSec !== null &&
        inRollingWindow(v.time, endSec - 300, endSec, endSec === report.at.timestampSec) === true,
    );
    const txs = [...new Set(local.map((v) => v.transactionHash))];
    return {
      presentation: {
        rwaSymbol: rwa.get(poolId)?.join(' / ') ?? 'unknown',
        pairLabel: (a ? [a.pair.token0, a.pair.token1] : [])
          .map((t) => (t === input.usdg ? 'USDG' : (symbols.get(t) ?? t)))
          .join(' / '),
        associatedTokens: [...new Set(txs.flatMap((tx) => [...(tokensByTx.get(tx) ?? [])]))],
        evidenceTxs: txs,
        liquidityNote: closed
          ? 'unknown (historical liquidity observation unavailable)'
          : formatObservedLiquidity(a?.lastSwap ?? null),
      },
      evidenceEventIds: local.map((v) => v.eventId),
    };
  };
}
/**
 * The pools one live round has to evaluate.
 *
 * The memory-bearing pools are reconsidered whenever the history under them moved: coverage, a
 * branch to recover, a repair this round owes, a branch that went backwards. A pool with no memory
 * is not one any of those can turn into a reminder — `retractSignals` only ever withdraws an active
 * alert, and an active alert is memory — so leaving those out is the same answer, not a shorter one.
 *
 * The window bound is the read's own lower bound, not `sinceSec`: the read reaches two minutes
 * further back than it reports, and a pool whose only event sits in that margin is still a pool
 * whose valuation this round computed.
 */
function selectWorkset(args: {
  workspace: LiveWorksetStore;
  context: SignalBatchContext;
  liveChanges: LiveProjectionChanges;
  changedPoolIds: ReadonlySet<string>;
  cursor: Cursor | undefined;
  repair: { min_block: number } | undefined;
  tip: BlockAnchor;
  sinceSec: number;
}): ReadonlySet<string> {
  const { workspace, context, liveChanges, changedPoolIds, cursor, repair, tip, sinceSec } = args;
  // A database that recorded signals before this table existed has no members yet; the scan that
  // fills it happens once and is remembered, so a legitimately empty workset is not a missing one.
  if (!workspace.seeded()) workspace.seed(context.observedAtMs);
  const evidence = cursor ? decodeSignalState<Evidence>(cursor.evidence_json) : undefined;
  const branchMoved =
    cursor !== undefined &&
    (tip.number < BigInt(cursor.block_number) ||
      (tip.number === BigInt(cursor.block_number) && tip.hash !== cursor.block_hash));
  return workspace.select({
    changedPoolIds,
    // A quote dependency is an input to a valuation, not a pool to evaluate: the report resolves
    // them from the selected pools' own token lists.
    dependencyPoolIds: NO_POOLS,
    watermarkSec: tip.timestampSec,
    coverageChanged:
      liveChanges.coverageChanged === true ||
      repair !== undefined ||
      liveChanges.repairFrom != null ||
      evidence?.branchRecovery === true ||
      branchMoved,
    bounds: { sinceSec: sinceSec - 120, sinceBlock: null },
  });
}
export function projectSignals(
  db: Database.Database,
  input: MetricInput,
  config: SignalConfig,
  context: SignalBatchContext,
  liveChanges?: LiveProjectionChanges,
  timings?: BatchTimings,
  selection?: SignalSelectionContext,
): AlertRecord[] {
  let claimed = false;
  const records = db
    .transaction(() => {
      if (
        !liveChanges &&
        db.prepare('select 1 from live_projection_cursors where scope_id=?').get(input.scopeId)
      ) {
        if (
          db.prepare('select 1 from live_dirty_logs where scope_id=? limit 1').get(input.scopeId) &&
          !new SqliteProjectionStore(db).read(
            input.scopeId,
            input.registryScopeId,
            input.configVersion,
          )
        )
          throw new StaleMetricProjectionError();
        liveChanges = new LiveProjectionStore(db).sync(
          input.scopeId,
          input.registryScopeId,
          input.configVersion,
        );
      }
      const evaluator = createSignalEvaluator(config);
      // Retain the existing coverage horizon limit. Larger sample requirements
      // remain insufficient evidence instead of crashing an accepted configuration.
      const historyMinutes = Math.min(
        10080,
        Math.max(
          180,
          config.candidate.samples + 10,
          config.confirmRelative.samples * 5 + 10,
          config.cooling.buckets * 5 + 10,
        ),
      );
      // Selecting here rather than inside the build is what keeps the selection and the read on one
      // window: `sinceSec` is the same expression over the same accepted tip that the build derives
      // its own lower bound from, so a pool the workset keeps is a pool the report can still see
      // events for, and one it retires is one the read already stopped returning.
      const tip = liveChanges ? new SqliteRangeStore(db).acceptedTip(input.scopeId) : null;
      const sinceSec = tip ? Math.floor(tip.timestampSec / 60) * 60 - historyMinutes * 60 : null;
      const eventIndex = liveChanges ? eventIndexFor(db, input.scopeId) : null;
      const workspace = eventIndex ? liveWorksetFor(db, input.scopeId, eventIndex) : null;
      const registry = workspace
        ? (selection?.registry?.view ??
          registryCacheFor(db, input.registryScopeId, input.scopeId).prepare().view)
        : null;
      // Read for the selection alone. The build runs a sync of its own, so a read taken after it
      // could name a repair this round has not reached yet; reading before it errs towards
      // reconsidering the pools with memory, which is the direction that cannot lose a reminder.
      const selectionCursor = statement(db, 'select * from signal_cursors where scope_id=?').get(
        input.scopeId,
      ) as Cursor | undefined;
      const selectionRepair = statement(
        db,
        'select min_block from live_pending_signal_repairs where scope_id=?',
      ).get(input.scopeId) as { min_block: number } | undefined;
      const selected =
        liveChanges && workspace && eventIndex && registry && tip && sinceSec !== null
          ? selectWorkset({
              workspace,
              context,
              liveChanges,
              changedPoolIds:
                selection?.registry?.changedPoolIds ?? new Set(liveChanges.affectedPoolIds),
              cursor: selectionCursor,
              repair: selectionRepair,
              tip,
              sinceSec,
            })
          : null;
      const report = buildMetricsReport(
        db,
        input,
        liveChanges
          ? {
              live: {
                historyMinutes,
                ...(selected && registry && eventIndex
                  ? {
                      poolIds: selected,
                      registry,
                      eventIndex,
                      // The round that accepted this batch already moved the window. Handing back its
                      // own delta is what lets the report invalidate a quote it revised instead of
                      // reading the sync it runs itself, which sees an empty journal by then.
                      changes: liveChanges,
                    }
                  : {}),
              },
              timings,
            }
          : { timings },
      );
      const configHash = digest({
        signal: evaluator.version,
        chain: input.configVersion,
        metadata: input.metadata,
        usdg: input.usdg,
        assets: input.assets.assets,
        metricVersion: report.version,
      });
      const old = statement(db, 'select * from signal_cursors where scope_id=?').get(
        input.scopeId,
      ) as Cursor | undefined;
      const oldEvidence = old ? decodeSignalState<Evidence>(old.evidence_json) : undefined;
      const pendingRepair = statement(
        db,
        'select min_block from live_pending_signal_repairs where scope_id=?',
      ).get(input.scopeId) as { min_block: number } | undefined;
      if (
        old &&
        !oldEvidence?.branchRecovery &&
        old.config_hash === configHash &&
        old.source_hash === report.sourceHash &&
        !pendingRepair
      )
        return [];
      const evidence = readEvidence(db, input, report, liveChanges?.registry);
      let repair: bigint | null = null;
      const affected = new Set<string>();
      let branchChanged = false;
      if (old) {
        if (old.config_hash !== configHash) {
          repair = 0n;
          affected.add('*');
        } else {
          repair = repairedFrom(
            decodeSignalState<Evidence>(old.evidence_json),
            evidence,
            BigInt(old.block_number),
            affected,
          );
          if (
            report.at.number < BigInt(old.block_number) ||
            (report.at.number === BigInt(old.block_number) && report.at.hash !== old.block_hash)
          ) {
            branchChanged = true;
            affected.add('*');
            repair = repair === null || report.at.number < repair ? report.at.number : repair;
          }
        }
      }
      if (liveChanges?.repairFrom !== null && liveChanges?.repairFrom !== undefined) {
        repair =
          repair === null || liveChanges.repairFrom < repair ? liveChanges.repairFrom : repair;
        // A revised quote can affect downstream pools; conservatively invalidate
        // provisional dependencies from this block even after hot-window expiry.
        affected.add('*');
      }
      if (pendingRepair) {
        const block = BigInt(pendingRepair.min_block);
        repair = repair === null || block < repair ? block : repair;
        affected.add('*');
      }
      if (oldEvidence?.branchRecovery) {
        branchChanged = true;
        affected.add('*');
        repair = 0n;
      }
      const records =
        repair === null
          ? []
          : retractSignals(
              db,
              input.scopeId,
              context,
              'source-history-revised',
              repair,
              affected.has('*') ? undefined : affected,
            );
      const epoch =
        old && !branchChanged && old.config_hash === configHash
          ? old.epoch
          : digest({
              configHash,
              scopeId: input.scopeId,
              ...(branchChanged ? { branch: report.at.hash } : {}),
            });
      const present = presentationIndex(report, input);
      // One measured stage around the real per-pool evaluation and outbox work; the
      // report's own stages (registry/coverage/valuation/windows) are measured
      // separately inside buildMetricsReport, so no interval is counted twice.
      const evaluatedPoolIds: string[] = [];
      const auditPayloads = new Map<string, string>();
      const evaluateWindows = () => {
        for (const w of report.windows) {
          evaluatedPoolIds.push(w.poolId);
          const row = statement(
            db,
            'select payload_json from signal_snapshots where scope_id=? and pool_id=?',
          ).get(input.scopeId, w.poolId) as { payload_json: string } | undefined;
          const previous =
            row && !branchChanged
              ? decodeSignalState<SignalSnapshot>(row.payload_json)
              : initialSignalSnapshot();
          const coverage = w.rolling
            ? w.rolling['1m'].status === 'closed'
              ? 'complete'
              : w.rolling['1m'].status === 'gap'
                ? 'gap'
                : 'warming'
            : w.partialCurrent?.status === 'partial'
              ? 'complete'
              : w.partialCurrent?.status === 'gap'
                ? 'gap'
                : 'warming';
          // Reconsider a corrected entry bucket under the existing episode and
          // logical cooldown. Only material escalation can bypass that cooldown;
          // unchanged quantities cannot reappear as a fresh historical reminder.
          const correctedEntry =
            repair !== null &&
            !branchChanged &&
            (affected.has('*') || affected.has(w.poolId)) &&
            previous.lastAlertScale === '5m' &&
            previous.lastFiveEndSec !== null &&
            previous.lastAlertSec === previous.lastFiveEndSec;
          const evaluationPrevious = correctedEntry
            ? { ...previous, lastFiveEndSec: previous.lastFiveEndSec! - 300 }
            : previous;
          const decision = evaluator.evaluate(evaluationPrevious, {
            pool: w.pool,
            batchId: context.batchId,
            observedAtMs: context.observedAtMs,
            endAnchor: report.at,
            watermarkSec: report.at.timestampSec,
            metrics: w,
            coverage,
            epoch,
            presentation: present(w.poolId, report.at.timestampSec).presentation,
          });
          const snapshotChanged = !isDeepStrictEqual(previous, decision.nextSnapshot);
          if (snapshotChanged || !row)
            statement(
              db,
              `insert into signal_snapshots(scope_id,pool_id,payload_json) values(?,?,?)
           on conflict(scope_id,pool_id) do update set payload_json=excluded.payload_json`,
            ).run(input.scopeId, w.poolId, encodeSignalState(decision.nextSnapshot));
          const drafts = decision.alertDrafts ?? (decision.alertDraft ? [decision.alertDraft] : []);
          // Audit material state transitions, matched decisions and historical
          // evaluations. Quiet pools do not append a receipt for every poll.
          const auditChanged = !isDeepStrictEqual(
            {
              ...previous,
              lastFiveEndSec: decision.nextSnapshot.lastFiveEndSec,
              lastHeatSec: decision.nextSnapshot.lastHeatSec,
            },
            decision.nextSnapshot,
          );
          if (auditChanged || drafts.length > 0)
            statement(
              db,
              `insert into signal_evaluations(scope_id,batch_id,source_hash,pool_id,payload_json) values(?,?,?,?,?)
           on conflict(scope_id,batch_id,source_hash,pool_id) do nothing`,
            ).run(
              input.scopeId,
              context.batchId,
              report.sourceHash,
              w.poolId,
              compactSignalJson(
                db,
                {
                  matches: decision.matches,
                  evaluations: decision.evaluations,
                  at: report.at,
                  observedAtMs: context.observedAtMs,
                  coverage,
                },
                auditPayloads,
              ),
            );
          for (const draft of drafts) {
            const evidenceAt = present(
              w.poolId,
              draft.logicalTimeSec ?? draft.watermarkSec,
              draft.metrics.partialCurrent === null,
            );
            const record = commitSignalDecision(
              db,
              input.scopeId,
              { ...decision, alertDraft: { ...draft, presentation: evidenceAt.presentation } },
              draft.historical && context.captureMode === 'live' ? 'backfill' : context.captureMode,
              {
                metricSourceHash: report.sourceHash,
                projectionSourceHash: report.projectionSourceHash,
                metricVersion: report.version,
                chainConfigVersion: report.configVersion,
                assetVersion: report.assetVersion,
                metadataVersion: report.metadata.version,
                evidenceEventIds: evidenceAt.evidenceEventIds,
              },
            );
            if (record) records.push(record);
          }
        }
      };
      measureStage(timings, 'signals', evaluateWindows);
      if (workspace && selected !== null) {
        // Membership is a claim about the durable snapshots, not about what this round reached: a
        // pool keeps its place while the state machine still has something to read back. The
        // snapshot is re-read here rather than taken from the decision, because a branch change
        // evaluates every pool from the initial state and leaves the stored one untouched.
        const retained = new Set(workspace.members());
        const stored = statement(
          db,
          'select payload_json from signal_snapshots where scope_id=? and pool_id=?',
        );
        for (const poolId of evaluatedPoolIds) {
          const row = stored.get(input.scopeId, poolId) as { payload_json: string } | undefined;
          if (row && snapshotHasMemory(decodeSignalState<SignalSnapshot>(row.payload_json)))
            retained.add(poolId);
          else retained.delete(poolId);
        }
        workspace.retain(retained);
      }
      // Armed for every round that has a workset, `null` included: a round that selected nothing
      // has to clear whatever an earlier attempt left armed, or it would answer for a round that
      // never committed. What is armed here becomes standing only once the round is durable.
      if (workspace) {
        claimed = true;
        workspace.arm(selected !== null ? (tip?.timestampSec ?? null) : null);
      }
      statement(
        db,
        `insert into signal_cursors(scope_id,config_hash,source_hash,epoch,block_number,block_hash,evidence_json) values(?,?,?,?,?,?,?)
      on conflict(scope_id) do update set config_hash=excluded.config_hash,source_hash=excluded.source_hash,epoch=excluded.epoch,block_number=excluded.block_number,block_hash=excluded.block_hash,evidence_json=excluded.evidence_json`,
      ).run(
        input.scopeId,
        configHash,
        report.sourceHash,
        epoch,
        report.at.number.toString(),
        report.at.hash,
        encodeSignalState(evidence),
      );
      statement(db, 'delete from live_pending_signal_repairs where scope_id=?').run(input.scopeId);
      return records;
    })
    .immediate();
  // The standing watermark may only move for a round whose work is durable, so it moves here and
  // not inside the transaction. Called from inside a larger one — the recorder's, which also writes
  // the accepted range and the projection cursor — this waits for that transaction's own commit
  // instead, and the store is the same shared one the round selected through.
  if (claimed && !db.inTransaction)
    liveWorksetFor(db, input.scopeId, eventIndexFor(db, input.scopeId)).commit();
  return records;
}
export function commitAcceptedSignalBatch(
  db: Database.Database,
  input: MetricInput,
  config: SignalConfig,
  batch: RecordedRangeBatch,
  options: {
    startNewSegment?: boolean;
    timings?: BatchTimings;
    registry?: PreparedRegistry;
    /**
     * Store the metadata that finished while this batch was being acquired, before anything reads.
     *
     * It runs inside this transaction and before the round's own reads, so a decimals observation
     * that arrived just in time is used by the valuation that needs it rather than by the next
     * round's; and because it is the same transaction as the batch, a rollback takes the
     * observation back with the range instead of leaving a cache entry no cursor accounts for. The
     * caller owns the ack: this only calls it.
     */
    applyMetadata?: () => void;
  } = {},
) {
  if (batch.scopeId !== input.scopeId) throw new Error('Signal batch scope mismatch');
  const { timings } = options;
  return db
    .transaction(() => {
      options.applyMetadata?.();
      // The accepted-range write and the live-cursor sync are the projection stage;
      // projectSignals measures its own leaves separately.
      const changes = measureStage(timings, 'projection', () =>
        new SqliteRangeStore(db).acceptRange(batch, { startNewSegment: options.startNewSegment }),
      );
      const liveChanges = measureStage(timings, 'projection', () =>
        new LiveProjectionStore(db).sync(
          input.scopeId,
          input.registryScopeId,
          input.configVersion,
          options.registry,
        ),
      );
      const alerts = projectSignals(
        db,
        input,
        config,
        {
          batchId: batch.id,
          observedAtMs: batch.observedAtMs,
          captureMode: batch.captureMode,
        },
        liveChanges,
        timings,
      );
      return { changes, alerts };
    })
    .immediate();
  // This is the transaction `projectSignals` ran inside, so this is where the round it selected
  // becomes durable and its watermark may stand. Doing it any earlier — from inside the round —
  // would let a rolled back batch answer for a watermark it never got to evaluate against. A
  // caller that nests this inside a bigger transaction is that transaction's to report, and the
  // round stays armed until it does.
  if (!db.inTransaction)
    liveWorksetFor(db, input.scopeId, eventIndexFor(db, input.scopeId)).commit();
}

/** Content-addressed objects may be shared by batches and evaluations in any
 * scope, so an object is reclaimed only when no surviving row references it. */
const RECLAIM_PAYLOAD_OBJECTS = `delete from payload_objects where hash not in (
  select hash from (
    select json_extract(payload_json,'$.payload.hash') as hash from ingest_batches
    union all
    select json_extract(value,'$.hash') as hash
      from ingest_batches, json_each(ingest_batches.payload_json,'$.payloads')
    union all
    select json_extract(payload_json,'$.payload.hash') as hash from signal_evaluations
    union all
    select json_extract(value,'$.hash') as hash
      from signal_evaluations, json_each(signal_evaluations.payload_json,'$.payloads')
  ) where hash is not null
)`;

/** Explicit maintenance only: preserve raw history, current alerts, snapshots,
 * cursors and all pending/failed deliveries. Limits count newest derived rows
 * per scope; terminal outbox payloads remain in the alert ledger where current. */
export function pruneSignalDerivedHistory(
  db: Database.Database,
  scopeId: string,
  limits: { evaluations: number; terminalDeliveries: number },
): { evaluations: number; terminalDeliveries: number; payloadObjects: number } {
  for (const limit of Object.values(limits))
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new RangeError('Retention limits must be non-negative safe integers');
  return db.transaction(() => ({
    evaluations: statement(
      db,
      `delete from signal_evaluations where scope_id=? and rowid not in
      (select rowid from signal_evaluations where scope_id=? order by rowid desc limit ?)`,
    ).run(scopeId, scopeId, limits.evaluations).changes,
    terminalDeliveries: statement(
      db,
      `delete from alert_outbox where scope_id=? and status in ('sent','superseded') and sequence not in
      (select sequence from alert_outbox where scope_id=? and status in ('sent','superseded') order by sequence desc limit ?)`,
    ).run(scopeId, scopeId, limits.terminalDeliveries).changes,
    // Runs inside the same transaction: deleted evaluation content cannot be
    // left behind as an orphan, and a failure keeps every row and object.
    payloadObjects: statement(db, RECLAIM_PAYLOAD_OBJECTS).run().changes,
  }))();
}
