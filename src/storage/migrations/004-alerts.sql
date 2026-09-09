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
 capture_mode TEXT NOT NULL, active INTEGER NOT NULL, payload_json TEXT NOT NULL,
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