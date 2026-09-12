import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { ConfigError } from '../config/env.js';
import { loadChainConfig } from '../config/chain.js';
import { loadAssetVersion } from '../registry/assets.js';
import type { createChainReader } from '../rpc/client.js';
import { encodeJson } from '../domain/json.js';
import { loadMetricMetadata } from '../metrics/metadata.js';
import { reviewHistory } from './history.js';
export async function runHistoryCli(
  args: string[],
  options: { environment?: NodeJS.ProcessEnv; readerFactory?: typeof createChainReader } = {},
) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        metadata: { type: 'string' },
        db: { type: 'string' },
        out: { type: 'string' },
        config: { type: 'string' },
        watchlist: { type: 'string' },
        'from-block': { type: 'string' },
        'to-block': { type: 'string' },
        'max-rpc-calls': { type: 'string' },
      },
    });
  } catch {
    throw new ConfigError('Invalid history option');
  }
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== 'history')
    throw new ConfigError('Invalid history command');
  const block = (key: 'from-block' | 'to-block') => {
    const value = parsed.values[key];
    if (!value || !/^\d+$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER))
      throw new ConfigError('History requires safe block bounds');
    return BigInt(value);
  };
  const fromBlock = block('from-block'),
    toBlock = block('to-block');
  if (fromBlock > toBlock) throw new ConfigError('History requires ordered block bounds');
  const budget = parsed.values['max-rpc-calls'];
  if (
    budget !== undefined &&
    (!/^\d+$/.test(budget) || !Number.isSafeInteger(Number(budget)) || Number(budget) < 1)
  )
    throw new ConfigError('Invalid RPC budget');
  const report = await reviewHistory({
    databasePath: resolve(parsed.values.db ?? 'data/recorder.sqlite'),
    outputDirectory: resolve(parsed.values.out ?? 'artifacts/history'),
    fromBlock,
    toBlock,
    config: loadChainConfig(parsed.values.config ?? 'config/robinhood.json'),
    assets: loadAssetVersion(parsed.values.watchlist ?? 'config/watchlist.stocks.json'),
    metadata: loadMetricMetadata(parsed.values.metadata ?? 'config/metric-metadata.json'),
    ...options,
    ...(budget ? { maxCalls: Number(budget) } : {}),
  });
  console.log(encodeJson(report));
  return report.complete ? 0 : 4;
}
