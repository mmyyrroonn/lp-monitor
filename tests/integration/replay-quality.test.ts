import { afterEach, expect, test } from 'vitest';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { replayFixture as fixture, replayFixtureDirs as dirs } from '../helpers/replay-fixture.js';
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
import { replay } from '../../src/replay/runner.js';
import { initialSignalConfig } from '../../src/signals/config.js';
import { encodeJson } from '../../src/domain/json.js';
test('missing shard evidence marks replay incomplete', async () => {
  const f = fixture();
  delete f.manifest.batches[0]!.sha256;
  writeFileSync(f.path, JSON.stringify(f.manifest));
  writeFileSync(
    join(f.dir, 'range-one.json'),
    encodeJson({ ...f.raw, manifest: { ...f.raw.manifest, shards: [] } }),
  );
  const r = await replay(f.path, initialSignalConfig, 'recorded-observed');
  expect(r.integrity.complete).toBe(false);
  expect(r.frames).toHaveLength(0);
});
test('missing minute boundary is retained as incomplete history', async () => {
  const f = fixture();
  delete f.manifest.batches[0]!.sha256;
  writeFileSync(f.path, JSON.stringify(f.manifest));
  writeFileSync(
    join(f.dir, 'range-one.json'),
    encodeJson({ ...f.raw, boundaries: f.raw.boundaries!.filter((b) => b.timestampSec !== 180) }),
  );
  const r = await replay(f.path, initialSignalConfig, 'minute-close');
  expect(r.integrity.complete).toBe(false);
  expect(r.integrity.issues.some((i) => i.code === 'minute-boundary-missing')).toBe(true);
});
test('native P1 without input snapshot cannot claim historical equivalence', async () => {
  const f = fixture();
  const m = JSON.parse(readFileSync(f.path, 'utf8'));
  delete m.replay;
  writeFileSync(f.path, JSON.stringify(m));
  const r = await replay(f.path, initialSignalConfig, 'recorded-observed');
  expect(r.status).toBe('incomplete');
  expect(r.frames).toHaveLength(0);
});
test('future as-of registry snapshot cannot label past events', async () => {
  const f = fixture();
  f.manifest.replay!.input.availableAtSec = 999999;
  writeFileSync(f.path, JSON.stringify(f.manifest));
  const r = await replay(f.path, initialSignalConfig, 'recorded-observed');
  expect(r.frames).toHaveLength(0);
  expect(r.status).toBe('incomplete');
});
test('quiet-minute missing boundary cannot be reported complete', async () => {
  const f = fixture();
  delete f.manifest.batches[0]!.sha256;
  writeFileSync(f.path, JSON.stringify(f.manifest));
  writeFileSync(
    join(f.dir, 'range-one.json'),
    encodeJson({
      ...f.raw,
      logs: [],
      logTimes: [],
      poolRegistrations: [],
      manifest: {
        ...f.raw.manifest,
        shards: f.raw.manifest.shards.map((s) => ({ ...s, logKeys: [], logCount: 0 })),
      },
      boundaries: f.raw.boundaries!.filter((b) => b.timestampSec !== 180),
    }),
  );
  const r = await replay(f.path, initialSignalConfig, 'minute-close');
  expect(r.integrity.issues.some((i) => i.code === 'minute-boundary-missing')).toBe(true);
});
test('captured code and ABI mismatches are explicit incomplete provenance', async () => {
  const f = fixture();
  f.manifest.replay!.codeHash = 'wrong';
  f.manifest.replay!.abiHash = 'wrong';
  writeFileSync(f.path, JSON.stringify(f.manifest));
  const r = await replay(f.path, initialSignalConfig, 'recorded-observed');
  expect(r.integrity.issues.some((i) => i.code === 'code-hash-mismatch')).toBe(true);
  expect(r.integrity.issues.some((i) => i.code === 'abi-hash-mismatch')).toBe(true);
});
test.each(['leading', 'trailing'])(
  'missing quiet %s boundaries cannot shrink the requested horizon',
  async (side) => {
    const f = fixture();
    delete f.manifest.batches[0]!.sha256;
    writeFileSync(f.path, JSON.stringify(f.manifest));
    writeFileSync(
      join(f.dir, 'range-one.json'),
      encodeJson({
        ...f.raw,
        logs: [],
        logTimes: [],
        poolRegistrations: [],
        manifest: {
          ...f.raw.manifest,
          shards: f.raw.manifest.shards.map((s) => ({ ...s, logKeys: [], logCount: 0 })),
        },
        boundaries:
          side === 'leading' ? f.raw.boundaries!.slice(3) : f.raw.boundaries!.slice(0, -3),
      }),
    );
    const r = await replay(f.path, initialSignalConfig, 'minute-close');
    expect(r.status).toBe('incomplete');
    expect(r.integrity.issues.some((i) => i.code === 'minute-boundary-missing')).toBe(true);
  },
);
