import { readProjectionWatermark } from '../storage/live-projection.js';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';
import type { BlockAnchor } from '../domain/types.js';
import type { RequestMeter } from '../rpc/request-meter.js';
import { SqliteRangeStore } from '../storage/raw-store.js';
import { saveJson } from './files.js';
import {
  aggregateOpsReport,
  healthSnapshot,
  type BatchTimingSample,
  type BlockWatermark,
  type DiskCheckpoint,
  type HealthSnapshot,
  type MeterCheckpoint,
  type OpsPhase,
} from './report.js';

const watermark = (anchor: BlockAnchor | null): BlockWatermark | null =>
  anchor && {
    blockNumber: anchor.number,
    blockHash: anchor.hash,
    timestampSec: anchor.timestampSec,
  };
const fileBytes = (path: string) => {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
};

export interface RuntimeBatchTiming extends BatchTimingSample {
  batchId: string;
  fromBlock: bigint;
  toBlock: bigint;
  logs: number;
  writeLatencyMs: number;
  processingLatencyMs: number | null;
  headAcquisitionLagMs: number | null;
}

/** Captures measurements at actual I/O/commit boundaries; it does not recompute business state. */
export class RuntimeTelemetry {
  readonly batchTimings: RuntimeBatchTiming[] = [];
  readonly healthSamples: HealthSnapshot[] = [];
  readonly meterCheckpoints: MeterCheckpoint[] = [];
  readonly diskCheckpoints: DiskCheckpoint[] = [];
  readonly transitions: { atMs: number; state: string }[] = [];
  private phase: OpsPhase = 'startup';
  private head: BlockAnchor | null = null;
  private lastHeadAtMs: number | null = null;
  private freshProjection: { sourceHash: string; block: bigint; hash: string } | null = null;
  private waitedMs = 0;
  private state: string | null = null;
  private gap: boolean | null = null;
  private readonly initialCpu = process.cpuUsage();
  readonly startedAtMs = Date.now();

  constructor(
    private readonly input: {
      db: Database.Database;
      databasePath: string;
      scopeId: string;
      sourceAlias: string;
      chainId: number;
      meter: RequestMeter;
    },
  ) {
    this.checkpoint();
  }

  observeHead(head: BlockAnchor) {
    this.head = head;
    this.lastHeadAtMs = Date.now();
  }
  get headObservedAtMs() {
    return this.lastHeadAtMs;
  }
  addWait(ms: number) {
    this.waitedMs += ms;
  }
  transition(state: string): boolean {
    if (state === this.state) return false;
    this.state = state;
    this.transitions.push({ atMs: Date.now(), state });
    this.sample(state === 'degraded' || state === 'failed' ? null : this.gap);
    return true;
  }
  setPhase(next: OpsPhase) {
    if (next === this.phase) return;
    this.checkpoint();
    this.phase = next;
    this.checkpoint();
  }
  invalidateProjection() {
    this.freshProjection = null;
  }
  markProjectionFresh() {
    const row = readProjectionWatermark(this.input.db, this.input.scopeId);
    this.freshProjection = row
      ? { sourceHash: row.source_hash, block: BigInt(row.block_number), hash: row.block_hash }
      : null;
  }
  private checkpoint() {
    const meter = this.input.meter.summary();
    const atMs = Date.now();
    this.meterCheckpoints.push({
      phase: this.phase,
      atMs,
      calls: meter.calls,
      responseBytes: meter.responseBytes,
      methods: meter.methods,
      billingUnits: meter.billingUnits,
    });
    this.diskCheckpoints.push({
      phase: this.phase,
      atMs,
      dbBytes: fileBytes(this.input.databasePath),
      walBytes: fileBytes(this.input.databasePath + '-wal'),
    });
  }
  sample(gap = this.gap) {
    this.gap = gap;
    const { db, scopeId, databasePath, meter } = this.input;
    const scanned = new SqliteRangeStore(db).acceptedTip(scopeId);
    const raw = db
      .prepare(
        'select to_block,end_hash,end_timestamp_sec from ingest_batches where scope_id=? order by to_block desc,observed_at_ms desc limit 1',
      )
      .get(scopeId) as
      { to_block: number; end_hash: string; end_timestamp_sec: number } | undefined;
    const projection = readProjectionWatermark(db, scopeId);
    const fresh =
      this.freshProjection !== null &&
      projection !== undefined &&
      scanned !== null &&
      projection.source_hash === this.freshProjection.sourceHash &&
      BigInt(projection.block_number) === scanned.number &&
      projection.block_hash === scanned.hash &&
      this.freshProjection.block === scanned.number &&
      this.freshProjection.hash === scanned.hash;
    const pending = db
      .prepare(
        "select count(*) as n from alert_outbox where scope_id=? and capture_mode='live' and status in ('pending','failed')",
      )
      .get(scopeId) as { n: number };
    const usage = meter.summary();
    const latest = this.batchTimings.at(-1);
    const snapshot = healthSnapshot({
      sampledAtMs: Date.now(),
      sourceAlias: this.input.sourceAlias,
      chainId: this.input.chainId,
      head: watermark(this.head),
      lastHeadAtMs: this.lastHeadAtMs,
      scanned: watermark(scanned),
      rawSaved: raw
        ? {
            blockNumber: BigInt(raw.to_block),
            blockHash: raw.end_hash,
            timestampSec: raw.end_timestamp_sec,
          }
        : null,
      projected: fresh ? watermark(scanned) : null,
      projectedSourceVerified: fresh,
      projectedCursorVerified: fresh,
      gap: this.gap,
      runtimeState: this.state,
      queueDepth: 'queueDepth' in usage ? Number(usage.queueDepth) : 0,
      inflight: 'activeRpc' in usage ? Number(usage.activeRpc) : 0,
      rpc: usage.methods,
      writeLatencyMs: latest?.writeLatencyMs ?? null,
      processingLatencyMs: latest?.processingLatencyMs ?? null,
      dbBytes: fileBytes(databasePath),
      walBytes: fileBytes(databasePath + '-wal'),
      outboxPending: pending.n,
    });
    this.healthSamples.push(snapshot);
    saveJson(
      databasePath + '.health.json',
      {
        ...snapshot,
        databasePath,
        scopeId,
        projectionSourceHash: fresh ? projection!.source_hash : null,
        runtimeState: this.state,
        activeWaitMs: this.waitedMs,
      },
      dirname(databasePath),
    );
    return snapshot;
  }
  finish() {
    this.checkpoint();
    this.sample();
    return {
      report: aggregateOpsReport({
        sourceAlias: this.input.sourceAlias,
        startedAtMs: this.startedAtMs,
        finishedAtMs: Date.now(),
        batchTimings: this.batchTimings,
        healthSamples: this.healthSamples,
        meterCheckpoints: this.meterCheckpoints,
        diskCheckpoints: this.diskCheckpoints,
        verifiedRates: null,
      }),
      batchTimings: this.batchTimings,
      healthSamples: this.healthSamples,
      meterCheckpoints: this.meterCheckpoints,
      diskCheckpoints: this.diskCheckpoints,
      transitions: this.transitions,
      activeWaitMs: this.waitedMs,
      cpuUsageMicros: process.cpuUsage(this.initialCpu),
      memory: process.memoryUsage(),
    };
  }
}
