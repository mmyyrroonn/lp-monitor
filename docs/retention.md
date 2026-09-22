# Retention operations

Run these against the intended local database path. Preview and audit open it read-only,
do not migrate it, and make no RPC calls:

```sh
pnpm lp storage retention --raw --db PATH --max-rows 50000
pnpm lp storage audit --db PATH
```

The raw preview reports the exact eligible batch IDs and raw-log IDs for one bounded pass,
accepted-range count, scopes losing coverage, and consumer/pin blockers. The recorder selects
raw logs before batches, so a transport removed now can release raw logs on the next pass.
The existing `storage retention --db PATH [--scope SCOPE] [--keep N]` still previews signal
evaluation history separately. Audit reports SQLite quick-check results, foreign-key violations,
and orphaned live rows; a failed integrity audit exits with code 1.

For a history/replay consumer that needs inputs across multiple transactions:

```sh
pnpm lp storage pin --db PATH --id my-export --kind replay
# Finish or abandon the consumer, then explicitly release its pin:
pnpm lp storage unpin --db PATH --id my-export
```

Pins protect the whole database's raw and live inputs. They have no time-based expiry.
History study jobs automatically receive `history:<job-id>` pins, including completed,
paused, and failed jobs; completion alone does not release the study inputs. Explicitly
released pins remain released after restart. Replay exports already hold a consistent SQLite
read snapshot; history preparation already copies the source to an isolated study database.

## Eligibility and availability

Recorder startup persists a policy for its operation and discovery scopes. Every known
scope participates in the shared raw cutoff, including registry relationships and dormant
scopes. A missing policy, missing cursor, missing time-to-block anchor, or explicit
`rawRetentionDays: null` blocks raw reclamation. Progress comes from accepted chain cursors,
never from wall-clock time. Reorg overlap and every remaining recovery checkpoint are protected.
Discovery checkpoints are retired using their own scope's configured recovery horizon.

The startup check requires both retention windows to cover the configured signal baseline
and cooling horizons, the metric reader's two-minute quote margin, warmup, and checkpoint
recovery. The default minimum is 182 minutes; larger signal/recovery configurations can
require more. Validation happens before constructing an RPC reader.

Physical functions default to at most 50,000 primary rows per table/scope per pass; callers
can specify a positive bound, and the old negative/unlimited SQL limit is rejected. Related
children are deleted with their selected parents. A batch set is selected once in
`(end_timestamp_sec, id)` order and reused for all child and parent deletes in one transaction.
Discovery logs and any raw fact still covered by a retained transport/range or dependency stay.

Actual expiry atomically advances a conservative scope availability floor and invalidates
live coverage revisions. Old metric minutes report `retention-expired` and incomplete coverage,
including minutes with no blocks. A bounded pass can leave some rows below the floor; those
residual rows do not promise complete history. Floors never clear automatically, even if old
facts are subsequently imported. Use a separate complete snapshot for historical reconstruction.
Retention failures are reported as `retention` with the failed stage and a rolled-back pass.

## Migration and rollback

Migration `017-retention-safety.sql` is additive and idempotent. Writable opens create the
policy/pin/expiry tables, indexes, and invalidation triggers. Existing scopes are not assigned
an assumed policy: they block raw cleanup until their recorder starts with validated settings.
Read-only legacy databases remain readable and preview reports `retention-schema-missing`.

Back up the database before enabling physical expiry. Deleted facts cannot be recovered by
reverting code. A code rollback must use that backup, or keep raw retention disabled and avoid
older readers that ignore expiry metadata. Do not drop the expiry tables to make a historical
window appear available. Pages freed by retention are reused; shrinking the file still requires
the existing copy-based `storage compact` workflow.
