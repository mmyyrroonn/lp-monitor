CREATE TABLE IF NOT EXISTS signal_snapshots (
 scope_id TEXT NOT NULL, pool_id TEXT NOT NULL, payload_json TEXT NOT NULL,
 PRIMARY KEY(scope_id,pool_id)
);
CREATE TABLE IF NOT EXISTS signal_cursors (
 scope_id TEXT PRIMARY KEY, config_hash TEXT NOT NULL, source_hash TEXT NOT NULL,
 epoch TEXT NOT NULL, block_number TEXT NOT NULL, block_hash TEXT NOT NULL,
 evidence_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS signal_evaluations (
 scope_id TEXT NOT NULL, batch_id TEXT NOT NULL, source_hash TEXT NOT NULL,
 pool_id TEXT NOT NULL, payload_json TEXT NOT NULL,
 PRIMARY KEY(scope_id,batch_id,source_hash,pool_id)
);
CREATE TABLE IF NOT EXISTS alerts (
 scope_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
 capture_mode TEXT NOT NULL CHECK(capture_mode IN ('live','backfill','synthetic')),
 active INTEGER NOT NULL CHECK(active IN (0,1)), payload_json TEXT NOT NULL,
 PRIMARY KEY(scope_id,id)
);
CREATE TABLE IF NOT EXISTS alert_outbox (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 scope_id TEXT NOT NULL, alert_id TEXT NOT NULL, revision INTEGER NOT NULL,
 capture_mode TEXT NOT NULL CHECK(capture_mode IN ('live','backfill','synthetic')),
 status TEXT NOT NULL CHECK(status IN ('pending','sent','failed','superseded')),
 attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, payload_json TEXT NOT NULL,
 UNIQUE(scope_id,alert_id,revision)
);
-- Partial indexes keep terminal history out of the pending delivery scan.
CREATE INDEX IF NOT EXISTS alert_outbox_live_pending_scope ON alert_outbox(scope_id,sequence)
 WHERE capture_mode='live' AND status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS alert_outbox_live_pending ON alert_outbox(sequence)
 WHERE capture_mode='live' AND status IN ('pending','failed');
-- Existing 004 databases also receive the same constraints without rebuilding
-- or risking loss of their durable alerts/outbox.
CREATE TRIGGER IF NOT EXISTS alerts_validate_insert BEFORE INSERT ON alerts
 WHEN new.capture_mode NOT IN ('live','backfill','synthetic') OR new.active NOT IN (0,1)
 BEGIN SELECT RAISE(ABORT,'invalid alert mode or active flag'); END;
CREATE TRIGGER IF NOT EXISTS alerts_validate_update BEFORE UPDATE ON alerts
 WHEN new.capture_mode NOT IN ('live','backfill','synthetic') OR new.active NOT IN (0,1)
 BEGIN SELECT RAISE(ABORT,'invalid alert mode or active flag'); END;