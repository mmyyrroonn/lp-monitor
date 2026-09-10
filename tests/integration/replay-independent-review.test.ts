import { afterEach, expect, test } from 'vitest';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { replayFixture, replayFixtureDirs } from '../helpers/replay-fixture.js';
import { anchor, swap } from '../helpers/alert-fixture.js';
import { encodeJson } from '../../src/domain/json.js';
import { rawLogKey, type RecordedRangeBatch } from '../../src/storage/manifest.js';
import { replay } from '../../src/replay/runner.js';
import { initialSignalConfig } from '../../src/signals/config.js';
import type { ReplayManifest } from '../../src/replay/reader.js';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
afterEach(() => {
  for (const d of replayFixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function save(x: ReturnType<typeof replayFixture>, batches: RecordedRangeBatch[]) {
  x.manifest.batches = batches.map((b) => {
    const path = b.scopeId === 'd' ? 'discovery-' + b.id + '.json' : 'range-' + b.id + '.json';
    const text = encodeJson(b);
    writeFileSync(join(x.dir, path), text);
    return { id: b.id, scopeId: b.scopeId, accepted: true, path, sha256: digest(text) };
  });
  writeFileSync(x.path, JSON.stringify(x.manifest));
}
function quietPart(
  x: ReturnType<typeof replayFixture>,
  from: number,
  to: number,
  id: string,
): RecordedRangeBatch {
  return {
    ...x.raw,
    id,
    fromBlock: BigInt(from),
    toBlock: BigInt(to),
    end: anchor(to),
    previous: from === 60 ? null : anchor(from - 1),
    logs: [],
    logTimes: [],
    poolRegistrations: [],
    boundaries: x.raw.boundaries!.filter(
      (b) => b.at.number >= BigInt(from) - 60n && b.at.number <= BigInt(to),
    ),
    manifest: {
      ...x.raw.manifest,
      shards: x.raw.manifest.shards.map((s) => ({
        ...s,
        request: { ...s.request, fromBlock: BigInt(from), toBlock: BigInt(to) },
        logKeys: [],
        logCount: 0,
      })),
    },
  };
}
test.each(['unaccepted', 'missing', 'block-gap'])(
  'C1: a middle %s batch returns an incomplete report without throwing',
  async (kind) => {
    const x = replayFixture();
    const parts = [
      quietPart(x, 60, 120, 'one'),
      quietPart(x, 121, 180, 'two'),
      quietPart(x, 181, 300, 'three'),
    ];
    save(x, parts);
    if (kind === 'unaccepted') x.manifest.batches[1]!.accepted = false;
    else if (kind === 'missing') rmSync(join(x.dir, 'range-two.json'));
    else x.manifest.batches.splice(1, 1);
    writeFileSync(x.path, JSON.stringify(x.manifest));
    const r = await replay(x.path, initialSignalConfig, 'minute-close');
    expect(r.status).toBe('incomplete');
    expect(r.integrity.issues.map((i) => i.code)).toContain('projection-input-incomplete');
    expect(r.integrity.issues.map((i) => i.code)).toContain('historical-shard-gap');
    if (kind === 'unaccepted')
      expect(r.integrity.issues.map((i) => i.code)).toContain('unaccepted-batch');
    if (kind === 'missing')
      expect(r.integrity.issues.map((i) => i.code)).toContain('artifact-unavailable');
  },
);
test.each(['manifestHash', 'logs', 'fromBlock', 'toBlock', 'completeness'])(
  'I2: native ref %s must match its raw artifact',
  async (field) => {
    const x = replayFixture();
    const ref = x.manifest.batches[0]! as ReplayManifest['batches'][number] &
      Record<string, unknown>;
    ref[field] =
      field === 'logs'
        ? x.raw.logs.length - 1
        : field === 'fromBlock'
          ? '61'
          : field === 'toBlock'
            ? '4799'
            : field === 'completeness'
              ? 'incomplete'
              : 'changed';
    writeFileSync(x.path, JSON.stringify(x.manifest));
    const r = await replay(x.path, initialSignalConfig, 'recorded-observed');
    expect(r.status).toBe('incomplete');
    expect(r.integrity.issues.map((i) => i.code)).toContain('artifact-reference-mismatch');
  },
);
test('I2: absent SHA256 is explicit, while tampered saved SHA256 is rejected', async () => {
  const x = replayFixture();
  delete x.manifest.batches[0]!.sha256;
  writeFileSync(x.path, JSON.stringify(x.manifest));
  expect(
    (await replay(x.path, initialSignalConfig, 'recorded-observed')).integrity.issues.map(
      (i) => i.code,
    ),
  ).toContain('artifact-hash-unavailable');
  x.manifest.batches[0]!.sha256 = 'bad';
  writeFileSync(x.path, JSON.stringify(x.manifest));
  const r = await replay(x.path, initialSignalConfig, 'recorded-observed');
  expect(r.frames).toHaveLength(0);
  expect(r.integrity.issues.map((i) => i.code)).toContain('artifact-hash-mismatch');
});
test('I1: two separated candidate spikes share one identity and increment its revision', async () => {
  const x = replayFixture();
  const logs = Array.from({ length: 20 }, (_, i) =>
    swap(70 + i * 60, i === 2 || i === 12 ? 24000 : 1),
  );
  const b = {
    ...x.raw,
    toBlock: 1260n,
    end: anchor(1260),
    logs,
    logTimes: x.raw.logTimes!.slice(0, 20).map((t, i) => ({ ...t, ref: logs[i]! })),
    boundaries: x.raw.boundaries!.slice(0, 21),
    manifest: {
      ...x.raw.manifest,
      shards: x.raw.manifest.shards.map((s) => ({
        ...s,
        request: { ...s.request, toBlock: 1260n },
        logKeys: logs.map(rawLogKey),
        logCount: logs.length,
      })),
    },
  };
  save(x, [b]);
  const r = await replay(
    x.path,
    {
      ...initialSignalConfig,
      confirmRelative: { ...initialSignalConfig.confirmRelative, enabled: false },
      confirmConsecutive: { ...initialSignalConfig.confirmConsecutive, enabled: false },
    },
    'minute-close',
  );
  expect(r.frames.flatMap((f) => f.alerts).map((a) => a.revision)).toEqual([1, 2]);
  expect(r.alerts).toHaveLength(1);
  expect(r.alerts[0]!.revision).toBe(2);
});
test('M11: discovery minute gaps are explicit even when operations are complete', async () => {
  const x = replayFixture();
  x.manifest.discoveryScope = 'd';
  save(x, [
    {
      ...x.raw,
      id: 'discovery',
      scopeId: 'd',
      boundaries: x.raw.boundaries!.filter((b) => b.timestampSec !== 180),
    },
    x.raw,
  ]);
  const r = await replay(x.path, initialSignalConfig, 'recorded-observed');
  expect(r.status).toBe('incomplete');
  expect(
    r.integrity.issues.some(
      (i) => i.code === 'minute-boundary-missing' && i.batchId === 'discovery',
    ),
  ).toBe(true);
});
test('M5: unsupported coverage spans retain a coverage-window-limit issue', async () => {
  const x = replayFixture();
  const end = 10082 * 60;
  const b = quietPart(x, 60, end, 'one');
  b.end = anchor(end);
  b.boundaries = Array.from({ length: 10082 }, (_, i) => {
    const sec = 120 + i * 60;
    return {
      timestampSec: sec,
      firstBlock: BigInt(sec - 60),
      before: anchor(sec - 61),
      at: anchor(sec - 60),
    };
  });
  save(x, [b]);
  const r = await replay(x.path, initialSignalConfig, 'recorded-observed');
  expect(r.status).toBe('incomplete');
  expect(r.integrity.issues.map((i) => i.code)).toContain('coverage-window-limit');
});
test('portable export cannot upgrade missing original artifact hash provenance', async () => {
  const x = replayFixture();
  delete x.manifest.batches[0]!.sha256;
  writeFileSync(x.path, JSON.stringify(x.manifest));
  const first = await replay(x.path, initialSignalConfig, 'recorded-observed', {
    outDirectory: join(x.dir, 'out'),
  });
  const rerun = await replay(
    join(first.outputDirectory!, 'manifest.json'),
    initialSignalConfig,
    'recorded-observed',
  );
  expect(rerun.integrity.issues.map((i) => i.code)).toContain('artifact-hash-unavailable');
  expect(rerun.status).toBe('incomplete');
});
test('native recorded counts detect a coherently truncated raw/shard artifact', async () => {
  const x = replayFixture();
  const ref = x.manifest.batches[0]!;
  Object.assign(ref, {
    manifestHash: x.raw.manifestHash,
    logs: x.raw.logs.length,
    fromBlock: x.raw.fromBlock.toString(),
    toBlock: x.raw.toBlock.toString(),
    completeness: x.raw.completeness,
  });
  delete ref.sha256;
  const logs = x.raw.logs.slice(0, 40);
  const edited = {
    ...x.raw,
    logs,
    logTimes: x.raw.logTimes!.slice(0, 40),
    manifest: {
      ...x.raw.manifest,
      shards: x.raw.manifest.shards.map((s) => ({
        ...s,
        logKeys: logs.map(rawLogKey),
        logCount: logs.length,
      })),
    },
  };
  writeFileSync(join(x.dir, 'range-one.json'), encodeJson(edited));
  writeFileSync(x.path, JSON.stringify(x.manifest));
  const r = await replay(x.path, initialSignalConfig, 'recorded-observed');
  expect(r.status).toBe('incomplete');
  expect(r.integrity.issues.map((i) => i.code)).toContain('artifact-reference-mismatch');
});
