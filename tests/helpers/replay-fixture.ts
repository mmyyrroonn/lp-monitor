import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { encodeJson } from '../../src/domain/json.js';
import { batch, hotLogs, metricInput } from './alert-fixture.js';
import type { ReplayManifest } from '../../src/replay/reader.js';
export const replayFixtureDirs: string[] = [];
export function replayFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'replay-'));
  replayFixtureDirs.push(dir);
  const raw = { ...batch('one', hotLogs()), previous: null, captureMode: 'live' as const };
  const rawText = encodeJson(raw);
  writeFileSync(join(dir, 'range-one.json'), rawText);
  const manifest: ReplayManifest = {
    version: 1,
    chainId: 4663,
    scopeId: 's',
    discoveryScope: 's',
    configVersion: 'c',
    assetVersion: 'test',
    batches: [
      {
        id: 'one',
        scopeId: 's',
        accepted: true,
        sha256: createHash('sha256').update(rawText).digest('hex'),
      },
    ],
    replay: {
      version: 1,
      input: {
        configVersion: 'c',
        usdg: metricInput.usdg,
        assets: { version: 'test', rwa: [...metricInput.assets.assets] },
        metadata: metricInput.metadata,
        availableAtSec: 0,
        cohortMode: 'as-of',
      },
    },
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return { dir, path: join(dir, 'manifest.json'), raw, manifest };
}
/** Rehash intentionally edited synthetic fixture files before their next replay. */
export function refreshFixtureManifest(path: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as ReplayManifest;
  for (const ref of manifest.batches) {
    const name =
      ref.path ??
      `${ref.scopeId === manifest.discoveryScope && manifest.discoveryScope !== manifest.scopeId ? 'discovery' : 'range'}-${ref.id}.json`;
    ref.sha256 = createHash('sha256')
      .update(readFileSync(join(dirname(path), name)))
      .digest('hex');
  }
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}
