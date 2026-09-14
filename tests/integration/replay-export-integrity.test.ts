import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { CHAIN_ID } from '../../src/domain/chain.js';
import { readReplayManifest, type ReplayManifestV2 } from '../../src/replay/reader.js';

test('v2 reader rejects segment and artifact path escape before opening files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-replay-integrity-'));
  const manifest: ReplayManifestV2 = {
    version: 2,
    chainId: CHAIN_ID,
    scopeId: 's',
    discoveryScope: 's',
    batches: [
      {
        id: 'bad',
        scopeId: 's',
        accepted: true,
        path: '../outside.json.gz',
      },
    ],
    segments: [],
    export: {
      version: 2,
      mode: 'chain-time',
      cohortMode: 'retrospective-cohort',
      fromBlock: '1',
      toBlock: '2',
      inputSnapshot: null,
      sourceHash: '0'.repeat(64),
      coverage: {},
      timeQuality: {},
      provenance: 'test',
      excluded: [],
    },
  };
  const path = join(dir, 'manifest.json');
  writeFileSync(path, JSON.stringify(manifest));
  try {
    expect(() => readReplayManifest(path)).toThrow(/escapes manifest directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
