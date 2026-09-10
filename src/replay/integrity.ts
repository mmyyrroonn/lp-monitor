import { verifySuccessfulShardCoverage } from '../ingest/completeness.js';
import type { RecordedRangeBatch } from '../storage/manifest.js';
import { rawLogKey } from '../storage/manifest.js';
export interface ReplayIssue {
  code: string;
  batchId?: string;
  scopeId?: string;
  detail: string;
}
export function checkBatchIntegrity(batch: RecordedRangeBatch, timing = true): ReplayIssue[] {
  const issues: ReplayIssue[] = [];
  try {
    verifySuccessfulShardCoverage(batch);
  } catch {
    issues.push({
      code: 'shard-incomplete',
      batchId: batch.id,
      detail: 'Raw shard coverage failed P1 validation',
    });
    return issues;
  }
  if (!Number.isSafeInteger(batch.observedAtMs) || batch.observedAtMs < 0)
    issues.push({
      code: 'observed-time-invalid',
      batchId: batch.id,
      detail: 'Original observedAtMs is unavailable',
    });
  if (!timing) return issues;
  issues.push(...checkMinuteIntegrity(batch));
  return issues;
}
export function checkMinuteIntegrity(batch: RecordedRangeBatch): ReplayIssue[] {
  const issues: ReplayIssue[] = [];
  const times = new Map(batch.logTimes?.map((t) => [rawLogKey(t.ref), t.time]));
  const boundaries = new Map(batch.boundaries?.map((b) => [b.timestampSec, b]));
  const seconds = [...boundaries.keys()].sort((a, b) => a - b);
  const first = seconds[0];
  const lastRequired = Math.floor(batch.end.timestampSec / 60) * 60;
  const startAnchor = [...(batch.anchors ?? []), ...(batch.previous ? [batch.previous] : [])].find(
    (a) => a.number === batch.fromBlock || a.number === batch.fromBlock - 1n,
  );
  const firstBoundary = first === undefined ? undefined : boundaries.get(first);
  if (
    !firstBoundary ||
    (!startAnchor && firstBoundary.firstBlock > batch.fromBlock) ||
    !boundaries.has(lastRequired)
  )
    issues.push({
      code: 'minute-boundary-missing',
      batchId: batch.id,
      detail: 'The recorded boundary index does not establish the full requested range envelope',
    });
  if (startAnchor) {
    for (let sec = Math.ceil(startAnchor.timestampSec / 60) * 60; sec <= lastRequired; sec += 60)
      if (!boundaries.has(sec)) {
        issues.push({
          code: 'minute-boundary-missing',
          batchId: batch.id,
          detail: 'Missing boundary within the independently anchored range envelope',
        });
        break;
      }
  }
  for (let i = 1; i < seconds.length; i++)
    if (seconds[i] !== seconds[i - 1]! + 60)
      issues.push({
        code: 'minute-boundary-missing',
        batchId: batch.id,
        detail: 'Recorded minute index has a gap',
      });
  for (const log of batch.logs) {
    const time = times.get(rawLogKey(log));
    if (!time || time.minuteStartSec === null) {
      issues.push({
        code: 'log-time-unresolved',
        batchId: batch.id,
        detail: 'Raw event has no verified minute',
      });
      continue;
    }
    const m = time.minuteStartSec;
    if (!boundaries.has(m) || (!boundaries.has(m + 60) && m + 60 <= batch.end.timestampSec))
      issues.push({
        code: 'minute-boundary-missing',
        batchId: batch.id,
        detail: `Minute ${m} lacks boundary evidence`,
      });
  }
  return issues;
}
