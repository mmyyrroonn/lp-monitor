// Assess one bounded run from recorded evidence; never repairs, replays, or fetches chain data.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { openDatabase } from '../../dist/storage/database.js';
import { saveJson, sha256 } from '../../dist/ops/files.js';
import { encodeJson } from '../../dist/domain/json.js';
import { decodeSignalState } from '../../dist/signals/codec.js';
import { acceptedMetricRanges } from '../../dist/metrics/coverage.js';
import { readBatch } from '../../dist/storage/payload-store.js';

const { values } = parseArgs({ options: {
  manifest: { type: 'string' }, db: { type: 'string' }, out: { type: 'string' },
  'required-seconds': { type: 'string' },
} });
if (!values.manifest || !values.db || !values.out || !/^\d+$/.test(values['required-seconds'] ?? ''))
  throw Error('manifest, db, out and required-seconds are required');
const manifestPath = resolve(values.manifest);
const databasePath = resolve(values.db);
const manifestText = readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(manifestText);
const issues = [];
const issue = value => { if (!issues.includes(value)) issues.push(value); };
let report = null;
try { report = JSON.parse(readFileSync(resolve(dirname(manifestPath), 'ops-report.json'), 'utf8')); }
catch { issue('operations-report-unreadable'); }
const integer = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const block = value => {
  if (typeof value === 'bigint') return value >= 0n ? value.toString() : null;
  if (typeof value === 'number') return integer(value) ? String(value) : null;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return value;
  return null;
};
const sameBlock = (a, b) => block(a) !== null && block(a) === block(b);
const scopeId = typeof manifest.scopeId === 'string' ? manifest.scopeId : '';
const discoveryScope = typeof manifest.discoveryScope === 'string' ? manifest.discoveryScope : '';
if (!scopeId || !discoveryScope || scopeId === discoveryScope || typeof manifest.runId !== 'string' || !manifest.runId)
  issue('manifest-run-identity-invalid');
if (!report || !manifest.telemetry?.report || !isDeepStrictEqual(report, manifest.telemetry.report)
    || report.sourceAlias !== manifest.sourceAlias
    || !finite(report.startedAtMs) || !finite(report.finishedAtMs)
    || report.startedAtMs < manifest.startedAtMs || report.finishedAtMs > manifest.finishedAtMs
    || report.finishedAtMs < report.startedAtMs)
  issue('operations-report-binding-mismatch');

const batches = Array.isArray(manifest.batches) ? manifest.batches : [];
if (!Array.isArray(manifest.batches)) issue('run-batches-missing');
const accepted = batches.filter(b => b.accepted === true);
const unaccepted = batches.filter(b => b.accepted !== true);
const operationBatches = accepted.filter(b => b.scopeId === scopeId);
const discoveryBatches = accepted.filter(b => b.scopeId === discoveryScope);
if (operationBatches.length === 0 || operationBatches.length !== manifest.counts?.operationBatches
    || operationBatches.length !== manifest.follow?.acceptedRanges
    || discoveryBatches.length !== manifest.counts?.discoveryBatches)
  issue('accepted-run-counts-inconsistent');


const db = openDatabase(databasePath, { readonly: true });
let integrity, unresolvedActiveTimes, rawDuplicateIdentities, outboxDuplicateRevisions, activeRawLogs, notifications;
const sentOutbox = [];
const recoveredUnacceptedBatches = [];
const unresolvedUnacceptedBatches = [];
const boundBatchIds = new Set();
const binding = { finalizedRun: false, checkedBatches: 0, invalidatedAcceptedBatches: [], operationCursor: null, discoveryCursor: null };
try {
  // One read transaction prevents mixing database states while a separate owner writes.
  db.exec('BEGIN');
  integrity = db.pragma('integrity_check');
  const count = (sql, ...args) => Number(db.prepare(sql).get(...args).n);
  const run = db.prepare('select id,scope_id,started_at_ms,finished_at_ms,status,payload_json from runs where id=?')
    .get(typeof manifest.runId === 'string' ? manifest.runId : '');
  if (!run) issue('database-run-missing');
  else {
    let payload;
    try { payload = JSON.parse(run.payload_json); } catch { issue('database-run-payload-invalid'); }
    if (run.scope_id !== scopeId || run.status !== 'complete' || run.status !== manifest.status
        || run.started_at_ms !== manifest.startedAtMs || !finite(run.finished_at_ms)
        || run.finished_at_ms < manifest.finishedAtMs || !isDeepStrictEqual(payload, manifest))
      issue('database-run-binding-mismatch');
    else { binding.finalizedRun = true; binding.runPayloadSha256 = sha256(run.payload_json); }
  }
  const cursorFor = scope => db.prepare('select block_number,block_hash,timestamp_sec from scope_cursors where scope_id=?').get(scope);
  const operationCursor = cursorFor(scopeId);
  const discoveryCursor = cursorFor(discoveryScope);
  binding.operationCursor = operationCursor ?? null;
  binding.discoveryCursor = discoveryCursor ?? null;
  const tipBackedByAcceptedBatch = (scope, cursor) => cursor && db.prepare(`select b.id from ingest_batches b
    join accepted_ranges a on a.batch_id=b.id and a.scope_id=b.scope_id
    where b.scope_id=? and b.chain_id=? and b.to_block=? and b.end_hash=? and b.end_timestamp_sec=?
      and b.completeness='complete' and a.to_block=? limit 1`)
    .get(scope, manifest.chainId, cursor.block_number, cursor.block_hash, cursor.timestamp_sec, cursor.block_number);
  if (!operationCursor || !sameBlock(operationCursor.block_number, manifest.acceptedTip?.number)
      || operationCursor.block_hash !== manifest.acceptedTip?.hash
      || operationCursor.timestamp_sec !== manifest.acceptedTip?.timestampSec
      || !tipBackedByAcceptedBatch(scopeId, operationCursor)) issue('operation-cursor-unbound');
  if (!discoveryCursor || !tipBackedByAcceptedBatch(discoveryScope, discoveryCursor))
    issue('discovery-cursor-unbound');

  const ids = new Set();
  for (const batch of batches) {
    if (typeof batch.id !== 'string' || ids.has(batch.id) || ![scopeId, discoveryScope].includes(batch.scopeId)) {
      issue('run-batch-identity-invalid'); continue;
    }
    ids.add(batch.id);
    const stored = db.prepare('select * from ingest_batches where id=?').get(batch.id);
    let payload;
    try { payload = stored ? readBatch(db, batch.id) : null; } catch { /* Missing binding below. */ }
    if (!stored || stored.scope_id !== batch.scopeId || stored.chain_id !== manifest.chainId
        || !sameBlock(stored.from_block, batch.fromBlock) || !sameBlock(stored.to_block, batch.toBlock)
        || stored.manifest_hash !== batch.manifestHash || stored.completeness !== batch.completeness
        || !payload || payload.id !== batch.id || payload.scopeId !== batch.scopeId
        || payload.manifestHash !== batch.manifestHash || !Array.isArray(payload.logs) || payload.logs.length !== batch.logs
        || !sameBlock(payload.end?.number, stored.to_block) || payload.end?.hash !== stored.end_hash)
      issue('database-batch-binding-mismatch');
    else { binding.checkedBatches++; boundBatchIds.add(batch.id); }
    if (batch.accepted === true && !count('select count(*) as n from accepted_ranges where scope_id=? and batch_id=?', batch.scopeId, batch.id)) {
      // An immutable originally accepted batch can lose its active ranges after a recorded reorg.
      const invalidated = stored && count(`select count(*) as n from range_invalidations
        where scope_id=? and from_block<=? and to_block>=?`, batch.scopeId, stored.to_block, stored.from_block);
      if (invalidated && Array.isArray(manifest.revisions) && manifest.revisions.some(r => r.cause !== 'range'))
        binding.invalidatedAcceptedBatches.push(batch.id);
      else issue('accepted-batch-not-active-or-explained');
    }
  }
  // Reuse the production validator: neither bare accepted rows nor failed shards prove recovery.
  const currentRanges = unaccepted.some(b => b.scopeId === scopeId)
    ? acceptedMetricRanges(db, scopeId).sort((a, b) => a.fromBlock < b.fromBlock ? -1 : a.fromBlock > b.fromBlock ? 1 : 0) : [];
  for (const failed of unaccepted) {
    const stored = typeof failed.id === 'string' ? db.prepare('select end_hash,end_timestamp_sec from ingest_batches where id=?').get(failed.id) : null;
    let reason = null;
    let coveredRanges = [];
    let anchors = [];
    if (failed.scopeId !== scopeId) reason = 'discovery-or-unknown-scope';
    else if (!boundBatchIds.has(failed.id) || !binding.finalizedRun || manifest.follow?.complete !== true
      || issues.includes('operation-cursor-unbound') || block(failed.fromBlock) === null || block(failed.toBlock) === null)
      reason = 'unbound-failed-range-or-terminal-run';
    else {
      const from = BigInt(failed.fromBlock), to = BigInt(failed.toBlock);
      if (to < from || BigInt(operationCursor.block_number) < to) reason = 'terminal-tip-before-failed-end';
      else {
        for (const range of currentRanges) {
          const start = range.fromBlock > from ? range.fromBlock : from;
          const end = range.toBlock < to ? range.toBlock : to;
          if (end < start) continue;
          const previous = coveredRanges.at(-1);
          if (previous && start <= previous.toBlock + 1n) previous.toBlock = end > previous.toBlock ? end : previous.toBlock;
          else coveredRanges.push({ fromBlock: start, toBlock: end });
        }
        if (coveredRanges.length !== 1 || coveredRanges[0].fromBlock !== from || coveredRanges[0].toBlock !== to)
          reason = 'current-validated-coverage-has-hole';
        anchors = db.prepare('select distinct block_hash,timestamp_sec from anchors where scope_id=? and block_number=?').all(scopeId, Number(to));
        if (anchors.length > 1) reason = 'current-end-anchor-ambiguous';
      }
    }
    if (reason) { unresolvedUnacceptedBatches.push({ batchId: failed.id, reason, coveredRanges }); continue; }
    recoveredUnacceptedBatches.push({ batchId: failed.id, fromBlock: failed.fromBlock, toBlock: failed.toBlock,
      reason: 'entire failed operation interval is covered by current validated accepted ranges',
      coverageValidator: 'acceptedMetricRanges', coveredRanges, terminalTip: manifest.acceptedTip,
      failedEndAnchor: { blockNumber: failed.toBlock, hash: stored.end_hash,
        relation: anchors.length === 0 ? 'not-observed' : anchors[0].block_hash === stored.end_hash ? 'matches' : 'superseded',
        currentStoredAnchors: anchors, authoritative: false },
      reorgExplanation: anchors.length > 0 && anchors[0].block_hash !== stored.end_hash
        ? 'Failed attempt endpoint differs from current stored branch evidence; recovery is proved by current accepted coverage, not the failed endpoint.' : null });
  }
  if (unresolvedUnacceptedBatches.length > 0) issue('unaccepted-run-batches-require-explanation');
  unresolvedActiveTimes = count(`select count(distinct a.raw_log_id) as n from active_logs a
    left join log_times t on t.scope_id=a.scope_id and t.raw_log_id=a.raw_log_id
    where a.scope_id=? and (t.source is null or t.source='unresolved')`, scopeId);
  rawDuplicateIdentities = count('select count(*) as n from (select raw_key from raw_logs group by raw_key having count(*)>1)');
  outboxDuplicateRevisions = count(`select count(*) as n from (select alert_id,revision from alert_outbox
    where scope_id=? group by alert_id,revision having count(*)>1)`, scopeId);
  activeRawLogs = count('select count(distinct raw_log_id) as n from active_logs where scope_id=?', scopeId);
  notifications = db.prepare('select capture_mode,status,count(*) as n from alert_outbox where scope_id=? group by capture_mode,status').all(scopeId);
  for (const row of db.prepare("select sequence,scope_id,alert_id,revision,attempts,payload_json from alert_outbox where scope_id=? and capture_mode='live' and status='sent' order by sequence").all(scopeId)) {
    try {
      const normalized = JSON.stringify(decodeSignalState(row.payload_json), (_key, value) => typeof value === 'bigint' ? value.toString() : value);
      sentOutbox.push({ sequence: row.sequence, scopeId: row.scope_id, alertId: row.alert_id,
        revision: row.revision, attempts: row.attempts, persistedPayloadSha256: sha256(row.payload_json),
        jsonlPayloadSha256: sha256(normalized), payload: JSON.parse(normalized) });
    } catch { issue('sent-alert-payload-invalid'); }
  }
  if (notifications.some(n => n.capture_mode === 'live' && ['pending', 'failed'].includes(n.status) && n.n > 0))
    issue('live-notifications-pending-or-failed');
} finally { if (db.inTransaction) db.exec('ROLLBACK'); db.close(); }

const elapsedMs = manifest.finishedAtMs - manifest.startedAtMs;
const requiredMs = Number(values['required-seconds']) * 1000;
const localProcessing = report?.latency?.localProcessingMs ?? null;
if (!integer(requiredMs) || requiredMs === 0) issue('required-duration-invalid');
if (!finite(manifest.startedAtMs) || !finite(manifest.finishedAtMs) || !finite(elapsedMs)) issue('observation-duration-unmeasured');
else if (elapsedMs < requiredMs) issue('observation-duration-short');
if (manifest.status !== 'complete') issue('recorder-' + manifest.status);
if (manifest.follow?.complete !== true) issue('follow-not-complete');
if (manifest.discoveryComplete !== true) issue('registry-not-complete');
if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') issue('sqlite-integrity');
if (unresolvedActiveTimes !== 0) issue('active-log-time-unresolved');
if (rawDuplicateIdentities !== 0 || outboxDuplicateRevisions !== 0) issue('duplicate-identities');
if (!integer(localProcessing?.sampleSize) || localProcessing.sampleSize === 0 || !finite(localProcessing.p95))
  issue('local-processing-unmeasured');
else if (localProcessing.p95 > 2000) issue('local-processing-p95-above-2s');
if (manifest.alertDelivery?.status !== 'ok') issue('local-notification-degraded');
const meter = manifest.meter;
if (!integer(meter?.peakOneSecond) || !integer(meter?.peakConcurrentRpc) || !integer(meter?.backfillPeakOneSecond)
    || !integer(meter?.calls) || meter.calls === 0 || !integer(meter?.maxCalls) || meter.maxCalls === 0
    || (meter.calls > 0 && (meter.peakOneSecond === 0 || meter.peakConcurrentRpc === 0))) issue('rpc-budget-unmeasured');
if (meter?.peakOneSecond > 5 || meter?.peakConcurrentRpc > 2 || meter?.backfillPeakOneSecond > 1 || meter?.calls > meter?.maxCalls)
  issue('rpc-budget-exceeded');

const result = {
  version: 2, assessedAtMs: Date.now(), status: issues.length === 0 ? 'passed' : 'incomplete', issues,
  runId: manifest.runId, sourceAlias: manifest.sourceAlias, chainId: manifest.chainId,
  manifestPath, databasePath, snapshotDatabasePath: databasePath, manifestSha256: sha256(manifestText), requestedObservationMs: requiredMs, elapsedMs,
  identity: manifest.identity, scopeId, acceptedTip: manifest.acceptedTip, binding,
  acceptedBatches: accepted.length, unacceptedBatches: unaccepted.length, recoveredUnacceptedBatches, unresolvedUnacceptedBatches, activeRawLogs,
  integrity, unresolvedActiveTimes, rawDuplicateIdentities, outboxDuplicateRevisions, notifications, sentOutbox,
  failuresRecorded: manifest.failures, follow: manifest.follow, alertDelivery: manifest.alertDelivery,
  measured: report, meter, counts: manifest.counts,
  memory: manifest.telemetry?.memory ?? null, cpuUsageMicros: manifest.telemetry?.cpuUsageMicros ?? null,
  realReorgObserved: (manifest.follow?.reorgs ?? 0) > 0,
  replayComparison: 'incomplete: native portable input export/cross-stream revision order unavailable',
  limits: ['RPC filter completeness is not independent full-chain verification.',
    'Threshold efficacy and LP net returns remain unverified.',
    'No genuine alert delivery sample is invented when the market produces no alert.',
    'Unknown provider billing units/rates remain null; only measured use is reported.'],
};
const output = resolve(values.out);
saveJson(output, result, dirname(output));
console.log(encodeJson({ output, status: result.status, issues, elapsedMs, localProcessing,
  calls: meter?.calls ?? null, responseBytes: meter?.responseBytes ?? null, activeRawLogs, notifications }));
process.exitCode = issues.length === 0 ? 0 : 4;
