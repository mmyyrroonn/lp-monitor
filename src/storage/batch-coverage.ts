import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { encodeJson } from '../domain/json.js';
import {
  completePartitions,
  successfulShardRowsMatch,
  type StoredShardRow,
} from '../ingest/completeness.js';
import type { RecordedRangeBatch } from './manifest.js';

/**
 * What a stored batch was verified against when it was accepted. A reader may take the proof
 * instead of decoding the batch again, as long as every fact recorded here still matches.
 *
 * The proof is evidence about *this database's rows*, not a substitute for reading raw evidence:
 * an audit that has to re-derive coverage from the payload itself still decodes it.
 */
export interface BatchCoverageProof {
  version: 1;
  batchId: string;
  scopeId: string;
  fromBlock: string;
  toBlock: string;
  manifestHash: string;
  /**
   * The stored payload, described by its byte length. An accepted batch is stored inline (a
   * dependency-carrying compact batch is the whole batch), so the fast path must not read that
   * text: a rewrite of the row drops this proof through the `ingest_batches` trigger instead.
   */
  payloadRefDigest: string;
  /** The batch's shard rows as they stood when the proof was taken. */
  shardDigest: string;
  /** The raw-evidence epoch this proof was taken at. */
  mutationEpoch: number;
  /** The filter families the accepted batch covered. */
  filters: readonly string[];
}

type BatchRow = {
  scope_id: string;
  from_block: number;
  to_block: number;
  manifest_hash: string;
  bytes: number;
};

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const payloadReference = (bytes: number) => digest(encodeJson({ version: 1, bytes }));
const shardReference = (rows: readonly StoredShardRow[]) => digest(JSON.stringify(rows));
const decimal = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);

/** A proof row is only usable if it is well formed on its own terms; the digest above it proves
 * nobody edited it by hand, not that the writer knew the contract. */
function wellFormed(proof: BatchCoverageProof, batchId: string): boolean {
  return (
    typeof proof === 'object' &&
    proof !== null &&
    proof.version === 1 &&
    proof.batchId === batchId &&
    typeof proof.scopeId === 'string' &&
    decimal(proof.fromBlock) &&
    decimal(proof.toBlock) &&
    typeof proof.manifestHash === 'string' &&
    typeof proof.payloadRefDigest === 'string' &&
    typeof proof.shardDigest === 'string' &&
    Number.isSafeInteger(proof.mutationEpoch) &&
    Array.isArray(proof.filters) &&
    // An empty filter list would make every accepted interval vacuously covered.
    proof.filters.length > 0 &&
    proof.filters.every((filter) => typeof filter === 'string' && filter.length > 0)
  );
}

/** A legacy or readonly snapshot has no proof table; asking it for one is never an error. */
const proofTables = new WeakMap<Database.Database, boolean>();

export class BatchCoverageStore {
  constructor(private readonly database: Database.Database) {}

  /**
   * Record that `batch` just passed strict verification, inside the accepting transaction. Never
   * called from a reader: proofs are written where the acceptance decision is made, so a reader
   * cannot promote its own cached opinion into evidence.
   */
  accept(batch: RecordedRangeBatch): void {
    if (!this.available()) return;
    // persistTransport stores the batch before this call; a batch this database does not hold is
    // not evidence it can vouch for, so it simply gets no proof.
    const row = this.storedBatch(batch.id);
    if (row === undefined) return;
    const shards = this.shards(batch.id);
    // A proof may only restate what the strict reader would have concluded, so that reader's own
    // two predicates decide whether a proof may exist at all. A batch failing them keeps its
    // strict read path: it is stored with its shard evidence, but establishing its coverage takes
    // a decode.
    if (!successfulShardRowsMatch(shards, batch) || !completePartitions(batch)) return;
    const proof: BatchCoverageProof = {
      version: 1,
      batchId: batch.id,
      scopeId: row.scope_id,
      fromBlock: String(row.from_block),
      toBlock: String(row.to_block),
      manifestHash: row.manifest_hash,
      payloadRefDigest: payloadReference(row.bytes),
      shardDigest: shardReference(shards),
      mutationEpoch: this.epoch(),
      filters: [...new Set(batch.manifest.shards.map((shard) => shard.filterId))],
    };
    const proofJson = encodeJson(proof);
    this.database
      .prepare(
        `insert or replace into batch_coverage_proofs(batch_id, proof_json, proof_digest)
         values (?, ?, ?)`,
      )
      .run(batch.id, proofJson, digest(proofJson));
  }

  /**
   * The proof for a batch, or null when there is none or it no longer describes what is stored.
   * Every reason to distrust it returns null rather than an exception: the caller falls back to
   * verifying the batch itself, which is always allowed to answer.
   */
  read(batchId: string): BatchCoverageProof | null {
    if (!this.available()) return null;
    const stored = this.database
      .prepare('select proof_json, proof_digest from batch_coverage_proofs where batch_id = ?')
      .get(batchId) as { proof_json: string; proof_digest: string } | undefined;
    if (stored === undefined) return null;
    // The proof carries its own digest, so a hand-edited row is refused rather than trusted.
    if (digest(stored.proof_json) !== stored.proof_digest) return null;
    let proof: BatchCoverageProof;
    try {
      proof = JSON.parse(stored.proof_json) as BatchCoverageProof;
    } catch {
      return null;
    }
    if (!wellFormed(proof, batchId)) return null;
    const row = this.storedBatch(batchId);
    if (row === undefined) return null;
    if (
      row.scope_id !== proof.scopeId ||
      String(row.from_block) !== proof.fromBlock ||
      String(row.to_block) !== proof.toBlock ||
      row.manifest_hash !== proof.manifestHash
    )
      return null;
    if (payloadReference(row.bytes) !== proof.payloadRefDigest) return null;
    if (shardReference(this.shards(batchId)) !== proof.shardDigest) return null;
    if (this.epoch() !== proof.mutationEpoch) return null;
    return proof;
  }

  private available(): boolean {
    let known = proofTables.get(this.database);
    if (known === undefined) {
      known =
        this.database
          .prepare(
            "select 1 from sqlite_master where type = 'table' and name = 'batch_coverage_proofs'",
          )
          .get() !== undefined;
      proofTables.set(this.database, known);
    }
    return known;
  }

  /** The batch row as the proof describes it. The payload is measured, never read: `length()`
   * comes from the value header, so an inline batch's text stays in the page cache. */
  private storedBatch(batchId: string): BatchRow | undefined {
    return this.database
      .prepare(
        `select scope_id, from_block, to_block, manifest_hash, length(payload_json) as bytes
         from ingest_batches where id = ?`,
      )
      .get(batchId) as BatchRow | undefined;
  }

  /** The projection the metrics coverage compares a batch against, in the same order it reads it. */
  private shards(batchId: string): StoredShardRow[] {
    return this.database
      .prepare(
        `select shard_id, status, response_hash, log_count, error
         from fetch_shards where batch_id = ? order by shard_id`,
      )
      .all(batchId) as StoredShardRow[];
  }

  private epoch(): number {
    const row = this.database
      .prepare('select epoch from batch_coverage_epoch where id = 1')
      .get() as { epoch: number } | undefined;
    return row?.epoch ?? 0;
  }
}
