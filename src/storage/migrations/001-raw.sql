PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ingest_batches (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  from_block INTEGER NOT NULL,
  to_block INTEGER NOT NULL,
  end_hash TEXT NOT NULL,
  end_timestamp_sec INTEGER NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  capture_mode TEXT NOT NULL,
  filter_plan_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  completeness TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fetch_shards (
  batch_id TEXT NOT NULL REFERENCES ingest_batches(id) ON DELETE CASCADE,
  shard_id TEXT NOT NULL,
  filter_id TEXT NOT NULL,
  from_block INTEGER NOT NULL,
  to_block INTEGER NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL,
  response_hash TEXT,
  log_count INTEGER NOT NULL,
  error TEXT,
  PRIMARY KEY (batch_id, shard_id)
);

CREATE TABLE IF NOT EXISTS raw_logs (
  id INTEGER PRIMARY KEY,
  raw_key TEXT NOT NULL UNIQUE,
  chain_id INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  transaction_hash TEXT NOT NULL,
  transaction_index INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  address TEXT NOT NULL,
  topics_json TEXT NOT NULL,
  data TEXT NOT NULL,
  raw_block_timestamp TEXT,
  payload_json TEXT NOT NULL,
  UNIQUE (chain_id, block_hash, transaction_hash, log_index)
);

CREATE TABLE IF NOT EXISTS accepted_ranges (
  scope_id TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES ingest_batches(id),
  filter_id TEXT NOT NULL,
  from_block INTEGER NOT NULL,
  to_block INTEGER NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  PRIMARY KEY (scope_id, batch_id, filter_id, from_block, to_block)
);

CREATE TABLE IF NOT EXISTS active_logs (
  scope_id TEXT NOT NULL,
  filter_id TEXT NOT NULL,
  raw_log_id INTEGER NOT NULL REFERENCES raw_logs(id),
  PRIMARY KEY (scope_id, filter_id, raw_log_id)
);

CREATE TABLE IF NOT EXISTS scope_cursors (
  scope_id TEXT PRIMARY KEY,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp_sec INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS anchors (
  scope_id TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp_sec INTEGER NOT NULL,
  PRIMARY KEY (scope_id, block_number, block_hash)
);

CREATE TABLE IF NOT EXISTS minute_boundaries (
  scope_id TEXT NOT NULL,
  timestamp_sec INTEGER NOT NULL,
  first_block INTEGER NOT NULL,
  before_number INTEGER NOT NULL,
  before_hash TEXT NOT NULL,
  before_timestamp_sec INTEGER NOT NULL,
  at_number INTEGER NOT NULL,
  at_hash TEXT NOT NULL,
  at_timestamp_sec INTEGER NOT NULL,
  PRIMARY KEY (scope_id, timestamp_sec)
);

CREATE TABLE IF NOT EXISTS log_times (
  scope_id TEXT NOT NULL,
  raw_log_id INTEGER NOT NULL REFERENCES raw_logs(id),
  minute_start_sec INTEGER,
  exact_timestamp_sec INTEGER,
  source TEXT NOT NULL,
  boundary_timestamp_sec INTEGER,
  PRIMARY KEY (scope_id, raw_log_id)
);

CREATE TABLE IF NOT EXISTS pools (
  scope_id TEXT NOT NULL,
  pool_key TEXT NOT NULL,
  protocol TEXT,
  discovered_raw_log_id INTEGER NOT NULL REFERENCES raw_logs(id),
  discovered_block_number INTEGER NOT NULL,
  discovered_block_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (scope_id, pool_key, discovered_raw_log_id)
);

CREATE TABLE IF NOT EXISTS range_invalidations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL,
  from_block INTEGER NOT NULL,
  to_block INTEGER NOT NULL,
  reason TEXT NOT NULL,
  UNIQUE (scope_id, from_block, to_block, reason)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  scope_id TEXT,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  record_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  scope_id TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  timestamp_sec INTEGER NOT NULL,
  batch_id TEXT,
  PRIMARY KEY (scope_id, block_number)
);

CREATE INDEX IF NOT EXISTS active_logs_scope ON active_logs(scope_id, raw_log_id);
CREATE INDEX IF NOT EXISTS raw_logs_height ON raw_logs(block_number);
CREATE INDEX IF NOT EXISTS checkpoints_scope_time ON checkpoints(scope_id, timestamp_sec);
