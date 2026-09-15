-- A coverage proof records that a stored batch was verified complete when it was accepted, and the
-- facts it was verified against. A reader may take the proof instead of decoding the batch again,
-- as long as nothing it was computed from has moved.
CREATE TABLE IF NOT EXISTS batch_coverage_proofs (
  batch_id TEXT PRIMARY KEY REFERENCES ingest_batches(id) ON DELETE CASCADE,
  proof_json TEXT NOT NULL,
  proof_digest TEXT NOT NULL
);

-- One row, so a content change to raw evidence or to a payload object is a single integer
-- comparison for every proof, instead of a scan over every batch a reader might rely on.
CREATE TABLE IF NOT EXISTS batch_coverage_epoch (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  epoch INTEGER NOT NULL
);
INSERT OR IGNORE INTO batch_coverage_epoch(id, epoch) VALUES (1, 0);

-- Only a real content change counts. The live path re-writes the same raw log and the same payload
-- object with identical bytes (insert or ignore, or an upsert of the same value), and counting
-- those would clear every proof on every round for nothing.
CREATE TRIGGER IF NOT EXISTS raw_logs_evidence_change AFTER UPDATE ON raw_logs
WHEN new.raw_key IS NOT old.raw_key
  OR new.chain_id IS NOT old.chain_id
  OR new.block_hash IS NOT old.block_hash
  OR new.block_number IS NOT old.block_number
  OR new.transaction_hash IS NOT old.transaction_hash
  OR new.transaction_index IS NOT old.transaction_index
  OR new.log_index IS NOT old.log_index
  OR new.address IS NOT old.address
  OR new.topics_json IS NOT old.topics_json
  OR new.data IS NOT old.data
  OR new.raw_block_timestamp IS NOT old.raw_block_timestamp
  OR new.payload_json IS NOT old.payload_json
BEGIN
  UPDATE batch_coverage_epoch SET epoch = epoch + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS raw_logs_evidence_delete AFTER DELETE ON raw_logs
BEGIN
  UPDATE batch_coverage_epoch SET epoch = epoch + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS payload_object_change AFTER UPDATE ON payload_objects
WHEN new.hash IS NOT old.hash
  OR new.codec IS NOT old.codec
  OR new.raw_bytes IS NOT old.raw_bytes
  OR new.payload IS NOT old.payload
BEGIN
  UPDATE batch_coverage_epoch SET epoch = epoch + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS payload_object_delete AFTER DELETE ON payload_objects
BEGIN
  UPDATE batch_coverage_epoch SET epoch = epoch + 1 WHERE id = 1;
END;

-- A batch row or one of its shard rows that moves is that batch's own business: its proof is
-- dropped rather than every proof in the database. The payload is not read on the fast path, so a
-- rewrite of the stored payload is what makes this drop load-bearing.
CREATE TRIGGER IF NOT EXISTS ingest_batch_change AFTER UPDATE ON ingest_batches
BEGIN
  DELETE FROM batch_coverage_proofs WHERE batch_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS ingest_batch_delete AFTER DELETE ON ingest_batches
BEGIN
  DELETE FROM batch_coverage_proofs WHERE batch_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS fetch_shard_change AFTER UPDATE ON fetch_shards
BEGIN
  DELETE FROM batch_coverage_proofs WHERE batch_id = old.batch_id;
END;

CREATE TRIGGER IF NOT EXISTS fetch_shard_delete AFTER DELETE ON fetch_shards
BEGIN
  DELETE FROM batch_coverage_proofs WHERE batch_id = old.batch_id;
END;
