CREATE TABLE IF NOT EXISTS live_source_revisions(scope_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, registry_revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS live_projection_cursors(scope_id TEXT PRIMARY KEY, registry_scope_id TEXT NOT NULL, config_version TEXT NOT NULL, version TEXT NOT NULL, source_hash TEXT NOT NULL, registry_json TEXT NOT NULL, block_number INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS live_dirty_logs(scope_id TEXT NOT NULL, raw_log_id INTEGER NOT NULL, PRIMARY KEY(scope_id,raw_log_id));
CREATE TABLE IF NOT EXISTS live_events(scope_id TEXT NOT NULL, raw_log_id INTEGER NOT NULL, pool_id TEXT, kind TEXT NOT NULL, block_number INTEGER NOT NULL, transaction_index INTEGER NOT NULL, log_index INTEGER NOT NULL, minute_start_sec INTEGER, payload_json TEXT NOT NULL, PRIMARY KEY(scope_id,raw_log_id));
CREATE TABLE IF NOT EXISTS live_quality_errors(scope_id TEXT NOT NULL, raw_log_id INTEGER NOT NULL, code TEXT NOT NULL, block_number INTEGER NOT NULL, minute_start_sec INTEGER, payload_json TEXT NOT NULL, PRIMARY KEY(scope_id,raw_log_id,code));
CREATE TABLE IF NOT EXISTS live_observations(scope_id TEXT NOT NULL,pool_id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(scope_id,pool_id));
CREATE INDEX IF NOT EXISTS live_events_window ON live_events(scope_id,minute_start_sec,block_number);
CREATE INDEX IF NOT EXISTS live_errors_window ON live_quality_errors(scope_id,minute_start_sec,block_number);
CREATE INDEX IF NOT EXISTS live_events_latest ON live_events(scope_id,pool_id,kind,block_number DESC,transaction_index DESC,log_index DESC);
CREATE INDEX IF NOT EXISTS raw_logs_address ON raw_logs(lower(address));
CREATE INDEX IF NOT EXISTS active_logs_raw ON active_logs(raw_log_id,scope_id);
CREATE TRIGGER IF NOT EXISTS live_active_logs_INSERT AFTER INSERT ON active_logs BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (new.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
INSERT INTO live_dirty_logs SELECT new.scope_id,new.raw_log_id WHERE EXISTS(SELECT 1 FROM live_projection_cursors WHERE scope_id=new.scope_id) ON CONFLICT(scope_id,raw_log_id) DO NOTHING;
 END;
CREATE TRIGGER IF NOT EXISTS live_active_logs_UPDATE AFTER UPDATE ON active_logs BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (old.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
INSERT INTO live_dirty_logs SELECT old.scope_id,old.raw_log_id WHERE EXISTS(SELECT 1 FROM live_projection_cursors WHERE scope_id=old.scope_id) ON CONFLICT(scope_id,raw_log_id) DO NOTHING;
INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (new.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
INSERT INTO live_dirty_logs SELECT new.scope_id,new.raw_log_id WHERE EXISTS(SELECT 1 FROM live_projection_cursors WHERE scope_id=new.scope_id) ON CONFLICT(scope_id,raw_log_id) DO NOTHING;
 END;
CREATE TRIGGER IF NOT EXISTS live_active_logs_DELETE AFTER DELETE ON active_logs BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (old.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
INSERT INTO live_dirty_logs SELECT old.scope_id,old.raw_log_id WHERE EXISTS(SELECT 1 FROM live_projection_cursors WHERE scope_id=old.scope_id) ON CONFLICT(scope_id,raw_log_id) DO NOTHING;
 END;
CREATE TRIGGER IF NOT EXISTS live_log_times_INSERT AFTER INSERT ON log_times BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (new.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
INSERT INTO live_dirty_logs SELECT new.scope_id,new.raw_log_id WHERE EXISTS(SELECT 1 FROM live_projection_cursors WHERE scope_id=new.scope_id) ON CONFLICT(scope_id,raw_log_id) DO NOTHING;
 END;
CREATE TRIGGER IF NOT EXISTS live_log_times_UPDATE AFTER UPDATE ON log_times BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (old.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
INSERT INTO live_dirty_logs SELECT old.scope_id,old.raw_log_id WHERE EXISTS(SELECT 1 FROM live_projection_cursors WHERE scope_id=old.scope_id) ON CONFLICT(scope_id,raw_log_id) DO NOTHING;
INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (new.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
INSERT INTO live_dirty_logs SELECT new.scope_id,new.raw_log_id WHERE EXISTS(SELECT 1 FROM live_projection_cursors WHERE scope_id=new.scope_id) ON CONFLICT(scope_id,raw_log_id) DO NOTHING;
 END;
CREATE TRIGGER IF NOT EXISTS live_log_times_DELETE AFTER DELETE ON log_times BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (old.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
INSERT INTO live_dirty_logs SELECT old.scope_id,old.raw_log_id WHERE EXISTS(SELECT 1 FROM live_projection_cursors WHERE scope_id=old.scope_id) ON CONFLICT(scope_id,raw_log_id) DO NOTHING;
 END;
CREATE TRIGGER IF NOT EXISTS live_pools_INSERT AFTER INSERT ON pools BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (new.scope_id,1,1) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+1;
 END;
CREATE TRIGGER IF NOT EXISTS live_pools_UPDATE AFTER UPDATE ON pools BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (old.scope_id,1,1) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+1;
INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (new.scope_id,1,1) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+1;
 END;
CREATE TRIGGER IF NOT EXISTS live_pools_DELETE AFTER DELETE ON pools BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (old.scope_id,1,1) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+1;
 END;
CREATE TRIGGER IF NOT EXISTS live_accepted_ranges_INSERT AFTER INSERT ON accepted_ranges BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (new.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
 END;
CREATE TRIGGER IF NOT EXISTS live_accepted_ranges_UPDATE AFTER UPDATE ON accepted_ranges BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (old.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (new.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
 END;
CREATE TRIGGER IF NOT EXISTS live_accepted_ranges_DELETE AFTER DELETE ON accepted_ranges BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (old.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
 END;
CREATE TRIGGER IF NOT EXISTS live_scope_cursors_INSERT AFTER INSERT ON scope_cursors BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (new.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
 END;
CREATE TRIGGER IF NOT EXISTS live_scope_cursors_UPDATE AFTER UPDATE ON scope_cursors BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (old.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (new.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
 END;
CREATE TRIGGER IF NOT EXISTS live_scope_cursors_DELETE AFTER DELETE ON scope_cursors BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (old.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
 END;
CREATE TRIGGER IF NOT EXISTS live_anchors_INSERT AFTER INSERT ON anchors BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (new.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
 END;
CREATE TRIGGER IF NOT EXISTS live_anchors_UPDATE AFTER UPDATE ON anchors BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (old.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (new.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
 END;
CREATE TRIGGER IF NOT EXISTS live_anchors_DELETE AFTER DELETE ON anchors BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (old.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
 END;
CREATE TRIGGER IF NOT EXISTS live_minute_boundaries_INSERT AFTER INSERT ON minute_boundaries BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (new.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
 END;
CREATE TRIGGER IF NOT EXISTS live_minute_boundaries_UPDATE AFTER UPDATE ON minute_boundaries BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (old.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (new.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
 END;
CREATE TRIGGER IF NOT EXISTS live_minute_boundaries_DELETE AFTER DELETE ON minute_boundaries BEGIN INSERT INTO live_source_revisions(scope_id,revision,registry_revision) VALUES (old.scope_id,1,0) ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1,registry_revision=registry_revision+0;
 END;
CREATE TRIGGER IF NOT EXISTS live_raw_UPDATE BEFORE UPDATE ON raw_logs BEGIN
 INSERT INTO live_dirty_logs SELECT DISTINCT a.scope_id,old.id FROM active_logs a JOIN live_projection_cursors c ON c.scope_id=a.scope_id WHERE a.raw_log_id=old.id ON CONFLICT(scope_id,raw_log_id) DO NOTHING;
 INSERT INTO live_source_revisions(scope_id,revision) SELECT DISTINCT scope_id,1 FROM active_logs WHERE raw_log_id=old.id AND 1 ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1;
 END;
CREATE TRIGGER IF NOT EXISTS live_raw_DELETE BEFORE DELETE ON raw_logs BEGIN
 INSERT INTO live_dirty_logs SELECT DISTINCT a.scope_id,old.id FROM active_logs a JOIN live_projection_cursors c ON c.scope_id=a.scope_id WHERE a.raw_log_id=old.id ON CONFLICT(scope_id,raw_log_id) DO NOTHING;
 INSERT INTO live_source_revisions(scope_id,revision) SELECT DISTINCT scope_id,1 FROM active_logs WHERE raw_log_id=old.id AND 1 ON CONFLICT(scope_id) DO UPDATE SET revision=revision+1;
 END;

CREATE INDEX IF NOT EXISTS live_events_unknown ON live_events(scope_id,block_number) WHERE minute_start_sec IS NULL;
CREATE INDEX IF NOT EXISTS live_errors_unknown ON live_quality_errors(scope_id,block_number) WHERE minute_start_sec IS NULL;

CREATE TABLE IF NOT EXISTS live_inputs(scope_id TEXT NOT NULL, raw_log_id INTEGER NOT NULL, input_json TEXT NOT NULL, PRIMARY KEY(scope_id,raw_log_id));
CREATE INDEX IF NOT EXISTS live_events_pool_block ON live_events(scope_id,pool_id,block_number);
CREATE TABLE IF NOT EXISTS live_dirty_coverage(scope_id TEXT PRIMARY KEY,min_block INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS live_coverage_ranges_delete AFTER DELETE ON accepted_ranges BEGIN
  INSERT INTO live_dirty_coverage SELECT old.scope_id,old.from_block WHERE EXISTS(SELECT 1 FROM live_projection_cursors WHERE scope_id=old.scope_id AND block_number>=old.from_block)
  ON CONFLICT(scope_id) DO UPDATE SET min_block=min(min_block,excluded.min_block);
END;
CREATE TRIGGER IF NOT EXISTS live_coverage_ranges_update AFTER UPDATE ON accepted_ranges
WHEN old.scope_id IS NOT new.scope_id OR old.filter_id IS NOT new.filter_id OR old.from_block IS NOT new.from_block OR old.to_block IS NOT new.to_block BEGIN
  INSERT INTO live_dirty_coverage SELECT old.scope_id,old.from_block WHERE EXISTS(SELECT 1 FROM live_projection_cursors WHERE scope_id=old.scope_id AND block_number>=old.from_block)
  ON CONFLICT(scope_id) DO UPDATE SET min_block=min(min_block,excluded.min_block);
  INSERT INTO live_dirty_coverage SELECT new.scope_id,new.from_block WHERE EXISTS(SELECT 1 FROM live_projection_cursors WHERE scope_id=new.scope_id AND block_number>=new.from_block)
  ON CONFLICT(scope_id) DO UPDATE SET min_block=min(min_block,excluded.min_block);
END;
CREATE TRIGGER IF NOT EXISTS live_coverage_boundary_INSERT AFTER INSERT ON minute_boundaries  BEGIN INSERT INTO live_dirty_coverage SELECT new.scope_id,coalesce((SELECT first_block FROM minute_boundaries WHERE scope_id=new.scope_id AND timestamp_sec<new.timestamp_sec ORDER BY timestamp_sec DESC LIMIT 1),0) WHERE EXISTS(SELECT 1 FROM live_projection_cursors WHERE scope_id=new.scope_id AND block_number>=new.at_number) ON CONFLICT(scope_id) DO UPDATE SET min_block=min(min_block,excluded.min_block);
 END;
CREATE TRIGGER IF NOT EXISTS live_coverage_boundary_UPDATE AFTER UPDATE ON minute_boundaries WHEN old.scope_id IS NOT new.scope_id OR old.timestamp_sec IS NOT new.timestamp_sec OR old.first_block IS NOT new.first_block OR old.before_number IS NOT new.before_number OR old.before_hash IS NOT new.before_hash OR old.before_timestamp_sec IS NOT new.before_timestamp_sec OR old.at_number IS NOT new.at_number OR old.at_hash IS NOT new.at_hash OR old.at_timestamp_sec IS NOT new.at_timestamp_sec BEGIN INSERT INTO live_dirty_coverage SELECT old.scope_id,coalesce((SELECT first_block FROM minute_boundaries WHERE scope_id=old.scope_id AND timestamp_sec<old.timestamp_sec ORDER BY timestamp_sec DESC LIMIT 1),0) WHERE EXISTS(SELECT 1 FROM live_projection_cursors WHERE scope_id=old.scope_id AND block_number>=old.at_number) ON CONFLICT(scope_id) DO UPDATE SET min_block=min(min_block,excluded.min_block);
INSERT INTO live_dirty_coverage SELECT new.scope_id,coalesce((SELECT first_block FROM minute_boundaries WHERE scope_id=new.scope_id AND timestamp_sec<new.timestamp_sec ORDER BY timestamp_sec DESC LIMIT 1),0) WHERE EXISTS(SELECT 1 FROM live_projection_cursors WHERE scope_id=new.scope_id AND block_number>=new.at_number) ON CONFLICT(scope_id) DO UPDATE SET min_block=min(min_block,excluded.min_block);
 END;
CREATE TRIGGER IF NOT EXISTS live_coverage_boundary_DELETE AFTER DELETE ON minute_boundaries  BEGIN INSERT INTO live_dirty_coverage SELECT old.scope_id,coalesce((SELECT first_block FROM minute_boundaries WHERE scope_id=old.scope_id AND timestamp_sec<old.timestamp_sec ORDER BY timestamp_sec DESC LIMIT 1),0) WHERE EXISTS(SELECT 1 FROM live_projection_cursors WHERE scope_id=old.scope_id AND block_number>=old.at_number) ON CONFLICT(scope_id) DO UPDATE SET min_block=min(min_block,excluded.min_block);
 END;
CREATE TABLE IF NOT EXISTS live_pending_signal_repairs(scope_id TEXT PRIMARY KEY,min_block INTEGER NOT NULL);
