// Aggregate already-verified local stage reports. No RPC, migrations, replay, or notifications.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { saveJson, sha256 } from '../../dist/ops/files.js';
const root = resolve('artifacts/p6');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const ref = path => ({ path, sha256: sha256(readFileSync(path)) });
const sumBytes = path => statSync(path).isDirectory()
  ? readdirSync(path).reduce((sum, entry) => sum + sumBytes(join(path, entry)), 0)
  : statSync(path).size;
const percentile = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return { sampleSize: sorted.length, p95: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null };
};
function codeSnapshot(name, expectedStage = name, runWindow = null, captureRelation = 'before-run') {
  const path = join(root, name + '-code.json');
  const snapshot = read(path);
  const validTime = runWindow === null || (Number.isFinite(snapshot.capturedAtMs) &&
    (captureRelation === 'before-run'
      ? snapshot.capturedAtMs <= runWindow.startedAtMs
      : captureRelation === 'during-run'
        ? snapshot.capturedAtMs >= runWindow.startedAtMs && snapshot.capturedAtMs <= runWindow.finishedAtMs
        : false));
  if (snapshot.stage !== expectedStage || typeof snapshot.fingerprint !== 'string' ||
      !Array.isArray(snapshot.files) || snapshot.fingerprint !== sha256(JSON.stringify(snapshot.files)) || !validTime)
    throw Error(name + ': invalid code snapshot binding');
  return { evidence: ref(path), fingerprint: snapshot.fingerprint, capturedAtMs: snapshot.capturedAtMs,
    nodeVersion: snapshot.nodeVersion, files: snapshot.files.length, captureRelation,
    attestationNote: captureRelation === 'during-run'
      ? 'During-run workspace build inventory; it does not independently attest every module loaded by the smoke process.'
      : 'Pre-run frozen build inventory captured no later than run start.',
    note: snapshot.note };
}
function meterSummary(name, evidence, meter, classification) {
  if (!meter || !Number.isInteger(meter.calls) || meter.calls < 0) throw Error(name + ': invalid meter');
  return { name, classification, evidence, calls: meter.calls, retries: meter.retries,
    responseBytes: meter.responseBytes, rpcMs: meter.timings?.rpcMs ?? null, methods: meter.methods };
}
function aggregateMeters(entries) {
  const methods = {};
  let calls = 0, retries = 0, responseBytes = 0, rpcMs = 0;
  for (const entry of entries) {
    calls += entry.calls; retries += entry.retries; responseBytes += entry.responseBytes;
    if (entry.rpcMs !== null) rpcMs += entry.rpcMs;
    for (const [method, count] of Object.entries(entry.methods ?? {})) methods[method] = (methods[method] ?? 0) + count;
  }
  return { calls, retries, responseBytes, rpcMs, methods,
    noDuplicationBasis: 'Each entry is a distinct invocation bound to its own immutable report or manifest evidence.' };
}
function resources(stage, manifest) {
  const path = join(root, stage + '-resources.jsonl');
  if (!existsSync(path)) return { status: 'unmeasured', samples: 0 };
  const samples = readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  if (samples.some(x => !Number.isFinite(Date.parse(x.at)) || Date.parse(x.at) < manifest.startedAtMs || Date.parse(x.at) > manifest.finishedAtMs || !Number.isFinite(x.rssBytes) || !Number.isFinite(x.privateBytes) || !Number.isFinite(x.cpuSeconds))) throw Error(stage + ': invalid resource sample');
  const first = samples[0], last = samples.at(-1);
  const elapsedSeconds = first && last ? (Date.parse(last.at) - Date.parse(first.at)) / 1000 : 0;
  const cpuSeconds = first && last ? last.cpuSeconds - first.cpuSeconds : null;
  return { evidence: ref(path), samples: samples.length, first, last, elapsedSeconds,
    cpuSecondsDuringSamples: cpuSeconds,
    cpuFractionOfOneCore: elapsedSeconds > 0 && cpuSeconds !== null ? cpuSeconds / elapsedSeconds : null,
    rssBytes: percentile(samples.map(x => x.rssBytes)), maxRssBytes: samples.length ? Math.max(...samples.map(x => x.rssBytes)) : null,
    privateBytes: percentile(samples.map(x => x.privateBytes)),
    rssNetGrowthBytes: first && last ? last.rssBytes - first.rssBytes : null,
    note: 'Windows process samples every 30s; RSS/private bytes include allocator and cache. Net change alone does not prove a memory leak or its absence.' };
}
function bindAssessment(name, assessment, manifest) {
  if (assessment.manifestSha256 !== sha256(readFileSync(assessment.manifestPath, 'utf8')))
    throw Error(name + ': manifest changed after assessment');
  if (['runId','chainId','scopeId','sourceAlias'].some(key => assessment[key] !== manifest[key]) ||
      typeof manifest.runId !== 'string' || !manifest.runId ||
      !Number.isFinite(manifest.startedAtMs) || !Number.isFinite(manifest.finishedAtMs) ||
      manifest.finishedAtMs < manifest.startedAtMs || assessment.elapsedMs !== manifest.finishedAtMs - manifest.startedAtMs)
    throw Error(name + ': invalid run identity/time binding');
  if (!isDeepStrictEqual(assessment.measured, manifest.telemetry?.report) ||
      !isDeepStrictEqual(assessment.meter, manifest.meter)) throw Error(name + ': report or meter mismatch');
  if (!Array.isArray(assessment.issues)) throw Error(name + ': missing assessment issues');
}
function stage(name) {
  const path = join(root, name + '-report.json');
  const assessment = read(path);
  const manifest = read(assessment.manifestPath);
  bindAssessment(name, assessment, manifest);
  const requiredMs = name === 'smoke' ? 1800000 : 7200000;
  if (assessment.requestedObservationMs !== requiredMs || manifest.requestedDurationMs !== requiredMs || !Number.isFinite(assessment.elapsedMs) || assessment.elapsedMs < requiredMs) throw Error(name + ': wrong observation duration');
  if (assessment.manifestSha256 !== sha256(readFileSync(assessment.manifestPath, 'utf8')))
    throw Error(name + ': manifest changed after assessment');
  if (!isDeepStrictEqual(assessment.measured, manifest.telemetry?.report)) throw Error(name + ': report mismatch');
  const samples = manifest.telemetry.healthSamples;
  const heads = samples.filter(x => x.head && Number.isFinite(x.head.timestampSec));
  const first = heads[0]?.head, last = heads.at(-1)?.head;
  const chainSeconds = first && last ? last.timestampSec - first.timestampSec : 0;
  const minuteCalls = manifest.meter.purposes['minute-boundary']?.calls ?? 0;
  return { evidence: ref(path), runWindow: { startedAtMs: manifest.startedAtMs, finishedAtMs: manifest.finishedAtMs }, code: codeSnapshot(name, name, manifest, name === 'smoke' ? 'during-run' : 'before-run'), assessment, resources: resources(name, manifest),
    runArtifactBytes: sumBytes(dirname(assessment.manifestPath)),
    observedChainBlocksPerSecond: chainSeconds > 0 ? Number(BigInt(last.blockNumber) - BigInt(first.blockNumber)) / chainSeconds : null,
    headObservationAgeMs: percentile(samples.map(x => x.headObservationAgeMs)),
    headAcquisitionLagMs: percentile(manifest.telemetry.batchTimings.map(x => x.headAcquisitionLagMs)),
    minuteBoundaryCalls: minuteCalls,
    minuteBoundaryCallsPerObservedMinute: chainSeconds > 0 ? minuteCalls * 60 / chainSeconds : null,
    phaseTimeNote: 'Requested duration includes startup and catch-up; report.usage.steady.durationMs is the measured steady phase only.' };
}
const smoke = stage('smoke'), soak = stage('soak');
const failedSoaks = readdirSync(root).flatMap(file => {
  const match = /^soak-failed-([1-9]\d*)-report\.json$/.exec(file);
  return match ? [{ file, attempt: Number(match[1]) }] : [];
}).sort((a,b) => a.attempt - b.attempt).map(({file,attempt}) => {
  if (!Number.isSafeInteger(attempt)) throw Error('Invalid failed attempt number');
  const name = 'soak-failed-' + attempt, path = join(root,file);
  const assessment = read(path), manifest = read(assessment.manifestPath);
  bindAssessment(name,assessment,manifest);
  if (assessment.status !== 'incomplete' || assessment.issues.length === 0 ||
      !['complete','failed','incomplete','stopped'].includes(manifest.status) ||
      assessment.requestedObservationMs !== 7200000 || manifest.requestedDurationMs !== 7200000)
    throw Error(name + ': invalid incomplete attempt evidence');
  return { attempt, classification: 'failed-diagnostic-history', acceptedStage: false,
    evidence: ref(path), code: codeSnapshot(name,'soak',manifest,'before-run'),
    runWindow: { startedAtMs: manifest.startedAtMs, finishedAtMs: manifest.finishedAtMs },
    assessment, resources: resources(name,manifest), runArtifactBytes: sumBytes(dirname(assessment.manifestPath)),
    note: 'Retained incomplete attempt, excluded from stage acceptance; its measured usage is counted exactly once.' };
});
const orderedStages = [smoke,...failedSoaks,soak];
const runIds = new Set();
for (let i=0;i<orderedStages.length;i++) {
  const current = orderedStages[i];
  if (runIds.has(current.assessment.runId) ||
      ['chainId','scopeId','sourceAlias'].some(key => current.assessment[key] !== smoke.assessment[key]) ||
      (i>0 && orderedStages[i-1].runWindow.finishedAtMs > current.runWindow.startedAtMs))
    throw Error('All stages and failed attempts must be distinct, chronological and bound to the same chain/scope/source');
  runIds.add(current.assessment.runId);
}
const reproductionPath = join(root, 'save-raw-reproduction/report.json');
const reproduction = read(reproductionPath);
const fixVerificationPath = join(root, 'save-raw-reproduction/fix-verification.json');
const fixVerification = read(fixVerificationPath);
if (reproduction.saveResult?.status !== 'error' || fixVerification.status !== 'passed')
  throw Error('raw timestamp drift diagnosis/fix verification is incomplete');
const diagnosis = { classification: 'diagnostic-history', acceptedStage: false,
  reproduction: { evidence: ref(reproductionPath), conflicts: reproduction.conflicts, saveResult: reproduction.saveResult, meter: reproduction.meter },
  fixVerification: { evidence: ref(fixVerificationPath), ...fixVerification },
  requests: ref(join(root, 'save-raw-reproduction/requests.jsonl')) };
const preflightPath = join(root, 'preflight.json');
const preflight = read(preflightPath);
const bootstrapHeadPath = join(root, 'bootstrap-head.json');
const bootstrapHead = read(bootstrapHeadPath);
const bootstrapPath = join(root, 'runs/2026-09-10T10-07-23-412Z-3e3b6314/manifest.json');
const bootstrap = read(bootstrapPath);
if (typeof bootstrap.runId !== 'string' || !bootstrap.runId || runIds.has(bootstrap.runId) ||
    ['chainId','scopeId','sourceAlias'].some(key => bootstrap[key] !== smoke.assessment[key]) ||
    !Number.isFinite(bootstrap.finishedAtMs) || bootstrap.finishedAtMs > smoke.runWindow.startedAtMs)
  throw Error('Bootstrap must be distinct and precede observation stages on the same chain/scope/source');
runIds.add(bootstrap.runId);
const comparisonPath = join(root, 'comparison-2026-09-10T10-15-17-902Z/report.json');
const comparison = read(comparisonPath);
const verificationPath = join(root, 'offline-verification.json');
const verification = read(verificationPath);
const alertPath = resolve('data/p6.sqlite.alerts.jsonl');
const alerts = existsSync(alertPath) ? readFileSync(alertPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
const keys = alerts.map(x => String(x.id) + '/' + String(x.revision));
const duplicateFileRecords = keys.length - new Set(keys).size;
const sentOutbox = soak.assessment.sentOutbox;
if (!Array.isArray(sentOutbox)) throw Error('Missing terminal sent-outbox evidence');
const fileByKey = new Map(alerts.map(x => [String(x.id) + '/' + String(x.revision), x]));
const missingSentRecords = sentOutbox.filter(x => !fileByKey.has(String(x.alertId) + '/' + String(x.revision)));
const unexpectedFileRecords = alerts.filter(x => !sentOutbox.some(row => row.alertId === x.id && row.revision === x.revision));
const mismatchedSentRecords = sentOutbox.filter(row => { const payload = fileByKey.get(String(row.alertId) + '/' + String(row.revision)); return payload && (!isDeepStrictEqual(payload, row.payload) || sha256(JSON.stringify(payload)) !== row.jsonlPayloadSha256); });
const fieldIssues = alerts.filter(x => typeof x.id !== 'string' || !Number.isInteger(x.revision) || !x.kind).length;
const rpcAccounting = [
  meterSummary('preflight/probe', ref(preflightPath), preflight.meter, 'setup'),
  meterSummary('bootstrap-head-reader', ref(bootstrapHeadPath), bootstrapHead.meter, 'setup'),
  meterSummary('bootstrap', ref(bootstrapPath), bootstrap.meter, 'setup'),
  meterSummary('comparison', ref(comparisonPath), comparison.meter, 'comparison'),
  meterSummary('smoke', smoke.evidence, smoke.assessment.meter, smoke.assessment.status === 'passed' ? 'accepted-stage' : 'incomplete-stage'),
  ...failedSoaks.map(failed => meterSummary('failed-soak-attempt-' + failed.attempt, failed.evidence, failed.assessment.meter, 'failed-diagnostic-history')),
  meterSummary('raw-timestamp-reproduction', ref(reproductionPath), reproduction.meter, 'diagnostic-reproduction'),
  meterSummary('final-soak-retry', soak.evidence, soak.assessment.meter, soak.assessment.status === 'passed' ? 'accepted-stage' : 'incomplete-stage'),
];
if (new Set(rpcAccounting.map(x => x.evidence.path)).size !== rpcAccounting.length)
  throw Error('Duplicate invocation evidence in RPC accounting');
const issues = [
  ...(smoke.assessment.status === 'passed' ? [] : ['smoke-incomplete']),
  ...(soak.assessment.status === 'passed' ? [] : ['soak-incomplete']),
  ...(bootstrap.status === 'complete' ? [] : ['bootstrap-incomplete']),
  ...(comparison.status === 'complete' ? [] : ['comparison-incomplete']),
  ...(verification.status === 'passed' ? [] : ['offline-verification-incomplete']),
  ...(duplicateFileRecords || fieldIssues || missingSentRecords.length || unexpectedFileRecords.length || mismatchedSentRecords.length ? ['notification-file-integrity'] : []),
];
const report = { version: 3, generatedAtMs: Date.now(), status: issues.length ? 'incomplete' : 'passed', issues,
  scope: 'P6 bounded local read-only engineering acceptance',
  offline: { evidence: ref(verificationPath), ...verification },
  bootstrapHead: { evidence: ref(bootstrapHeadPath), head: bootstrapHead.head, meter: bootstrapHead.meter },
  bootstrap: { evidence: ref(bootstrapPath), status: bootstrap.status, meter: bootstrap.meter, measured: bootstrap.telemetry.report },
  comparison: { evidence: ref(comparisonPath), ...comparison }, smoke, soak,
  historicalAttempts: { failedSoaks }, diagnostics: { rawTimestampDrift: diagnosis },
  rpcAccounting: { entries: rpcAccounting, total: aggregateMeters(rpcAccounting), monetaryCost: null },
  notifications: { evidence: existsSync(alertPath) ? ref(alertPath) : null, fileRecords: alerts.length, confirmedSentOutboxRecords: sentOutbox.length, missingSentRecords: missingSentRecords.length, unexpectedFileRecords: unexpectedFileRecords.length, mismatchedSentRecords: mismatchedSentRecords.length,
    duplicateIdRevisions: duplicateFileRecords, duplicateRate: alerts.length ? duplicateFileRecords / alerts.length : null,
    invalidRequiredFields: fieldIssues, limitation: 'No-alert period has no empirical delivery-rate or latency sample; fixture checks cover sink behavior.' },
  boundaries: ['Observed RPC filter contract is not independent full-chain coverage verification.',
    'Only AMC, its registered/dynamically associated pools, and USDG valuation are configured.',
    'Native portable replay input export/cross-stream order is unavailable; recorded-observed comparison remains incomplete.',
    'No real-chain reorg is claimed unless recorded in a stage. Fixtures are separate evidence.',
    'Threshold efficacy, full historical coverage and LP net returns remain unverified.'],
};
// The stage assessment file uses soak-report.json; the aggregate has a distinct filename.
saveJson(join(root, 'acceptance.json'), report, root);
saveJson(join(root, 'cost-report.json'), { version: 3, generatedAtMs: report.generatedAtMs,
  sourceAlias: soak.assessment.sourceAlias, monetaryCost: null, verifiedRates: null,
  note: 'Measured methods/elements/bytes and local disk only. No provider billing unit/rate supplied; no monetary extrapolation.',
  rpcAccounting: { entries: rpcAccounting, total: aggregateMeters(rpcAccounting),
    acceptedStageCalls: rpcAccounting.filter(x => x.classification === 'accepted-stage').reduce((sum, x) => sum + x.calls, 0),
    diagnosticCalls: rpcAccounting.filter(x => x.classification.includes('diagnostic')).reduce((sum, x) => sum + x.calls, 0) },
  bootstrapHead: { evidence: ref(bootstrapHeadPath), meter: bootstrapHead.meter },
  initialBackfill: { evidence: ref(bootstrapPath), meter: bootstrap.meter, usage: bootstrap.telemetry.report.usage, disk: bootstrap.telemetry.report.disk },
  smoke: { evidence: smoke.evidence, code: smoke.code, usage: smoke.assessment.measured.usage, disk: smoke.assessment.measured.disk, runArtifactBytes: smoke.runArtifactBytes, resources: smoke.resources },
  failedSoakAttempts: failedSoaks.map(failed => ({ attempt: failed.attempt, evidence: failed.evidence, code: failed.code, acceptedStage: false, runWindow: failed.runWindow, elapsedMs: failed.assessment.elapsedMs, issues: failed.assessment.issues, meter: failed.assessment.meter, resources: failed.resources })),
  rawTimestampReproduction: { evidence: ref(reproductionPath), acceptedStage: false, meter: reproduction.meter, fixVerification: ref(fixVerificationPath) },
  soak: { evidence: soak.evidence, code: soak.code, usage: soak.assessment.measured.usage, disk: soak.assessment.measured.disk, runArtifactBytes: soak.runArtifactBytes, resources: soak.resources },
  diskNote: 'Phase database growth is main+WAL measured growth. Run artifact footprint is reported separately. Snapshot backup copies are excluded from runtime footprint.' }, root);
console.log(JSON.stringify({ status: report.status, issues, output: join(root, 'acceptance.json') }));
process.exitCode = issues.length ? 4 : 0;
