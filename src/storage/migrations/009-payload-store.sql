CREATE TABLE IF NOT EXISTS payload_objects (
  hash TEXT PRIMARY KEY,
  codec TEXT NOT NULL CHECK(codec='gzip'),
  raw_bytes INTEGER NOT NULL CHECK(raw_bytes>=0),
  payload BLOB NOT NULL
);
