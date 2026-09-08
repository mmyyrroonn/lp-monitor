CREATE TABLE IF NOT EXISTS projection_cursors (
  scope_id TEXT PRIMARY KEY,
  registry_scope_id TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projected_events (
  scope_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  pool_id TEXT,
  kind TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  minute_start_sec INTEGER,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(scope_id, event_id)
);
CREATE TABLE IF NOT EXISTS pool_observations (
  scope_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(scope_id, pool_id)
);
CREATE TABLE IF NOT EXISTS projection_quality_errors (
  scope_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  code TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(scope_id, event_id, code)
);
CREATE INDEX IF NOT EXISTS projected_events_minute ON projected_events(scope_id, minute_start_sec);
