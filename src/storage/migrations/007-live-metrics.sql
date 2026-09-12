CREATE TABLE IF NOT EXISTS live_metric_cache (
  scope_id TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  minute_start_sec INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(scope_id,cache_key)
);
CREATE INDEX IF NOT EXISTS live_metric_cache_expiry ON live_metric_cache(scope_id,minute_start_sec);
