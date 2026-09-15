CREATE TABLE IF NOT EXISTS registry_changes(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL,
  pool_key TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT
);
CREATE INDEX IF NOT EXISTS registry_changes_scope_seq ON registry_changes(scope_id, seq);

CREATE TRIGGER IF NOT EXISTS pools_change_insert AFTER INSERT ON pools BEGIN
  INSERT INTO registry_changes(scope_id, pool_key, before_json, after_json)
  VALUES (new.scope_id, new.pool_key, NULL, new.payload_json);
END;

CREATE TRIGGER IF NOT EXISTS pools_change_delete AFTER DELETE ON pools BEGIN
  INSERT INTO registry_changes(scope_id, pool_key, before_json, after_json)
  VALUES (old.scope_id, old.pool_key, old.payload_json, NULL);
END;

-- Only a real payload rewrite is one change in place. A repeated identical upsert (insert or
-- ignore, or an update writing the same bytes) must stay out of the journal, otherwise every
-- batch would invalidate every reader of the registry for nothing.
CREATE TRIGGER IF NOT EXISTS pools_change_update AFTER UPDATE ON pools
WHEN new.scope_id = old.scope_id AND new.pool_key = old.pool_key
  AND new.payload_json IS NOT old.payload_json
BEGIN
  INSERT INTO registry_changes(scope_id, pool_key, before_json, after_json)
  VALUES (old.scope_id, old.pool_key, old.payload_json, new.payload_json);
END;

-- Identity is (scope, pool_key), so a row that moves is a removal from where it was plus an
-- arrival where it lands; a reader following one scope must not miss either half.
CREATE TRIGGER IF NOT EXISTS pools_change_move AFTER UPDATE ON pools
WHEN new.scope_id IS NOT old.scope_id OR new.pool_key IS NOT old.pool_key
BEGIN
  INSERT INTO registry_changes(scope_id, pool_key, before_json, after_json)
  VALUES (old.scope_id, old.pool_key, old.payload_json, NULL);
  INSERT INTO registry_changes(scope_id, pool_key, before_json, after_json)
  VALUES (new.scope_id, new.pool_key, NULL, new.payload_json);
END;
