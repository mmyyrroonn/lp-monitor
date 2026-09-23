-- 018: the local delivery policy and its generation boundary.
--
-- Whether a scope's outbox may deliver at all, and since when. A run records the mode it starts
-- in before any signal can be evaluated, so a crash cannot leave intents that no policy governs.
-- The generation increments every time delivery is re-enabled after being off, which is what
-- separates a normal restart (retry what is still valid) from a silent period ending (deliver only
-- the withdrawals owed to identities that really were sent live).

CREATE TABLE IF NOT EXISTS delivery_policy (
  scope_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK(mode IN ('none','local')),
  generation INTEGER NOT NULL DEFAULT 0,
  enabled_at_ms INTEGER,
  disabled_at_ms INTEGER
);
