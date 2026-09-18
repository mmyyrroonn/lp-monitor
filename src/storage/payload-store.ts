import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type Database from 'better-sqlite3';
import { CHAIN_ID } from '../domain/chain.js';
import { encodeJson } from '../domain/json.js';
import type { RawLog } from '../domain/types.js';
import { countWork } from '../ops/work-counters.js';
import type { RecordedRangeBatch } from './manifest.js';

export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface PayloadRef {
  version: 1;
  hash: string;
  codec: 'gzip';
  rawBytes: number;
}

export class PayloadFormatError extends Error {}

function checkedBytes(raw: Uint8Array): Buffer {
  if (raw.byteLength > MAX_PAYLOAD_BYTES)
    throw new PayloadFormatError('Payload exceeds the 64 MiB uncompressed limit');
  return Buffer.from(raw);
}

function checkedRef(ref: PayloadRef): void {
  if (
    ref.version !== 1 ||
    ref.codec !== 'gzip' ||
    !HASH_PATTERN.test(ref.hash) ||
    !Number.isSafeInteger(ref.rawBytes) ||
    ref.rawBytes < 0 ||
    ref.rawBytes > MAX_PAYLOAD_BYTES
  )
    throw new PayloadFormatError('Invalid payload reference');
}

function hashBytes(raw: Uint8Array): string {
  return createHash('sha256').update(raw).digest('hex');
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

export function putPayload(db: Database.Database, raw: Uint8Array): PayloadRef {
  const bytes = checkedBytes(raw);
  const ref: PayloadRef = {
    version: 1,
    hash: hashBytes(bytes),
    codec: 'gzip',
    rawBytes: bytes.byteLength,
  };
  const compressed = gzipSync(bytes, { level: 9 });
  const existing = db
    .prepare('select codec, raw_bytes, payload from payload_objects where hash=?')
    .get(ref.hash) as { codec: string; raw_bytes: number; payload: Buffer } | undefined;
  if (existing !== undefined) {
    if (existing.codec !== ref.codec || existing.raw_bytes !== ref.rawBytes)
      throw new PayloadFormatError('Payload reference metadata mismatch');
    const decoded = getPayload(db, ref);
    if (!sameBytes(decoded, bytes)) throw new PayloadFormatError('Payload hash collision');
    return ref;
  }
  db.prepare('insert into payload_objects(hash,codec,raw_bytes,payload) values(?,?,?,?)').run(
    ref.hash,
    ref.codec,
    ref.rawBytes,
    compressed,
  );
  return ref;
}

export function getPayload(db: Database.Database, ref: PayloadRef): Uint8Array {
  checkedRef(ref);
  const row = db
    .prepare('select codec, raw_bytes, payload from payload_objects where hash=?')
    .get(ref.hash) as { codec: string; raw_bytes: number; payload: Buffer } | undefined;
  if (row === undefined) throw new PayloadFormatError('Referenced payload object is missing');
  if (row.codec !== ref.codec || row.raw_bytes !== ref.rawBytes)
    throw new PayloadFormatError('Referenced payload metadata does not match');
  let decoded: Buffer;
  try {
    decoded = gunzipSync(row.payload, { maxOutputLength: MAX_PAYLOAD_BYTES });
  } catch {
    throw new PayloadFormatError('Referenced payload is not valid gzip');
  }
  if (decoded.byteLength !== ref.rawBytes)
    throw new PayloadFormatError('Referenced payload length does not match');
  if (hashBytes(decoded) !== ref.hash)
    throw new PayloadFormatError('Referenced payload hash mismatch');
  return new Uint8Array(decoded);
}

function revive<T>(text: string): T {
  return JSON.parse(text, (key, value: unknown) =>
    ['fromBlock', 'toBlock', 'blockNumber', 'firstBlock', 'number'].includes(key) &&
    typeof value === 'string' &&
    /^\d+$/.test(value)
      ? BigInt(value)
      : value,
  ) as T;
}

function batchBytes(batch: RecordedRangeBatch): Buffer {
  return Buffer.from(
    JSON.stringify(batch, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString(10) : value,
    ),
    'utf8',
  );
}

function isEnvelope(value: unknown): value is { format: string } {
  return typeof value === 'object' && value !== null && 'format' in value;
}

interface SingleReference {
  kind: 'single';
  ref: PayloadRef;
}

interface ChunkedReference {
  kind: 'chunked';
  refs: PayloadRef[];
  hash: string;
  rawBytes: number;
}

function asRef(value: unknown): PayloadRef {
  if (typeof value !== 'object' || value === null || (value as { version?: unknown }).version !== 1)
    throw new PayloadFormatError('Invalid batch payload reference');
  return value as PayloadRef;
}

function parseEnvelope(text: string): SingleReference | ChunkedReference {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PayloadFormatError('Batch payload is not valid JSON');
  }
  if (!isEnvelope(value)) throw new PayloadFormatError('Invalid batch payload envelope');
  if (value.format === 'batch-ref-v1')
    return { kind: 'single', ref: asRef((value as { payload?: unknown }).payload) };
  if (value.format === 'batch-ref-v2') {
    const chunked = value as { hash?: unknown; rawBytes?: unknown; payloads?: unknown };
    if (
      typeof chunked.hash !== 'string' ||
      !HASH_PATTERN.test(chunked.hash) ||
      !Number.isSafeInteger(chunked.rawBytes) ||
      (chunked.rawBytes as number) < 0 ||
      !Array.isArray(chunked.payloads)
    )
      throw new PayloadFormatError('Invalid chunked batch payload reference');
    const refs = chunked.payloads.map(asRef);
    for (const ref of refs) checkedRef(ref);
    return {
      kind: 'chunked',
      refs,
      hash: chunked.hash,
      rawBytes: chunked.rawBytes as number,
    };
  }
  throw new PayloadFormatError('Unknown batch payload format');
}

export function encodeBatchReference(ref: PayloadRef): string {
  checkedRef(ref);
  return JSON.stringify({ format: 'batch-ref-v1', payload: ref });
}

/** A logical batch larger than one object is stored as ordered opaque chunks
 * whose concatenation is verified against the whole-payload hash on read. */
function putChunkedPayload(
  db: Database.Database,
  raw: Buffer,
): { refs: PayloadRef[]; hash: string; rawBytes: number } {
  const refs: PayloadRef[] = [];
  for (let offset = 0; offset < raw.byteLength; offset += MAX_PAYLOAD_BYTES)
    refs.push(
      putPayload(db, raw.subarray(offset, Math.min(offset + MAX_PAYLOAD_BYTES, raw.byteLength))),
    );
  return { refs, hash: hashBytes(raw), rawBytes: raw.byteLength };
}

function encodeChunkedBatchReference(chunked: {
  refs: PayloadRef[];
  hash: string;
  rawBytes: number;
}): string {
  return JSON.stringify({
    format: 'batch-ref-v2',
    hash: chunked.hash,
    rawBytes: chunked.rawBytes,
    payloads: chunked.refs,
  });
}

/** Read a batch by id from either the legacy inline JSON or a compact reference. */
export function readBatch(db: Database.Database, batchId: string): RecordedRangeBatch {
  const row = db.prepare('select payload_json from ingest_batches where id=?').get(batchId) as
    { payload_json: string } | undefined;
  if (row === undefined) throw new PayloadFormatError('Ingest batch is missing');
  countWork('rawBatchDecodes');
  const trimmed = row.payload_json.trimStart();
  // Legacy payloads are parsed once; compact envelopes are deliberately parsed
  // once for the reference and once for their compressed logical payload.
  if (!/^\{\s*"format"\s*:/.test(trimmed)) return revive<RecordedRangeBatch>(row.payload_json);
  const envelope = parseEnvelope(row.payload_json);
  if (envelope.kind === 'single')
    return revive<RecordedRangeBatch>(Buffer.from(getPayload(db, envelope.ref)).toString('utf8'));
  const bytes = Buffer.concat(envelope.refs.map((ref) => Buffer.from(getPayload(db, ref))));
  if (bytes.byteLength !== envelope.rawBytes)
    throw new PayloadFormatError('Chunked payload length does not match');
  if (hashBytes(bytes) !== envelope.hash)
    throw new PayloadFormatError('Chunked payload hash mismatch');
  return revive<RecordedRangeBatch>(bytes.toString('utf8'));
}

function checkedHeight(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new PayloadFormatError('Batch height is outside the safe integer range');
  return Number(value);
}

function checkedTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new PayloadFormatError('Batch timestamp is invalid');
  return value;
}

function lower<T extends string>(value: T): T {
  return value.toLowerCase() as T;
}

function normalizeLog(log: RawLog): object {
  return {
    blockHash: lower(log.blockHash),
    blockNumber: log.blockNumber,
    transactionHash: lower(log.transactionHash),
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
    address: lower(log.address),
    topics: log.topics.map(lower),
    data: lower(log.data),
    rawBlockTimestamp: log.rawBlockTimestamp === null ? null : lower(log.rawBlockTimestamp),
  };
}

function normalizeRequest(shard: RecordedRangeBatch['manifest']['shards'][number]): object {
  return {
    fromBlock: shard.request.fromBlock,
    toBlock: shard.request.toBlock,
    address: shard.request.address.map(lower),
    topics: shard.request.topics.map((topic) =>
      typeof topic === 'string' ? lower(topic) : topic === null ? null : topic.map(lower),
    ),
  };
}

function canonicalBatch(batch: RecordedRangeBatch): object {
  return {
    id: batch.id,
    scopeId: batch.scopeId,
    fromBlock: batch.fromBlock,
    toBlock: batch.toBlock,
    end: { ...batch.end, hash: lower(batch.end.hash) },
    previous:
      batch.previous === null ? null : { ...batch.previous, hash: lower(batch.previous.hash) },
    logs: batch.logs.map(normalizeLog),
    observedAtMs: batch.observedAtMs,
    captureMode: batch.captureMode,
    filterPlanHash: batch.filterPlanHash,
    manifestHash: batch.manifestHash,
    completeness: batch.completeness,
    manifest: {
      ...batch.manifest,
      shards: batch.manifest.shards.map((shard) => ({
        ...shard,
        request: normalizeRequest(shard),
      })),
    },
    ...(batch.logTimes === undefined ? {} : { logTimes: batch.logTimes }),
    ...(batch.anchors === undefined ? {} : { anchors: batch.anchors }),
    ...(batch.boundaries === undefined ? {} : { boundaries: batch.boundaries }),
    ...(batch.poolRegistrations === undefined
      ? {}
      : { poolRegistrations: batch.poolRegistrations }),
    ...(batch.registryMode === undefined ? {} : { registryMode: batch.registryMode }),
  };
}

function sameTransport(left: RecordedRangeBatch, right: RecordedRangeBatch): boolean {
  return encodeJson(canonicalBatch(left)) === encodeJson(canonicalBatch(right));
}

function rawKey(log: RawLog): string {
  return `${CHAIN_ID}:${log.blockHash.toLowerCase()}:${log.transactionHash.toLowerCase()}:${log.logIndex}`;
}

function rawPayload(log: RawLog): string {
  return JSON.stringify(normalizeLog(log), (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString(10) : value,
  );
}

function persistRawLog(db: Database.Database, log: RawLog): void {
  const key = rawKey(log);
  const payload = rawPayload(log);
  const existing = db.prepare('select payload_json from raw_logs where raw_key=?').get(key) as
    { payload_json: string } | undefined;
  if (existing !== undefined) {
    const existingValue = JSON.parse(existing.payload_json) as Record<string, unknown>;
    const nextValue = JSON.parse(payload) as Record<string, unknown>;
    delete existingValue.rawBlockTimestamp;
    delete nextValue.rawBlockTimestamp;
    if (JSON.stringify(existingValue) !== JSON.stringify(nextValue))
      throw new PayloadFormatError('Raw log payload is immutable');
    return;
  }
  db.prepare(
    `insert into raw_logs(
       raw_key,chain_id,block_hash,block_number,transaction_hash,transaction_index,
       log_index,address,topics_json,data,raw_block_timestamp,payload_json
     ) values(?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    key,
    CHAIN_ID,
    lower(log.blockHash),
    checkedHeight(log.blockNumber),
    lower(log.transactionHash),
    log.transactionIndex,
    log.logIndex,
    lower(log.address),
    JSON.stringify(log.topics.map(lower)),
    lower(log.data),
    log.rawBlockTimestamp === null ? null : lower(log.rawBlockTimestamp),
    payload,
  );
}

/** Persist the batch transport and raw logs as one compact, content-addressed transaction. */
export function writeCompactBatch(db: Database.Database, batch: RecordedRangeBatch): void {
  checkedHeight(batch.fromBlock);
  checkedHeight(batch.toBlock);
  checkedHeight(batch.end.number);
  checkedTimestamp(batch.end.timestampSec);
  checkedTimestamp(batch.observedAtMs);
  const raw = batchBytes(batch);
  db.transaction(() => {
    // A single RPC shard limit does not bound the merged batch, so oversized
    // logical batches must be split instead of being rejected after the fetch.
    const payloadJson =
      raw.byteLength > MAX_PAYLOAD_BYTES
        ? encodeChunkedBatchReference(putChunkedPayload(db, raw))
        : encodeBatchReference(putPayload(db, raw));
    const existing = db
      .prepare('select payload_json from ingest_batches where id=?')
      .get(batch.id) as { payload_json: string } | undefined;
    if (existing !== undefined) {
      const current = readBatch(db, batch.id);
      if (!sameTransport(current, batch))
        throw new PayloadFormatError('Ingest batch transport payload is immutable');
      if (existing.payload_json !== payloadJson)
        db.prepare('update ingest_batches set payload_json=? where id=?').run(
          payloadJson,
          batch.id,
        );
    } else {
      db.prepare(
        `insert into ingest_batches(
           id,scope_id,chain_id,from_block,to_block,end_hash,end_timestamp_sec,observed_at_ms,
           capture_mode,filter_plan_hash,manifest_hash,completeness,payload_json
         ) values(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        batch.id,
        batch.scopeId,
        CHAIN_ID,
        checkedHeight(batch.fromBlock),
        checkedHeight(batch.toBlock),
        lower(batch.end.hash),
        batch.end.timestampSec,
        batch.observedAtMs,
        batch.captureMode,
        batch.filterPlanHash,
        batch.manifestHash,
        batch.completeness,
        payloadJson,
      );
      const insertShard = db.prepare(
        `insert into fetch_shards(
           batch_id,shard_id,filter_id,from_block,to_block,status,response_hash,log_count,error
         ) values(?,?,?,?,?,?,?,?,?)`,
      );
      for (const shard of batch.manifest.shards)
        insertShard.run(
          batch.id,
          shard.shardId,
          shard.filterId,
          checkedHeight(shard.request.fromBlock),
          checkedHeight(shard.request.toBlock),
          shard.status,
          shard.responseHash,
          shard.logCount,
          shard.error,
        );
    }
    for (const log of batch.logs) persistRawLog(db, log);
  })();
}
