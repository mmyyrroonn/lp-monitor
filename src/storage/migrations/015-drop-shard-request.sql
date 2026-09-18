-- 015: drop fetch_shards.request_json.
--
-- The column stored the shard's normalized request object, but nothing ever selected it: the four
-- readers of fetch_shards take shard_id, status, response_hash, log_count and error, and the same
-- request bytes already travel inside ingest_batches.payload_json under the batch's manifest hash.
-- Storing it a second time made every shard row roughly as large as the batch payload it belonged
-- to, and it was the single largest column in the database.
--
-- ALTER TABLE ... DROP COLUMN has no IF EXISTS form, so unlike every migration above this one is
-- not safe to re-run: the second run fails with "no such column". database.ts therefore applies it
-- only while the column is still present, the same way it already guards the pools.protocol and
-- history_jobs.notes_json additions. This file is deliberately not part of the re-run-safe list.
--
-- Dropping a column rewrites the table. That rewrite is not an ordinary UPDATE: it does not fire
-- the AFTER UPDATE / AFTER DELETE triggers on fetch_shards that 012 installed, so batch coverage
-- proofs survive it untouched.

ALTER TABLE fetch_shards DROP COLUMN request_json;
