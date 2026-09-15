-- 014: the token-metadata demand queue and the durable metadata revision.
--
-- The queue holds one row per (scope, address) that still needs a decimals observation. A queue
-- row exists only while its demand is unresolved, so its presence is the demand: a resolve that
-- covers the height deletes the row instead of recording a satisfied demand that every later
-- round would have to filter out again.
--
-- The revision tables answer a different question: "which addresses' metadata moved since I last
-- looked?", without hashing every row. SQLite triggers do the naming, so the answer comes from
-- the changes that really happened rather than from a comparison the reader would have to make.

CREATE TABLE IF NOT EXISTS metadata_demand(
  scope_id TEXT NOT NULL,
  address TEXT NOT NULL,
  needed_block INTEGER NOT NULL CHECK(needed_block >= 0),
  priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 2),
  next_retry_ms INTEGER NOT NULL,
  lease_id TEXT,
  lease_owner TEXT,
  lease_until_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(scope_id,address)
);

-- The lease order: priority 0 first, then the oldest retry deadline, then the earliest height, then
-- the address. A lease reads the scope's eligible rows in exactly this index order, so the deadline
-- has to be the third column: an untouched demand carries the `nowMs` it was enqueued at while a
-- failed one carries a deadline pushed forward, which is what keeps failures from starving the
-- tokens nobody has looked at yet. The scope leads so one scope's rows cannot be scanned to serve
-- another's.
CREATE INDEX IF NOT EXISTS metadata_demand_priority ON metadata_demand(scope_id,priority,next_retry_ms);

-- One row, one counter. The revision is global for the same reason token_metadata is: a decimals
-- observation is a fact about the chain, not about the scope that happened to ask for it.
CREATE TABLE IF NOT EXISTS metadata_revision(
  id INTEGER PRIMARY KEY CHECK(id = 0),
  revision INTEGER NOT NULL
);
INSERT OR IGNORE INTO metadata_revision(id,revision) VALUES(0,0);

CREATE TABLE IF NOT EXISTS metadata_address_changes(
  revision INTEGER NOT NULL,
  address TEXT NOT NULL,
  PRIMARY KEY(revision,address)
);

-- `insert or ignore` that ignores a duplicate does not fire this trigger, which is exactly the
-- wanted behaviour: re-observing an already stored height changes nothing a reader has to know.
CREATE TRIGGER IF NOT EXISTS token_metadata_change_insert AFTER INSERT ON token_metadata BEGIN
  UPDATE metadata_revision SET revision = revision + 1 WHERE id = 0;
  INSERT INTO metadata_address_changes(revision,address)
  VALUES((SELECT revision FROM metadata_revision WHERE id = 0), lower(new.address));
END;

-- The upsert in refreshTokenMetadata lands here. `address` is never updated, so the old and the
-- new address are the same one.
CREATE TRIGGER IF NOT EXISTS token_metadata_change_update AFTER UPDATE ON token_metadata BEGIN
  UPDATE metadata_revision SET revision = revision + 1 WHERE id = 0;
  INSERT INTO metadata_address_changes(revision,address)
  VALUES((SELECT revision FROM metadata_revision WHERE id = 0), lower(old.address));
END;

-- Every deleted row journals its own address, so `delete from token_metadata where
-- block_number>=?` names each address it took with it rather than one bulk marker.
CREATE TRIGGER IF NOT EXISTS token_metadata_change_delete AFTER DELETE ON token_metadata BEGIN
  UPDATE metadata_revision SET revision = revision + 1 WHERE id = 0;
  INSERT INTO metadata_address_changes(revision,address)
  VALUES((SELECT revision FROM metadata_revision WHERE id = 0), lower(old.address));
END;

-- An invalidated anchor is recorded *before* the rows above it are deleted, so this trigger still
-- sees the addresses that have a row at that height. It has to fire first: afterwards there is
-- nothing left to name, and a height whose rows were not deleted (a fork of the seed file's entry
-- rather than of a stored row) would go unnamed.
--
-- The seed file's entries at that height are affected by the same change even when no row exists
-- there, and the addresses holding them are not in any table, so SQL cannot name them: the marker
-- below is what keeps the answer honest, exactly as it does when such an anchor is dropped.
CREATE TRIGGER IF NOT EXISTS token_metadata_invalid_anchor_insert
AFTER INSERT ON token_metadata_invalid_anchors BEGIN
  UPDATE metadata_revision SET revision = revision + 1 WHERE id = 0;
  INSERT INTO metadata_address_changes(revision,address)
  SELECT (SELECT revision FROM metadata_revision WHERE id = 0), lower(address)
  FROM token_metadata WHERE block_number = new.block_number;
  INSERT INTO metadata_address_changes(revision,address)
  VALUES((SELECT revision FROM metadata_revision WHERE id = 0), '*');
END;

-- Dropping an invalid anchor makes the *seed file's* entries at that height usable again. The seed
-- file is not a table, so SQL cannot name the addresses it affects; the reader gets the marker
-- below and has to rebuild everything it derived from metadata instead of trusting a short list.
CREATE TRIGGER IF NOT EXISTS token_metadata_invalid_anchor_delete
AFTER DELETE ON token_metadata_invalid_anchors BEGIN
  UPDATE metadata_revision SET revision = revision + 1 WHERE id = 0;
  INSERT INTO metadata_address_changes(revision,address)
  VALUES((SELECT revision FROM metadata_revision WHERE id = 0), '*');
END;
