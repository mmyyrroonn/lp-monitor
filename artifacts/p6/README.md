# P6 implementation and validation evidence

The P6 code is implemented. The 30-minute smoke passed, but the final build has not passed a complete two-hour acceptance run. The latest observation was stopped at the user's request after about 56 minutes; later local processing samples exceeded 2 seconds. See [the acceptance record](../../docs/reviews/2026-09-10-p6-acceptance.md) and [the runbook](../../docs/runbook.md).

`commit-verification.json` and `commit-tests.json` record the offline checks run for source-control integration. They do not replace the historical `offline-verification.json` and `tests.json` that preceded the frozen live build.

The repository retains runtime helpers, code fingerprints, compact test/run/resource reports, the failed-attempt evidence and performance summaries. `soak-user-stopped-report.json` is an interruption record, not a finalized manifest or two-hour acceptance pass. No final acceptance or monetary cost is inferred from it.

Large or transient inputs remain on this machine and are ignored by Git: `data/` databases and backups, `runs/` request and batch evidence, console streams, performance `.sqlite` snapshots, and `save-raw-reproduction/range.json`. Scratch profiling scripts and the unfinished ABI-cache test draft remain in `.superpowers/`. A fresh clone can run the offline tests but cannot reproduce the historical live-run assessments or scratch profiles from these reports alone; those require the corresponding local inputs. No stored input is deleted by this source-control policy.

No live recorder or resource sampler remains running. Resuming live observation requires a subsequent user instruction.
