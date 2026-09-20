-- Track raw evidence dependencies so a raw-log change invalidates only the proofs
-- that named that log. The legacy global epoch remains for old proof rows and
-- payload-object changes.
CREATE TABLE IF NOT EXISTS batch_coverage_source_epochs (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  raw_epoch INTEGER NOT NULL,
  payload_epoch INTEGER NOT NULL
);
INSERT OR IGNORE INTO batch_coverage_source_epochs(id, raw_epoch, payload_epoch)
VALUES (1, 0, 0);

CREATE TABLE IF NOT EXISTS batch_coverage_dependencies (
  batch_id TEXT NOT NULL REFERENCES ingest_batches(id) ON DELETE CASCADE,
  raw_log_id INTEGER NOT NULL REFERENCES raw_logs(id) ON DELETE CASCADE,
  PRIMARY KEY(batch_id, raw_log_id)
);
CREATE INDEX IF NOT EXISTS batch_coverage_dependencies_raw_log
  ON batch_coverage_dependencies(raw_log_id, batch_id);

CREATE TRIGGER IF NOT EXISTS batch_coverage_raw_evidence_update
AFTER UPDATE ON raw_logs
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
  UPDATE batch_coverage_source_epochs SET raw_epoch = raw_epoch + 1 WHERE id = 1;
  DELETE FROM batch_coverage_proofs
   WHERE batch_id IN (
     SELECT batch_id FROM batch_coverage_dependencies WHERE raw_log_id = old.id
   );
END;

CREATE TRIGGER IF NOT EXISTS batch_coverage_raw_evidence_delete
BEFORE DELETE ON raw_logs
BEGIN
  UPDATE batch_coverage_source_epochs SET raw_epoch = raw_epoch + 1 WHERE id = 1;
  DELETE FROM batch_coverage_proofs
   WHERE batch_id IN (
     SELECT batch_id FROM batch_coverage_dependencies WHERE raw_log_id = old.id
   );
END;

CREATE TRIGGER IF NOT EXISTS batch_coverage_payload_update
AFTER UPDATE ON payload_objects
WHEN new.hash IS NOT old.hash
  OR new.codec IS NOT old.codec
  OR new.raw_bytes IS NOT old.raw_bytes
  OR new.payload IS NOT old.payload
BEGIN
  UPDATE batch_coverage_source_epochs SET payload_epoch = payload_epoch + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS batch_coverage_payload_delete
AFTER DELETE ON payload_objects
BEGIN
  UPDATE batch_coverage_source_epochs SET payload_epoch = payload_epoch + 1 WHERE id = 1;
END;

