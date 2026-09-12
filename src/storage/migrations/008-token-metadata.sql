CREATE TABLE IF NOT EXISTS token_metadata (
  address TEXT NOT NULL,
  decimals INTEGER NOT NULL CHECK(decimals BETWEEN 0 AND 255),
  block_number INTEGER NOT NULL CHECK(block_number >= 0),
  block_hash TEXT NOT NULL,
  PRIMARY KEY(address, block_number)
);
CREATE TABLE IF NOT EXISTS token_metadata_failures (
  address TEXT PRIMARY KEY,
  next_retry_ms INTEGER NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS token_metadata_invalid_anchors (
 block_number INTEGER NOT NULL,
 block_hash TEXT NOT NULL,
 PRIMARY KEY(block_number,block_hash)
);
