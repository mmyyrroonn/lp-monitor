import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Interface } from 'ethers';
import { loadChainConfig } from '../../src/config/chain.js';
import { sha256 } from '../../src/ops/files.js';
import { categorizeLogs } from '../../src/ops/fixture-capture.js';
import { v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';
import { v4ManagerAbi } from '../../src/protocols/uniswap-v4/abi.js';
import type { RawLog } from '../../src/domain/types.js';
const root = 'artifacts/p0/raw';
const runs = existsSync(root) ? readdirSync(root).filter(name => existsSync(join(root, name, 'manifest.json'))) : [];
test.skipIf(!runs.length)('captured real RPC logs retain source hashes and decode independently', () => {
  const config = loadChainConfig('config/robinhood.json');
  const interfaces = { v3: new Interface(v3PoolAbi), v4: new Interface(v4ManagerAbi) };
  for (const run of runs) {
    const manifest = JSON.parse(readFileSync(join(root, run, 'manifest.json'), 'utf8'));
    expect(manifest.chainId).toBe(4663); expect(manifest.synthetic).toBe(false);
    expect(manifest.sourceAlias).toMatch(/^[\w-]+$/);
    for (const file of manifest.files) expect(sha256(readFileSync(file.path))).toBe(file.sha256);
    const logs: RawLog[] = JSON.parse(readFileSync(join(root, run, 'logs.json'), 'utf8')).map((log: RawLog) => ({ ...log, blockNumber: BigInt(log.blockNumber) }));
    const classified = categorizeLogs(logs, config);
    expect(classified.errors).toEqual([]);
    expect(classified.categories).toEqual(manifest.categories);
    for (const log of logs) {
      expect(log.transactionHash).toMatch(/^0x[0-9a-f]{64}$/i);
      const protocol = log.address.toLowerCase() === config.v4Manager ? 'v4' : 'v3';
      expect(interfaces[protocol].parseLog({ topics: [...log.topics], data: log.data })).not.toBeNull();
    }
    expect(classified.initializations.every(i => i.keyVerified)).toBe(true);
  }
});
