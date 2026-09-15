-- 013: the live evaluation workset.
--
-- Which pools a live round has to evaluate. Only pools with persistent signal
-- memory belong here: a cold pool whose snapshot is still the initial one is
-- reached through its window events, never through this table. The business
-- state itself stays in signal_snapshots, which remains the single fact.

CREATE TABLE IF NOT EXISTS live_signal_workset(
  scope_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  PRIMARY KEY(scope_id,pool_id)
);

-- One row per scope that has seeded the workset from signal_snapshots. Without
-- it, a legitimately empty workset table would be indistinguishable from one that
-- was never filled, and every open would scan the whole snapshot table again.
CREATE TABLE IF NOT EXISTS live_workset_state(
  scope_id TEXT PRIMARY KEY,
  seeded_at_ms INTEGER NOT NULL
);
