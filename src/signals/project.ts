import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { encodeJson } from '../domain/json.js';
import type { BlockAnchor } from '../domain/types.js';
import { poolRegistrationId } from '../registry/pools.js';
import { SqliteRangeStore } from '../storage/raw-store.js';
import { SqliteProjectionStore } from '../storage/projection-store.js';
import {
  buildMetricsReport,
  type MetricInput,
  type MetricsReport,
} from '../storage/metric-store.js';
import type { RecordedRangeBatch } from '../storage/manifest.js';
import { rawLogKey } from '../storage/manifest.js';
import { AlertOutbox, type CaptureMode } from '../notify/outbox.js';
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
  block: bigint;
  digest: string;
  complete?: boolean;
  ordinaryCurrentPartial?: boolean;
};
type Evidence = {
  events: Record<string, EvidenceItem>;
  closedCoverage: Record<string, EvidenceItem>;
  pools: Record<string, EvidenceItem>;
};
type Cursor = {
  config_hash: string;
  source_hash: string;
  epoch: string;
  block_number: string;
  block_hash: string;
  evidence_json: string;
};
const digest = (v: unknown) => createHash('sha256').update(encodeJson(v)).digest('hex');

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
  const prior = db
    .prepare('select revision,payload_json from alerts where scope_id=? and id=?')
    .get(scopeId, draft.id) as { revision: number; payload_json: string } | undefined;
  const proposed: AlertRecord = { ...draft, ...(provenance ? { provenance } : {}) };
  if (prior) {
    const old = decodeSignalState<AlertRecord>(prior.payload_json);
    const { revision: _oldRevision, ...oldComparable } = old;
    const { revision: _proposedRevision, ...proposedComparable } = proposed;
    if (isDeepStrictEqual(oldComparable, proposedComparable)) return null;
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
  db.prepare(
    `insert into alerts(scope_id,id,revision,capture_mode,active,payload_json) values(?,?,?,?,?,?)
    on conflict(scope_id,id) do update set revision=excluded.revision,capture_mode=excluded.capture_mode,active=excluded.active,payload_json=excluded.payload_json`,
  ).run(scopeId, record.id, record.revision, mode, active ? 1 : 0, encodeSignalState(record));
  new AlertOutbox(db).enqueue(scopeId, record, mode);
}

/** Conservative invalidation: all reminders at/after changed history lose their
 * provisional evidence. Re-evaluate current conditions under a new epoch.
 * Does not claim the historical condition was definitely false. P5 may add
 * precise historical replay, but unverified old notifications must not survive. */
export function retractSignals(
  db: Database.Database,
  scopeId: string,
  context: SignalBatchContext,
  reason: string,
  fromBlock = 0n,
): AlertRecord[] {
  return db.transaction(() => {
    const rows = db
      .prepare('select capture_mode,payload_json from alerts where scope_id=? and active=1')
      .all(scopeId) as { capture_mode: CaptureMode; payload_json: string }[];
    const records: AlertRecord[] = [];
    for (const row of rows) {
      const prior = decodeSignalState<AlertRecord>(row.payload_json);
      if (prior.endAnchor.number < fromBlock) continue;
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
    db.prepare('delete from signal_snapshots where scope_id=?').run(scopeId);
    db.prepare('delete from signal_cursors where scope_id=?').run(scopeId);
    return records;
  })();
}
function readEvidence(db: Database.Database, input: MetricInput, report: MetricsReport): Evidence {
  const raw = new SqliteRangeStore(db);
  const times = raw.logTimes(input.scopeId);
  const events: Evidence['events'] = {};
  for (const log of raw.activeLogs(input.scopeId))
    events[rawLogKey(log)] = {
      block: log.blockNumber,
      digest: digest({ log, time: times.get(rawLogKey(log)) ?? null }),
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
  for (const p of [...raw.pools(input.registryScopeId), ...raw.pools(input.scopeId)])
    pools[poolRegistrationId(p)] = { block: p.discoveredAt.blockNumber, digest: digest(p) };
  return { events, closedCoverage, pools };
}
function repairedFrom(old: Evidence, current: Evidence, tip: bigint): bigint | null {
  let from: bigint | null = null;
  const add = (block: bigint) => {
    if (from === null || block < from) from = block;
  };
  for (const group of ['events', 'pools', 'closedCoverage'] as const) {
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
      if (!now || now.digest !== item.digest) add(item.block);
    }
    if (group !== 'closedCoverage')
      for (const [id, item] of Object.entries(current[group]))
        if (!old[group][id] && item.block <= tip) add(item.block);
  }
  return from;
}
function presentation(
  report: MetricsReport,
  w: MetricsReport['windows'][number],
  input: MetricInput,
): SignalInput['presentation'] {
  const rwa = report.rwa.find((r) => r.poolIds.includes(w.poolId));
  const annotation = report.annotations.find((a) => a.poolId === w.poolId);
  const tokens = annotation ? [annotation.pair.token0, annotation.pair.token1] : [];
  const names = tokens.map((t) =>
    t === input.usdg ? 'USDG' : (input.assets.assets.find((a) => a.address === t)?.symbol ?? t),
  );
  const start = Math.floor(report.at.timestampSec / 300) * 300 - 300;
  const local = report.valuations.filter(
    (v) =>
      poolRegistrationId(v) === w.poolId &&
      v.time.minuteStartSec !== null &&
      v.time.minuteStartSec >= start,
  );
  const txs = [...new Set(local.map((v) => v.transactionHash))];
  const cooccurring = new Set<string>();
  for (const v of report.valuations)
    if (txs.includes(v.transactionHash)) {
      const a = report.annotations.find((x) => x.poolId === poolRegistrationId(v));
      for (const t of a ? [a.pair.token0, a.pair.token1] : [])
        if (t !== input.usdg && !input.assets.has(t)) cooccurring.add(t);
    }
  return {
    rwaSymbol: rwa?.asset.symbol ?? 'unknown',
    pairLabel: names.join(' / '),
    associatedTokens: [...cooccurring],
    evidenceTxs: txs,
    liquidityNote: annotation ? encodeJson(annotation.lastSwap) : 'unknown',
  };
}
export function projectSignals(
  db: Database.Database,
  input: MetricInput,
  config: SignalConfig,
  context: SignalBatchContext,
): AlertRecord[] {
  return db
    .transaction(() => {
      const report = buildMetricsReport(db, input); // Enforces fresh P2, never reads cached metric_windows.
      const configHash = digest({
        signal: signalConfigVersion(config),
        chain: input.configVersion,
        metadata: input.metadata,
        usdg: input.usdg,
        assets: input.assets.assets,
        metricVersion: report.version,
      });
      const old = db.prepare('select * from signal_cursors where scope_id=?').get(input.scopeId) as
        Cursor | undefined;
      if (old && old.config_hash === configHash && old.source_hash === report.sourceHash) return [];
      const evidence = readEvidence(db, input, report);
      let repair: bigint | null = null;
      if (old) {
        if (old.config_hash !== configHash) repair = 0n;
        else {
          repair = repairedFrom(
            decodeSignalState<Evidence>(old.evidence_json),
            evidence,
            BigInt(old.block_number),
          );
          if (
            report.at.number < BigInt(old.block_number) ||
            (report.at.number === BigInt(old.block_number) && report.at.hash !== old.block_hash)
          )
            repair =
              repair === null
                ? report.at.number
                : repair < report.at.number
                  ? repair
                  : report.at.number;
        }
      }
      const records =
        repair === null
          ? []
          : retractSignals(db, input.scopeId, context, 'source-history-revised', repair);
      const epoch =
        repair === null && old
          ? old.epoch
          : digest({ source: report.sourceHash, configHash, batch: context.batchId });
      for (const w of report.windows) {
        const row = db
          .prepare('select payload_json from signal_snapshots where scope_id=? and pool_id=?')
          .get(input.scopeId, w.poolId) as { payload_json: string } | undefined;
        const previous = row
          ? decodeSignalState<SignalSnapshot>(row.payload_json)
          : initialSignalSnapshot();
        const coverage =
          w.partialCurrent?.status === 'partial'
            ? 'complete'
            : w.partialCurrent?.status === 'gap'
              ? 'gap'
              : 'warming';
        const decision = evaluateSignal(
          previous,
          {
            pool: w.pool,
            batchId: context.batchId,
            observedAtMs: context.observedAtMs,
            endAnchor: report.at,
            watermarkSec: report.at.timestampSec,
            metrics: w,
            coverage,
            epoch,
            presentation: presentation(report, w, input),
          },
          config,
        );
        db.prepare(
          `insert into signal_snapshots(scope_id,pool_id,payload_json) values(?,?,?)
        on conflict(scope_id,pool_id) do update set payload_json=excluded.payload_json`,
        ).run(input.scopeId, w.poolId, encodeSignalState(decision.nextSnapshot));
        db.prepare(
          `insert into signal_evaluations(scope_id,batch_id,source_hash,pool_id,payload_json) values(?,?,?,?,?)
        on conflict(scope_id,batch_id,source_hash,pool_id) do nothing`,
        ).run(
          input.scopeId,
          context.batchId,
          report.sourceHash,
          w.poolId,
          encodeSignalState({
            matches: decision.matches,
            at: report.at,
            observedAtMs: context.observedAtMs,
            coverage,
          }),
        );
        const record = commitSignalDecision(db, input.scopeId, decision, context.captureMode, {
          metricSourceHash: report.sourceHash,
          projectionSourceHash: report.projectionSourceHash,
          metricVersion: report.version,
          chainConfigVersion: report.configVersion,
          assetVersion: report.assetVersion,
          metadataVersion: report.metadata.version,
          evidenceEventIds: report.valuations
            .filter(
              (v) =>
                poolRegistrationId(v) === w.poolId &&
                v.time.minuteStartSec !== null &&
                v.time.minuteStartSec >= Math.floor(report.at.timestampSec / 300) * 300 - 300,
            )
            .map((v) => v.eventId),
        });
        if (record) records.push(record);
      }
      db.prepare(
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
      return records;
    })
    .immediate();
}
export function commitAcceptedSignalBatch(
  db: Database.Database,
  input: MetricInput,
  config: SignalConfig,
  batch: RecordedRangeBatch,
) {
  if (batch.scopeId !== input.scopeId) throw new Error('Signal batch scope mismatch');
  return db
    .transaction(() => {
      const changes = new SqliteRangeStore(db).acceptRange(batch);
      new SqliteProjectionStore(db).rebuild(
        input.scopeId,
        input.registryScopeId,
        input.configVersion,
      );
      const alerts = projectSignals(db, input, config, {
        batchId: batch.id,
        observedAtMs: batch.observedAtMs,
        captureMode: batch.captureMode,
      });
      return { changes, alerts };
    })
    .immediate();
}
