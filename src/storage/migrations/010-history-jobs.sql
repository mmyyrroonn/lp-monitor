CREATE TABLE IF NOT EXISTS history_jobs (
  id TEXT PRIMARY KEY,
  spec_hash TEXT NOT NULL,
  source_database_path TEXT NOT NULL,
  study_database_path TEXT NOT NULL UNIQUE,
  spec_json TEXT NOT NULL,
  input_snapshots_json TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  missing_json TEXT NOT NULL,
  registry_missing_json TEXT NOT NULL,
  operation_missing_json TEXT NOT NULL,
  time_unknown_json TEXT NOT NULL,
  unpriced_json TEXT NOT NULL,
  cumulative_rpc_calls INTEGER NOT NULL DEFAULT 0,
  current_run_rpc_calls INTEGER NOT NULL DEFAULT 0,
  raw_events_added INTEGER NOT NULL DEFAULT 0,
  raw_bytes_added INTEGER NOT NULL DEFAULT 0,
  completed_coverage_json TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS history_jobs_status ON history_jobs(status);