CREATE INDEX IF NOT EXISTS log_times_scope_minute
  ON log_times(scope_id, minute_start_sec, raw_log_id)
  WHERE minute_start_sec IS NOT NULL;

CREATE INDEX IF NOT EXISTS log_times_scope_exact
  ON log_times(scope_id, exact_timestamp_sec, raw_log_id)
  WHERE exact_timestamp_sec IS NOT NULL;
CREATE INDEX IF NOT EXISTS accepted_ranges_scope_bounds
  ON accepted_ranges(scope_id, to_block, from_block, batch_id);
