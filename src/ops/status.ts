import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { ConfigError } from '../config/env.js';
import { openDatabase } from '../storage/database.js';
import { healthSnapshot, type BlockWatermark, type HealthSnapshot } from './report.js';

export interface DatabaseStatusOptions {
  scopeId: string;
  sourceAlias?: string;
  sidecarPath?: string;
  nowMs?: number;
  /** Maximum age for an active sidecar observation. Defaults to 60 seconds. */
  staleAfterMs?: number;
}

export interface DatabaseHealthStatus extends HealthSnapshot {
  observedRuntimeState: string | null;
  sidecarSampledAtMs: number | null;
  sidecarAgeMs: number | null;
  sidecarFreshness: 'fresh' | 'stale' | 'missing' | 'invalid';
}

const point = (
  row: { block_number: number | string; block_hash: string; timestamp_sec?: number } | undefined,
): BlockWatermark | null =>
  row
    ? {
        blockNumber: BigInt(row.block_number),
        blockHash: row.block_hash,
        timestampSec: row.timestamp_sec ?? null,
      }
    : null;

function size(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

/** Reads only persisted facts. A sidecar head is an observed head with its original timestamp. */
export function inspectDatabaseStatus(
  pathValue: string,
  options: DatabaseStatusOptions,
): DatabaseHealthStatus {
  const path = resolve(pathValue);
  if (!existsSync(path) || !statSync(path).isFile())
    throw new ConfigError('Recorded database must exist');
  const db = openDatabase(path, { readonly: true });
  try {
    const scanned = point(
      db
        .prepare('select block_number,block_hash,timestamp_sec from scope_cursors where scope_id=?')
        .get(options.scopeId) as any,
    );
    const raw = point(
      db
        .prepare(
          'select to_block as block_number,end_hash as block_hash,end_timestamp_sec as timestamp_sec from ingest_batches where scope_id=? order by to_block desc limit 1',
        )
        .get(options.scopeId) as any,
    );
    const projectionRow = db
      .prepare(
        'select block_number,block_hash,source_hash from projection_cursors where scope_id=?',
      )
      .get(options.scopeId) as
      { block_number: number; block_hash: string; source_hash: string } | undefined;
    const projected = point(projectionRow);
    const projectionCursorVerified =
      projected !== null &&
      scanned !== null &&
      projected.blockNumber === scanned.blockNumber &&
      projected.blockHash === scanned.blockHash;
    const outboxPending = Number(
      (
        db
          .prepare(
            "select count(*) as n from alert_outbox where capture_mode='live' and status in ('pending','failed') and scope_id=?",
          )
          .get(options.scopeId) as { n: number }
      ).n,
    );
    const nowMs = options.nowMs ?? Date.now();
    const sidecarRead = readSidecar(
      options.sidecarPath ?? path + '.health.json',
      path,
      options.scopeId,
    );
    const sidecar = sidecarRead.value;
    const sidecarSampledAtMs =
      typeof sidecar?.sampledAtMs === 'number' &&
      Number.isSafeInteger(sidecar.sampledAtMs) &&
      sidecar.sampledAtMs >= 0
        ? sidecar.sampledAtMs
        : null;
    const sidecarAgeMs =
      sidecarSampledAtMs !== null && sidecarSampledAtMs <= nowMs
        ? nowMs - sidecarSampledAtMs
        : null;
    const staleAfterMs = options.staleAfterMs ?? 60_000;
    if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0)
      throw new ConfigError('staleAfterMs must be a non-negative finite number');
    const sidecarFreshness =
      sidecarRead.kind === 'missing'
        ? ('missing' as const)
        : sidecarRead.kind === 'invalid' || sidecarAgeMs === null
          ? ('invalid' as const)
          : sidecarAgeMs > staleAfterMs
            ? ('stale' as const)
            : ('fresh' as const);
    const observedRuntimeState = sidecar?.runtimeState ?? null;
    const terminalRuntimeState =
      observedRuntimeState !== null &&
      ['complete', 'failed', 'stopped', 'incomplete'].includes(observedRuntimeState);
    const runtimeState =
      observedRuntimeState === null
        ? null
        : terminalRuntimeState || sidecarFreshness === 'fresh'
          ? observedRuntimeState
          : 'stale';
    const sidecarMatchesScanned =
      sidecar?.scanned !== null &&
      sidecar?.scanned !== undefined &&
      scanned !== null &&
      sidecar.scanned.blockNumber === scanned.blockNumber &&
      sidecar.scanned.blockHash === scanned.blockHash;
    return {
      ...healthSnapshot({
        sampledAtMs: nowMs,
        sourceAlias: options.sourceAlias ?? sidecar?.sourceAlias ?? 'unknown',
        chainId: sidecar?.chainId ?? null,
        head: sidecar?.head ?? null,
        lastHeadAtMs: sidecar?.lastHeadAtMs ?? null,
        scanned,
        rawSaved: raw,
        projected,
        projectedSourceVerified:
          sidecar?.projectedSourceVerified === true &&
          sidecarMatchesScanned &&
          sidecar.projectionSourceHash !== null &&
          sidecar.projectionSourceHash === projectionRow?.source_hash,
        projectedCursorVerified: projectionCursorVerified,
        queueDepth: sidecar?.queueDepth ?? 0,
        inflight: sidecar?.inflight ?? 0,
        rpc: sidecar?.rpc ?? {},
        writeLatencyMs: sidecar?.writeLatencyMs ?? null,
        processingLatencyMs: sidecar?.processingLatencyMs ?? null,
        dbBytes: size(path),
        walBytes: size(path + '-wal'),
        outboxPending,
        gap: sidecar?.gap ?? null,
        runtimeState,
      }),
      observedRuntimeState,
      sidecarSampledAtMs,
      sidecarAgeMs,
      sidecarFreshness,
    };
  } finally {
    db.close();
  }
}

type StatusSidecar = Partial<HealthSnapshot> & {
  databasePath?: string;
  scopeId?: string;
  projectionSourceHash?: string | null;
};
type SidecarRead =
  { kind: 'present'; value: StatusSidecar } | { kind: 'missing' | 'invalid'; value: null };
function readSidecar(sidecarPath: string, databasePath: string, scopeId: string): SidecarRead {
  if (!existsSync(sidecarPath)) return { kind: 'missing', value: null };
  try {
    const value = JSON.parse(readFileSync(sidecarPath, 'utf8')) as StatusSidecar;
    if (
      typeof value.databasePath !== 'string' ||
      resolve(value.databasePath) !== databasePath ||
      typeof value.scopeId !== 'string' ||
      value.scopeId !== scopeId
    )
      return { kind: 'invalid', value: null };
    return {
      kind: 'present',
      value: {
        ...value,
        gap: typeof value.gap === 'boolean' ? value.gap : null,
        runtimeState:
          typeof value.runtimeState === 'string' &&
          [
            'starting',
            'healthy',
            'degraded',
            'failed',
            'stopped',
            'complete',
            'incomplete',
          ].includes(value.runtimeState)
            ? value.runtimeState
            : null,
        head: normalizePoint(value.head),
        scanned: normalizePoint(value.scanned),
        rawSaved: normalizePoint(value.rawSaved),
        projected: normalizePoint(value.projected),
      },
    };
  } catch {
    return { kind: 'invalid', value: null };
  }
}

function normalizePoint(value: unknown): BlockWatermark | null {
  if (value === null || typeof value !== 'object') return null;
  const point = value as { blockNumber?: unknown; blockHash?: unknown; timestampSec?: unknown };
  if (
    (typeof point.blockNumber !== 'string' &&
      typeof point.blockNumber !== 'number' &&
      typeof point.blockNumber !== 'bigint') ||
    typeof point.blockHash !== 'string'
  )
    return null;
  const timestampSec =
    point.timestampSec === null
      ? null
      : typeof point.timestampSec === 'number' && Number.isSafeInteger(point.timestampSec)
        ? point.timestampSec
        : null;
  try {
    return { blockNumber: BigInt(point.blockNumber), blockHash: point.blockHash, timestampSec };
  } catch {
    return null;
  }
}

export async function backupDatabase(sourceValue: string, targetValue: string): Promise<void> {
  const source = resolve(sourceValue),
    target = resolve(targetValue);
  if (source === target) throw new ConfigError('Backup source and target must differ');
  if (!existsSync(source) || !statSync(source).isFile())
    throw new ConfigError('Backup source must exist');
  if (existsSync(target)) throw new ConfigError('Backup target already exists');
  if (!existsSync(dirname(target))) throw new ConfigError('Backup target directory must exist');
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(target);
  } finally {
    db.close();
  }
}
