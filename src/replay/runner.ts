import type { PoolEvent } from '../domain/types.js';
import type { PersistedPoolRegistration } from '../storage/manifest.js';
import { rawLogKey } from '../storage/manifest.js';
import type { MetricEvent, MinuteCoverage } from '../metrics/windows.js';
import { readMetricCoverage } from '../metrics/coverage.js';
import { PoolRegistry, poolRegistrationId } from '../registry/pools.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../storage/database.js';
import { SqliteRangeStore } from '../storage/raw-store.js';
import { IncompleteRangeError } from '../ingest/completeness.js';
import { SqliteProjectionStore, NoAcceptedScopeError } from '../storage/projection-store.js';
import {
  buildMetricsReport,
  type MetricsReport,
  type MetricInput,
} from '../storage/metric-store.js';
import { commitAcceptedSignalBatch, commitSignalDecision } from '../signals/project.js';
import { evaluateSignal, initialSignalSnapshot } from '../signals/engine.js';
import { parseSignalConfig, type SignalConfig } from '../signals/config.js';
import type { AlertRecord, SignalSnapshot } from '../signals/types.js';
import { encodeJson } from '../domain/json.js';
import { readReplayManifest, readCatalogue, contentHash, assetRegistry } from './reader.js';
import { checkBatchIntegrity, checkMinuteIntegrity, type ReplayIssue } from './integrity.js';
import { minutePrefixes, prefixAt, mergeHistoricalBatches, type ReplayMode } from './clock.js';
export interface ReplayFrame {
  batchId: string;
  observedAtMs: number;
  evaluatedAtSec: number;
  metrics: MetricsReport;
  alerts: AlertRecord[];
}
export interface ReplayReport {
  registrationTimes: { poolId: string; creationMinuteStartSec: number | null }[];
  discoveryMinutes: MinuteCoverage[];
  registrations: PersistedPoolRegistration[];
  events: PoolEvent[];
  metricEvents: MetricEvent[];
  coverage: MinuteCoverage[];
  discoveryCoverage: { verified: false; integrityComplete: boolean; reason: string };
  finalMetrics: MetricsReport | null;
  version: 'p5-replay-v1';
  replayRunId: string;
  mode: ReplayMode;
  status: 'complete' | 'incomplete';
  coverageVerified: false;
  provenance: {
    manifestHash: string;
    rawHash: string;
    minuteIndexHash: string;
    configHash: string;
    abiHash: string;
    codeHash: string;
    cohortMode: 'as-of' | 'retrospective-cohort' | 'unavailable';
    availableAtSec: number | null;
  };
  integrity: { complete: boolean; issues: ReplayIssue[] };
  frames: ReplayFrame[];
  alerts: AlertRecord[];
  alertRevisions: AlertRecord[];
  businessHash: string;
  outputDirectory?: string;
}
function sourceHashes() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const collect = (dir: string): { path: string; content: string }[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? collect(join(dir, e.name))
        : /\.(ts|js|sql)$/.test(e.name) && !e.name.endsWith('.d.ts')
          ? [
              {
                path: join(dir, e.name).replaceAll('\\', '/'),
                content: readFileSync(join(root, dir, e.name), 'utf8'),
              },
            ]
          : [],
    );
  const files = [
    'replay',
    'signals',
    'metrics',
    'storage',
    'protocols',
    'registry',
    'state',
    'domain',
    'ingest',
  ]
    .flatMap((dir) => collect(dir))
    .sort((a, b) => a.path.localeCompare(b.path));
  const abi = files.filter((f) => /\/abi\.(ts|js)$/.test(f.path));
  if (!files.length || !abi.length) throw new Error('Replay implementation source unavailable');
  return { files, codeHash: contentHash(files), abiHash: contentHash(abi) };
}
export async function replay(
  manifestPath: string,
  config: SignalConfig,
  mode: ReplayMode,
  options: { outDirectory?: string } = {},
): Promise<ReplayReport> {
  if (!['minute-close', 'recorded-observed'].includes(mode)) throw new Error('Invalid replay mode');
  config = parseSignalConfig(config);
  const read = readReplayManifest(manifestPath);
  let discoveryMinutes: MinuteCoverage[] = [];
  let fullCoverage: MinuteCoverage[] = [];
  let registrationTimes: { poolId: string; creationMinuteStartSec: number | null }[] = [];
  let registrations: PersistedPoolRegistration[] = [];
  let events: PoolEvent[] = [];
  let metricEvents: MetricEvent[] = [];
  const issues = [...read.issues];
  const frames: ReplayFrame[] = [];
  const snapshot = read.manifest.replay?.input;
  const source = sourceHashes();
  const provenance = {
    manifestHash: read.manifestHash,
    rawHash: contentHash(read.files),
    minuteIndexHash: contentHash(
      read.batches.map((b) => ({ id: b.id, logTimes: b.logTimes, boundaries: b.boundaries })),
    ),
    configHash: contentHash(config),
    codeHash: source.codeHash,
    abiHash: source.abiHash,
    cohortMode: snapshot?.cohortMode ?? ('unavailable' as const),
    availableAtSec: snapshot?.availableAtSec ?? null,
  };
  for (const [key, code] of [
    ['codeHash', 'code-hash-mismatch'],
    ['abiHash', 'abi-hash-mismatch'],
  ] as const)
    if (read.manifest.replay?.[key] && read.manifest.replay[key] !== provenance[key])
      issues.push({
        code,
        detail: 'Captured implementation hash differs from this replay runtime',
      });
  if (!snapshot)
    issues.push({
      code: 'input-snapshot-missing',
      detail:
        'P1 has no saved historical asset/config/metadata snapshot; supply a portable replay manifest',
    });
  if (
    snapshot &&
    (!Number.isSafeInteger(snapshot.availableAtSec) ||
      !['as-of', 'retrospective-cohort'].includes(snapshot.cohortMode))
  )
    throw new Error('Invalid replay snapshot availability');
  const valid = read.batches.filter((b) => {
    const found = checkBatchIntegrity(b, false);
    issues.push(...found);
    return !found.some((i) => ['shard-incomplete', 'observed-time-invalid'].includes(i.code));
  });
  for (const scope of new Set(valid.map((b) => b.scopeId))) {
    const scopeBatches = valid.filter((b) => b.scopeId === scope);
    issues.push(
      ...checkMinuteIntegrity(mergeHistoricalBatches(scopeBatches)).map((issue) => ({
        ...issue,
        scopeId: scope,
      })),
    );
  }
  if (snapshot) {
    const db = openDatabase(':memory:');
    const store = new SqliteRangeStore(db);
    const input: MetricInput = {
      scopeId: read.manifest.scopeId,
      registryScopeId: read.manifest.discoveryScope,
      configVersion: snapshot.configVersion,
      assets: assetRegistry(snapshot),
      usdg: snapshot.usdg,
      metadata: snapshot.metadata,
    };
    // The complete register is stated once for the whole dataset. A batch may carry only the
    // pools its own events touch, so the projection is grown from here instead — and never past
    // the height the frame being evaluated stands at, or a later discovery would be presented as
    // knowledge the study point did not have.
    const catalogueRead = readCatalogue(snapshot, {
      registryScopeId: input.registryScopeId,
      assetVersion: input.assets.version,
      cutoffBlock: read.batches.reduce(
        (furthest, batch) => (batch.toBlock > furthest ? batch.toBlock : furthest),
        read.manifest.version === 2 ? BigInt(read.manifest.export.toBlock) : 0n,
      ),
    });
    issues.push(...(catalogueRead?.issues ?? []));
    const catalogue = [...(catalogueRead?.pools ?? [])].sort((left, right) =>
      left.discoveredAt.blockNumber < right.discoveredAt.blockNumber ? -1 : 1,
    );
    let adopted = 0;
    let deferred: readonly PersistedPoolRegistration[] = [];
    const adoptUpTo = (blockNumber: bigint) => {
      // A register row names the block its pool came from, and that evidence has to be in the
      // store before the row can exist. Evidence arrives as batches are accepted, so a pool that
      // is not placeable yet waits for the next adoption rather than being written or dropped.
      let end = adopted;
      while (end < catalogue.length && catalogue[end]!.discoveredAt.blockNumber <= blockNumber) end++;
      const ready = [...deferred, ...catalogue.slice(adopted, end)];
      adopted = end;
      deferred = store.persistCatalogue(input.registryScopeId, ready).unplaced;
    };
    const states = new Map<string, SignalSnapshot>();
    const historical: typeof valid = [];
    const consumedDiscovery = new Set<string>();
    try {
      for (const raw of valid) {
        if (raw.scopeId !== input.scopeId) {
          if (mode === 'recorded-observed')
            try {
              store.acceptRange(raw);
            } catch {
              issues.push({
                code: 'registry-history-gap',
                batchId: raw.id,
                detail: 'Registry batch requires unavailable predecessor',
              });
            }
          continue;
        }
        const overlaps = historical.length > 0 && raw.fromBlock <= historical.at(-1)!.toBlock;
        historical.push(raw);
        const schedule =
          mode === 'recorded-observed' ? [raw] : minutePrefixes(mergeHistoricalBatches(historical));
        if (
          mode === 'minute-close' &&
          overlaps &&
          schedule.some((s) => s.end.timestampSec <= (frames.at(-1)?.evaluatedAtSec ?? -1))
        )
          issues.push({
            code: 'historical-overlap',
            batchId: raw.id,
            detail:
              'Overlapping recorded polls require canonical history; prior evaluated minutes are retained, not silently replayed backward',
          });
        for (const scheduled of schedule) {
          if (
            mode === 'minute-close' &&
            scheduled.end.timestampSec <= (frames.at(-1)?.evaluatedAtSec ?? -1)
          )
            continue;
          if (
            snapshot.cohortMode === 'as-of' &&
            snapshot.availableAtSec > scheduled.end.timestampSec
          ) {
            issues.push({
              code: 'input-not-yet-available',
              batchId: raw.id,
              detail: 'Snapshot was unavailable at evaluation time',
            });
            continue;
          }
          // Metadata identity caches are bounded by event block inside P3.
          const b =
            mode === 'minute-close'
              ? { ...scheduled, previous: store.acceptedTip(input.scopeId) }
              : scheduled;
          try {
            let alerts: AlertRecord[] = [];
            if (mode === 'recorded-observed') {
              // Recorded-observed walks its own batch: the register is grown to what was known one
              // block before its close, never to a discovery the capture could not have seen.
              adoptUpTo(b.end.number - 1n);
              alerts = commitAcceptedSignalBatch(db, input, config, b).alerts;
            } else {
              if (input.registryScopeId !== input.scopeId)
                for (const discovery of valid.filter((d) => d.scopeId === input.registryScopeId)) {
                  const tip = store.acceptedTip(input.registryScopeId);
                  if (discovery.fromBlock > b.end.number || consumedDiscovery.has(discovery.id))
                    continue;
                  if (discovery.end.number < b.end.number) {
                    store.acceptRange({ ...discovery, previous: tip });
                    consumedDiscovery.add(discovery.id);
                    continue;
                  }
                  const end = b.end;
                  store.acceptRange(prefixAt(discovery, end, b.end.timestampSec, tip, false));
                }
              // The evidence for a register pool arrives with the batches that carry it, so the
              // register is grown after they are accepted and before the projection is rebuilt:
              // a pool discovered in this frame is visible to it, and one above the boundary
              // stays out, matching the strict cutoff `prefixAt` already applies to a batch's own array.
              store.acceptRange(b);
              adoptUpTo(b.end.number - 1n);
              new SqliteProjectionStore(db).rebuild(
                input.scopeId,
                input.registryScopeId,
                input.configVersion,
              );
            }
            const metrics = buildMetricsReport(db, input, {
              legacyWindows: mode === 'minute-close',
            });
            if (mode === 'minute-close')
              for (const w of metrics.windows) {
                const minute = w.minutes.find(
                  (m) => m.minuteStartSec === Math.floor(metrics.at.timestampSec / 60) * 60 - 60,
                );
                const decision = evaluateSignal(
                  states.get(w.poolId) ?? initialSignalSnapshot(),
                  {
                    pool: w.pool,
                    batchId: b.id,
                    observedAtMs: b.observedAtMs,
                    endAnchor: metrics.at,
                    watermarkSec: metrics.at.timestampSec,
                    metrics: w,
                    coverage: minute?.status === 'closed' ? 'complete' : 'gap',
                    evaluationMode: 'minute-close',
                  },
                  config,
                );
                states.set(w.poolId, decision.nextSnapshot);
                db.transaction(() => {
                  for (const draft of decision.alertDrafts ??
                    (decision.alertDraft ? [decision.alertDraft] : [])) {
                    const record = commitSignalDecision(
                      db,
                      input.scopeId,
                      { ...decision, alertDraft: draft },
                      'backfill',
                    );
                    if (record) alerts.push(record);
                  }
                }).immediate();
              }
            frames.push({
              batchId: b.id,
              observedAtMs: b.observedAtMs,
              evaluatedAtSec: b.end.timestampSec,
              metrics,
              alerts,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : '';
            if (
              !(error instanceof IncompleteRangeError) &&
              !(error instanceof NoAcceptedScopeError) &&
              !/^(Stale range|Range gap)/.test(message)
            )
              throw error;
            if (error instanceof IncompleteRangeError)
              issues.push({
                code: 'historical-shard-gap',
                batchId: b.id,
                detail: 'Combined historical prefix fails original shard coverage validation',
              });
            issues.push({
              code: 'projection-input-incomplete',
              batchId: b.id,
              detail:
                'Projection stage rejected incomplete input (' +
                (error instanceof Error ? error.name : 'unknown') +
                ')',
            });
            break;
          }
        }
      }
      // Final historical evidence intentionally spans the requested archive,
      // independently of the bounded live frames used by recorded-observed mode.
      adoptUpTo(catalogue.at(-1)?.discoveredAt.blockNumber ?? 0n);
      const register = new PoolRegistry([
        ...store.pools(input.registryScopeId),
        ...store.pools(input.scopeId),
      ]).snapshot();
      // A pool the catalogue names but whose discovery evidence this dataset does not hold stays
      // unknown: it is reported, never counted as a silent zero.
      const held = new Set(register.map((entry) => poolRegistrationId(entry)));
      const unknown = catalogue.filter((pool) => !held.has(poolRegistrationId(pool))).length;
      if (unknown > 0)
        issues.push({
          code: 'catalogue-pool-unknown',
          detail: `${unknown} catalogue pools have no discovery evidence in this dataset`,
        });
      if (store.acceptedTip(input.scopeId))
        new SqliteProjectionStore(db).rebuild(
          input.scopeId,
          input.registryScopeId,
          input.configVersion,
        );
      const projection = new SqliteProjectionStore(db).read(
        input.scopeId,
        input.registryScopeId,
        input.configVersion,
      );
      events = projection?.events ?? [];
      registrations = [...register];
      const coverageHistory = (scope: string, endSec: number) => {
        const first = store
          .boundaries(scope)
          .reduce((min, b) => Math.min(min, b.timestampSec), endSec);
        const minutes = Math.max(65, Math.ceil((endSec - first) / 60));
        if (minutes > 10080)
          issues.push({
            code: 'coverage-window-limit',
            detail: 'Requested history exceeds the existing 10080-minute coverage reader limit',
          });
        return Math.min(10080, minutes);
      };
      if (projection)
        fullCoverage = readMetricCoverage(
          db,
          input.scopeId,
          projection.qualityErrors,
          projection.end,
          coverageHistory(input.scopeId, projection.end.timestampSec),
        );
      const discoveryTip = store.acceptedTip(input.registryScopeId);
      if (discoveryTip)
        discoveryMinutes = readMetricCoverage(
          db,
          input.registryScopeId,
          [],
          discoveryTip,
          coverageHistory(input.registryScopeId, discoveryTip.timestampSec),
        );
      const allTimes = new Map([
        ...store.logTimes(input.registryScopeId),
        ...store.logTimes(input.scopeId),
      ]);
      const boundaries = [
        ...store.boundaries(input.registryScopeId),
        ...store.boundaries(input.scopeId),
      ];
      registrationTimes = registrations.map((r) => {
        const recorded = allTimes.get(rawLogKey(r.discoveredAt))?.minuteStartSec ?? null;
        const lower = boundaries.find(
          (b) =>
            b.firstBlock <= r.discoveredAt.blockNumber &&
            boundaries.some(
              (end) =>
                end.timestampSec === b.timestampSec + 60 &&
                end.firstBlock > r.discoveredAt.blockNumber,
            ),
        );
        return {
          poolId: poolRegistrationId(r),
          creationMinuteStartSec:
            r.source === 'seed-config' ? null : (recorded ?? lower?.timestampSec ?? null),
        };
      });
      const valuations = new Map(frames.at(-1)?.metrics.valuations.map((v) => [v.eventId, v]));
      metricEvents = events.map((event) => {
        const v = valuations.get(rawLogKey(event.ref));
        return {
          event,
          scopeId: input.scopeId,
          usdMicros: v?.usdMicros ?? null,
          usdgNotionalRaw: v?.usdgNotionalRaw ?? null,
          rawNotional: v ? { token: v.nativeToken, raw: v.nativeAmountRaw } : null,
        };
      });
    } finally {
      db.close();
    }
  }
  if (frames.length === 0)
    issues.push({
      code: 'no-evaluable-frames',
      detail: 'No frame could be evaluated from available evidence',
    });
  const alertRevisions = frames.flatMap((f) => f.alerts);
  const alerts = [...new Map(alertRevisions.map((a) => [a.id, a])).values()];
  const report: ReplayReport = {
    discoveryMinutes,
    registrationTimes,
    registrations,
    events,
    metricEvents,
    coverage: fullCoverage,
    discoveryCoverage: {
      verified: false,
      // Only proven operation minute gaps are independent of discovery integrity.
      // Unknown-scope, artifact, snapshot, and projection failures remain conservative.
      integrityComplete: issues.every(
        (issue) =>
          issue.code === 'minute-boundary-missing' &&
          issue.scopeId === read.manifest.scopeId &&
          issue.scopeId !== read.manifest.discoveryScope,
      ),
      reason: 'Discovery creation-time coverage has not been independently established',
    },
    finalMetrics: frames.at(-1)?.metrics ?? null,
    version: 'p5-replay-v1',
    replayRunId: `${provenance.configHash.slice(0, 12)}-${randomUUID()}`,
    mode,
    status: issues.length ? 'incomplete' : 'complete',
    coverageVerified: false,
    provenance,
    integrity: { complete: issues.length === 0, issues },
    frames,
    alerts,
    alertRevisions,
    businessHash: contentHash(frames),
  };
  if (options.outDirectory) {
    const directory = join(options.outDirectory, report.replayRunId);
    mkdirSync(directory, { recursive: true });
    report.outputDirectory = directory;
    writeFileSync(join(directory, 'report.json'), encodeJson(report), { flag: 'wx' });
    writeFileSync(join(directory, 'rules.json'), encodeJson(config), { flag: 'wx' });
    const portable = {
      ...read.manifest,
      batches: read.manifest.batches.map((ref, index) => {
        const artifact = read.artifacts.find((a) => a.id === ref.id);
        const path = 'raw-' + index + '.json';
        if (artifact) writeFileSync(join(directory, path), artifact.text, { flag: 'wx' });
        return { ...ref, path };
      }),
    };
    writeFileSync(join(directory, 'manifest.json'), encodeJson(portable), { flag: 'wx' });
    writeFileSync(join(directory, 'source-manifest.json'), readFileSync(manifestPath), {
      flag: 'wx',
    });
    writeFileSync(
      join(directory, 'minute-index.json'),
      encodeJson(
        read.batches.map((b) => ({ id: b.id, logTimes: b.logTimes, boundaries: b.boundaries })),
      ),
      { flag: 'wx' },
    );
    writeFileSync(join(directory, 'raw-batches.json'), encodeJson(read.batches), { flag: 'wx' });
    writeFileSync(join(directory, 'implementation.json'), encodeJson(source.files), { flag: 'wx' });
  }
  return report;
}
