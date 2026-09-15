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
import { StaleMetricProjectionError } from '../storage/metric-store.js';
import { SqliteProjectionStore } from '../storage/projection-store.js';
import type { PreparedRegistry } from '../storage/registry-cache.js';
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
import { signalConfigVersion, type SignalConfig } from './config.js';
import { evaluateSignal, initialSignalSnapshot } from './engine.js';
import type { AlertRecord, SignalDecision, SignalInput, SignalSnapshot } from './types.js';

export interface SignalBatchContext {
  batchId: string;
  observedAtMs: number;
  captureMode: CaptureMode;
}
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

function compactSignalJson(db: Database.Database, value: unknown): string {
  const ref = putPayload(db, Buffer.from(encodeSignalState(value), 'utf8'));
  return encodeBatchReference(ref);
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
  const times = bounds
    ? new Map([
        ...raw.logTimes(input.scopeId, bounds),
        ...(blockBounds ? raw.logTimes(input.scopeId, blockBounds) : []),
      ])
    : raw.logTimes(input.scopeId);
  const evidenceLogs = bounds
    ? [
        ...new Map(
          [
            ...raw.activeLogs(input.scopeId, bounds),
            ...(blockBounds ? raw.activeLogs(input.scopeId, blockBounds) : []),
          ].map((log) => [rawLogKey(log), log]),
        ).values(),
      ]
    : raw.activeLogs(input.scopeId);
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
  for (const log of evidenceLogs)
    events[rawLogKey(log)] = {
      block: log.blockNumber,
      minuteStartSec: times.get(rawLogKey(log))?.minuteStartSec ?? null,
      poolIds: [...(dependencies.get(rawLogKey(log)) ?? [])],
      digest: digest({
        log,
        time: times.get(rawLogKey(log)) ?? null,
        valuation: valuations.get(rawLogKey(log)) ?? null,
      }),
    };
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
export function projectSignals(
  db: Database.Database,
  input: MetricInput,
  config: SignalConfig,
  context: SignalBatchContext,
  liveChanges?: LiveProjectionChanges,
  timings?: BatchTimings,
): AlertRecord[] {
  return db
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
      const report = buildMetricsReport(
        db,
        input,
        liveChanges ? { live: { historyMinutes }, timings } : { timings },
      );
      const configHash = digest({
        signal: signalConfigVersion(config),
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
      const evaluateWindows = () => {
        for (const w of report.windows) {
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
          const decision = evaluateSignal(
            evaluationPrevious,
            {
              pool: w.pool,
              batchId: context.batchId,
              observedAtMs: context.observedAtMs,
              endAnchor: report.at,
              watermarkSec: report.at.timestampSec,
              metrics: w,
              coverage,
              epoch,
              presentation: present(w.poolId, report.at.timestampSec).presentation,
            },
            config,
          );
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
              compactSignalJson(db, {
                matches: decision.matches,
                evaluations: decision.evaluations,
                at: report.at,
                observedAtMs: context.observedAtMs,
                coverage,
              }),
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
}
export function commitAcceptedSignalBatch(
  db: Database.Database,
  input: MetricInput,
  config: SignalConfig,
  batch: RecordedRangeBatch,
  options: { startNewSegment?: boolean; timings?: BatchTimings; registry?: PreparedRegistry } = {},
) {
  if (batch.scopeId !== input.scopeId) throw new Error('Signal batch scope mismatch');
  const { timings } = options;
  return db
    .transaction(() => {
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
