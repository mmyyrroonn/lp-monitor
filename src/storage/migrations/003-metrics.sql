CREATE TABLE IF NOT EXISTS metric_windows (
  scope_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  minute_start_sec INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(scope_id,pool_id,minute_start_sec)
);
CREATE TABLE IF NOT EXISTS metric_cursors (
  scope_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  projection_source_hash TEXT NOT NULL,
  block_number TEXT NOT NULL,
  block_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
