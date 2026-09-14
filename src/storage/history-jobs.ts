import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { ConfigError } from '../config/env.js';
import { encodeJson } from '../domain/json.js';
import { openDatabase } from './database.js';

export interface HistoryJobSpec {
  version: 1;
  chainId: 4663;
  assetVersion: string;
  protocolVersion: string;
  fromBlock: string;
  toBlock: string;
  targetHash: string;
  analysisStartSec: number;
  analysisEndSec: number;
  sourceDatabasePath: string;
  studyDatabasePath: string;
  watchlistPath: string;
  configPath: string;
  warmupMinutes: number;
  outcomeMinutes: number;
}

export type HistoryJobStatus =
  'prepared' | 'running' | 'waiting-retry' | 'paused' | 'complete' | 'failed';
export type HistoryJobPhase = 'catalogue' | 'operations' | 'time' | 'metadata' | 'finished';

export interface HistoryJobMissing {
  fromBlock: string;
  toBlock: string;
  reason: string;
}

export interface HistoryInputSnapshot {
  kind: 'config' | 'watchlist' | 'source-database' | 'source-wal';
  path: string;
  sha256: string | null;
  bytes: number | null;
  present: boolean;
}

export interface HistoryJobState {
  id: string;
  spec: HistoryJobSpec;
  specHash: string;
  status: HistoryJobStatus;
  phase: HistoryJobPhase;
  missing: HistoryJobMissing[];
  registryMissing: HistoryJobMissing[];
  operationMissing: HistoryJobMissing[];
  timeUnknown: HistoryJobMissing[];
  unpriced: HistoryJobMissing[];
  cumulativeRpcCalls: number;
  currentRunRpcCalls: number;
  rawEventsAdded: number;
  rawBytesAdded: number;
  completedCoverage: HistoryJobMissing[];
  inputSnapshots: HistoryInputSnapshot[];
  attempts: number;
  lastError: string | null;
  updatedAtMs: number;
  scopeId?: string;
  registryScopeId?: string;
}

type HistoryJobRow = {
  id: string;
  spec_hash: string;
  source_database_path: string;
  study_database_path: string;
  spec_json: string;
  input_snapshots_json: string;
  status: string;
  phase: string;
  missing_json: string;
  registry_missing_json: string;
  operation_missing_json: string;
  time_unknown_json: string;
  unpriced_json: string;
  cumulative_rpc_calls: number;
  current_run_rpc_calls: number;
  raw_events_added: number;
  raw_bytes_added: number;
  completed_coverage_json: string;
  attempts: number;
  last_error: string | null;
  updated_at_ms: number;
};

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const HASH = /^0x[0-9a-fA-F]{64}$/;

function decimal(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new ConfigError(`History job ${field} must be a decimal string`);
  const number = BigInt(value);
  if (number > MAX_SAFE_BIGINT) throw new ConfigError(`History job ${field} exceeds safe range`);
  return number.toString();
}

function safeSeconds(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new ConfigError(`History job ${field} must be a non-negative safe integer`);
  return value as number;
}

function pathField(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new ConfigError(`History job ${field} is required`);
  return resolve(value);
}

export function normalizeHistoryJobSpec(input: HistoryJobSpec): HistoryJobSpec {
  if (!input || input.version !== 1 || input.chainId !== 4663)
    throw new ConfigError('History job spec must target chain 4663, version 1');
  const fromBlock = decimal(input.fromBlock, 'fromBlock');
  const toBlock = decimal(input.toBlock, 'toBlock');
  if (BigInt(fromBlock) > BigInt(toBlock))
    throw new ConfigError('History job requires ordered block bounds');
  if (typeof input.targetHash !== 'string' || !HASH.test(input.targetHash))
    throw new ConfigError('History job targetHash must be a 32-byte hash');
  const analysisStartSec = safeSeconds(input.analysisStartSec, 'analysisStartSec');
  const analysisEndSec = safeSeconds(input.analysisEndSec, 'analysisEndSec');
  if (analysisStartSec >= analysisEndSec)
    throw new ConfigError('History job requires ordered analysis bounds');
  if (!Number.isSafeInteger(input.warmupMinutes) || input.warmupMinutes < 0)
    throw new ConfigError('History job warmupMinutes must be a non-negative safe integer');
  if (!Number.isSafeInteger(input.outcomeMinutes) || input.outcomeMinutes < 0)
    throw new ConfigError('History job outcomeMinutes must be a non-negative safe integer');
  for (const [value, field] of [
    [input.assetVersion, 'assetVersion'],
    [input.protocolVersion, 'protocolVersion'],
  ] as const)
    if (typeof value !== 'string' || !value.trim())
      throw new ConfigError(`History job ${field} is required`);
  const sourceDatabasePath = pathField(input.sourceDatabasePath, 'sourceDatabasePath');
  const studyDatabasePath = pathField(input.studyDatabasePath, 'studyDatabasePath');
  if (sourceDatabasePath.toLowerCase() === studyDatabasePath.toLowerCase())
    throw new ConfigError('History job source and study databases must differ');
  return {
    version: 1,
    chainId: 4663,
    assetVersion: input.assetVersion,
    protocolVersion: input.protocolVersion,
    fromBlock,
    toBlock,
    targetHash: input.targetHash.toLowerCase(),
    analysisStartSec,
    analysisEndSec,
    sourceDatabasePath,
    studyDatabasePath,
    watchlistPath: pathField(input.watchlistPath, 'watchlistPath'),
    configPath: pathField(input.configPath, 'configPath'),
    warmupMinutes: input.warmupMinutes,
    outcomeMinutes: input.outcomeMinutes,
  };
}

function snapshot(kind: HistoryInputSnapshot['kind'], path: string): HistoryInputSnapshot {
  const resolved = resolve(path);
  if (!existsSync(resolved))
    return { kind, path: resolved, sha256: null, bytes: null, present: false };
  const bytes = readFileSync(resolved);
  if (!statSync(resolved).isFile())
    throw new ConfigError(`History job input is not a file: ${resolved}`);
  return {
    kind,
    path: resolved,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    present: true,
  };
}

export function captureHistoryInputSnapshots(spec: HistoryJobSpec): HistoryInputSnapshot[] {
  const normalized = normalizeHistoryJobSpec(spec);
  const snapshots = [
    snapshot('config', normalized.configPath),
    snapshot('watchlist', normalized.watchlistPath),
    snapshot('source-database', normalized.sourceDatabasePath),
  ];
  // SQLite WAL sidecars are transient implementation details; the consistent backup is the frozen source.
  return snapshots;
}

export function historyJobSpecHash(
  spec: HistoryJobSpec,
  snapshots: readonly HistoryInputSnapshot[],
): string {
  return createHash('sha256')
    .update(encodeJson({ spec: normalizeHistoryJobSpec(spec), snapshots }))
    .digest('hex');
}

function json<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new ConfigError('History job state is corrupt');
  }
}

function status(value: string): HistoryJobStatus {
  if (!['prepared', 'running', 'waiting-retry', 'paused', 'complete', 'failed'].includes(value))
    throw new ConfigError('History job state has an invalid status');
  return value as HistoryJobStatus;
}
function phase(value: string): HistoryJobPhase {
  if (!['catalogue', 'operations', 'time', 'metadata', 'finished'].includes(value))
    throw new ConfigError('History job state has an invalid phase');
  return value as HistoryJobPhase;
}

function rowState(row: HistoryJobRow): HistoryJobState {
  const spec = normalizeHistoryJobSpec(json<HistoryJobSpec>(row.spec_json, {} as HistoryJobSpec));
  if (
    resolve(row.source_database_path) !== spec.sourceDatabasePath ||
    resolve(row.study_database_path) !== spec.studyDatabasePath
  )
    throw new ConfigError('History job path state is corrupt');
  return {
    id: row.id,
    spec,
    specHash: row.spec_hash,
    status: status(row.status),
    phase: phase(row.phase),
    missing: json<HistoryJobMissing[]>(row.missing_json, []),
    registryMissing: json<HistoryJobMissing[]>(row.registry_missing_json, []),
    operationMissing: json<HistoryJobMissing[]>(row.operation_missing_json, []),
    timeUnknown: json<HistoryJobMissing[]>(row.time_unknown_json, []),
    unpriced: json<HistoryJobMissing[]>(row.unpriced_json, []),
    cumulativeRpcCalls: row.cumulative_rpc_calls,
    currentRunRpcCalls: row.current_run_rpc_calls,
    rawEventsAdded: row.raw_events_added,
    rawBytesAdded: row.raw_bytes_added,
    completedCoverage: json<HistoryJobMissing[]>(row.completed_coverage_json, []),
    inputSnapshots: json<HistoryInputSnapshot[]>(row.input_snapshots_json, []),
    attempts: row.attempts,
    lastError: row.last_error,
    updatedAtMs: row.updated_at_ms,
  };
}

export function readHistoryJobFromDatabase(db: Database.Database, id: string): HistoryJobState {
  if (!id.trim()) throw new ConfigError('History job id is required');
  const row = db.prepare('select * from history_jobs where id=?').get(id) as
    HistoryJobRow | undefined;
  if (!row) throw new ConfigError(`History job not found: ${id}`);
  return rowState(row);
}

export function readHistoryJob(studyDatabasePath: string, id: string): HistoryJobState {
  const path = resolve(studyDatabasePath);
  if (!existsSync(path)) throw new ConfigError('History study database does not exist');
  const db = openDatabase(path, { readonly: true });
  try {
    return readHistoryJobFromDatabase(db, id);
  } finally {
    db.close();
  }
}

function values(state: HistoryJobState) {
  return [
    state.id,
    state.specHash,
    state.spec.sourceDatabasePath,
    state.spec.studyDatabasePath,
    encodeJson(state.spec),
    encodeJson(state.inputSnapshots),
    state.status,
    state.phase,
    encodeJson(state.missing),
    encodeJson(state.registryMissing),
    encodeJson(state.operationMissing),
    encodeJson(state.timeUnknown),
    encodeJson(state.unpriced),
    state.cumulativeRpcCalls,
    state.currentRunRpcCalls,
    state.rawEventsAdded,
    state.rawBytesAdded,
    encodeJson(state.completedCoverage),
    state.attempts,
    state.lastError,
    state.updatedAtMs,
  ];
}

export function insertHistoryJob(db: Database.Database, state: HistoryJobState): void {
  const conflict = db
    .prepare('select id from history_jobs where study_database_path=?')
    .get(state.spec.studyDatabasePath) as { id: string } | undefined;
  if (conflict)
    throw new ConfigError(`Study database is already owned by history job ${conflict.id}`);
  db.prepare(
    `insert into history_jobs(
      id,spec_hash,source_database_path,study_database_path,spec_json,input_snapshots_json,
      status,phase,missing_json,registry_missing_json,operation_missing_json,time_unknown_json,
      unpriced_json,cumulative_rpc_calls,current_run_rpc_calls,raw_events_added,raw_bytes_added,
      completed_coverage_json,attempts,last_error,updated_at_ms
    ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(...values(state));
}

export function updateHistoryJob(db: Database.Database, state: HistoryJobState): void {
  const result = db
    .prepare(
      `update history_jobs set
        spec_hash=?,source_database_path=?,study_database_path=?,spec_json=?,input_snapshots_json=?,
        status=?,phase=?,missing_json=?,registry_missing_json=?,operation_missing_json=?,time_unknown_json=?,
        unpriced_json=?,cumulative_rpc_calls=?,current_run_rpc_calls=?,raw_events_added=?,raw_bytes_added=?,
        completed_coverage_json=?,attempts=?,last_error=?,updated_at_ms=? where id=?`,
    )
    .run(
      state.specHash,
      state.spec.sourceDatabasePath,
      state.spec.studyDatabasePath,
      encodeJson(state.spec),
      encodeJson(state.inputSnapshots),
      state.status,
      state.phase,
      encodeJson(state.missing),
      encodeJson(state.registryMissing),
      encodeJson(state.operationMissing),
      encodeJson(state.timeUnknown),
      encodeJson(state.unpriced),
      state.cumulativeRpcCalls,
      state.currentRunRpcCalls,
      state.rawEventsAdded,
      state.rawBytesAdded,
      encodeJson(state.completedCoverage),
      state.attempts,
      state.lastError,
      state.updatedAtMs,
      state.id,
    );
  if (result.changes !== 1) throw new ConfigError(`History job not found: ${state.id}`);
}

export function patchHistoryJob(
  db: Database.Database,
  id: string,
  patch: Partial<Omit<HistoryJobState, 'id' | 'spec' | 'specHash' | 'inputSnapshots'>>,
): HistoryJobState {
  const current = readHistoryJobFromDatabase(db, id);
  const next: HistoryJobState = {
    ...current,
    ...patch,
    updatedAtMs: Date.now(),
  };
  updateHistoryJob(db, next);
  return next;
}

export function newHistoryJobState(
  spec: HistoryJobSpec,
  snapshots: HistoryInputSnapshot[],
  categories: Pick<
    HistoryJobState,
    'missing' | 'registryMissing' | 'operationMissing' | 'timeUnknown' | 'unpriced'
  >,
  extras: Pick<HistoryJobState, 'scopeId' | 'registryScopeId'> = {},
): HistoryJobState {
  const normalized = normalizeHistoryJobSpec(spec);
  return {
    id: 'history-job-' + randomUUID(),
    spec: normalized,
    specHash: historyJobSpecHash(normalized, snapshots),
    status: 'prepared',
    phase: 'catalogue',
    ...categories,
    cumulativeRpcCalls: 0,
    currentRunRpcCalls: 0,
    rawEventsAdded: 0,
    rawBytesAdded: 0,
    completedCoverage: [],
    inputSnapshots: snapshots,
    attempts: 0,
    lastError: null,
    updatedAtMs: Date.now(),
    ...extras,
  };
}

export function currentHistoryInputSnapshots(state: HistoryJobState): HistoryInputSnapshot[] {
  return captureHistoryInputSnapshots(state.spec);
}

export function historyInputSnapshotsMatch(
  expected: readonly HistoryInputSnapshot[],
  actual: readonly HistoryInputSnapshot[],
): boolean {
  return encodeJson(expected) === encodeJson(actual);
}
