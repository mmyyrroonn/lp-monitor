-- Unknown consumers are not enrolled on migration. Their shared facts stay pinned.
CREATE TABLE IF NOT EXISTS retention_consumers (
  scope_id TEXT PRIMARY KEY,
  registry_scope_id TEXT NOT NULL,
  raw_retention_sec INTEGER CHECK(raw_retention_sec IS NULL OR raw_retention_sec >= 0),
  live_retention_sec INTEGER NOT NULL CHECK(live_retention_sec >= 0),
  required_lookback_sec INTEGER NOT NULL CHECK(required_lookback_sec >= 0),
  overlap_blocks INTEGER NOT NULL CHECK(overlap_blocks >= 0)
);

-- No lease timeout: a paused/crashed history or replay consumer still owns its input.
CREATE TABLE IF NOT EXISTS retention_pins (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('history','replay')),
  status TEXT NOT NULL CHECK(status IN ('active','released')),
  created_at_ms INTEGER NOT NULL
);
INSERT OR IGNORE INTO retention_pins(id,kind,status,created_at_ms)
  SELECT 'history:' || id,'history','active',updated_at_ms FROM history_jobs;
CREATE TRIGGER IF NOT EXISTS history_job_retention_pin AFTER INSERT ON history_jobs BEGIN
  INSERT OR IGNORE INTO retention_pins(id,kind,status,created_at_ms)
    VALUES ('history:' || new.id,'history','active',new.updated_at_ms);
END;

-- A bounded expiry can leave rows below these conservative availability floors.
-- Those residual rows do not establish complete retained history.
CREATE TABLE IF NOT EXISTS retention_expirations (
  scope_id TEXT PRIMARY KEY,
  raw_before_block INTEGER NOT NULL DEFAULT 0,
  raw_before_sec INTEGER NOT NULL DEFAULT 0,
  live_before_sec INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ingest_batches_retention ON ingest_batches(scope_id,end_timestamp_sec,id);
CREATE INDEX IF NOT EXISTS ingest_batches_block_bounds ON ingest_batches(chain_id,from_block,to_block);
CREATE INDEX IF NOT EXISTS pools_retention_raw_log ON pools(discovered_raw_log_id);
CREATE INDEX IF NOT EXISTS accepted_ranges_retention_bounds ON accepted_ranges(from_block,to_block);
CREATE INDEX IF NOT EXISTS accepted_ranges_batch ON accepted_ranges(batch_id);
CREATE INDEX IF NOT EXISTS log_times_retention_raw ON log_times(raw_log_id,scope_id);
CREATE INDEX IF NOT EXISTS live_events_retention_raw ON live_events(raw_log_id,scope_id);
CREATE INDEX IF NOT EXISTS live_errors_retention_raw ON live_quality_errors(raw_log_id,scope_id);
CREATE INDEX IF NOT EXISTS live_inputs_retention_raw ON live_inputs(raw_log_id,scope_id);

-- Availability loss refreshes coverage, but is not a correction to retained signal evidence.
CREATE TABLE IF NOT EXISTS live_dirty_retention(scope_id TEXT PRIMARY KEY);
DROP TRIGGER IF EXISTS retention_expiration_insert;
CREATE TRIGGER retention_expiration_insert AFTER INSERT ON retention_expirations BEGIN
  INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES(new.scope_id,1,0)
    ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1;
  INSERT INTO live_dirty_retention(scope_id) VALUES(new.scope_id)
    ON CONFLICT(scope_id) DO NOTHING;
END;
DROP TRIGGER IF EXISTS retention_expiration_update;
CREATE TRIGGER retention_expiration_update AFTER UPDATE ON retention_expirations
WHEN new.raw_before_block > old.raw_before_block OR new.raw_before_sec > old.raw_before_sec
  OR new.live_before_sec > old.live_before_sec BEGIN
  INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES(new.scope_id,1,0)
    ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1;
  INSERT INTO live_dirty_retention(scope_id) VALUES(new.scope_id)
    ON CONFLICT(scope_id) DO NOTHING;
END;

-- Raw retention records the availability floor before removing its accepted ranges.
-- Deleting already unavailable ranges must not enqueue source-history signal repair.
-- Genuine repairs already queued, or ranges outside the expired prefix, are untouched.
DROP TRIGGER IF EXISTS live_coverage_ranges_delete;
CREATE TRIGGER live_coverage_ranges_delete AFTER DELETE ON accepted_ranges
WHEN NOT EXISTS(SELECT 1 FROM retention_expirations
  WHERE scope_id=old.scope_id AND old.to_block<raw_before_block) BEGIN
  INSERT INTO live_dirty_coverage SELECT old.scope_id,old.from_block
    WHERE EXISTS(SELECT 1 FROM live_projection_cursors
      WHERE scope_id=old.scope_id AND block_number>=old.from_block)
    ON CONFLICT(scope_id) DO UPDATE SET min_block=min(min_block,excluded.min_block);
END;
