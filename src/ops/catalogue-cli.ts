import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { ConfigError, loadEnv } from '../config/env.js';
import { loadChainConfig } from '../config/chain.js';
import { loadAssetVersion } from '../registry/assets.js';
import type { createChainReader } from '../rpc/client.js';
import { encodeJson } from '../domain/json.js';
import { parseDuration } from './recorder-cli.js';
import { runCatalogue } from './catalogue.js';

function safeBlock(value: string | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER))
    throw new ConfigError('Catalogue target must be a safe non-negative block height');
  return BigInt(value);
}

function optionString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export async function runCatalogueCli(
  args: string[],
  options: { environment?: NodeJS.ProcessEnv; readerFactory?: typeof createChainReader } = {},
): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string' },
        watchlist: { type: 'string' },
        out: { type: 'string' },
        db: { type: 'string' },
        duration: { type: 'string' },
        'max-rpc-calls': { type: 'string' },
        evidence: { type: 'string' },
        'to-block': { type: 'string' },
      },
    });
  } catch {
    throw new ConfigError('Invalid catalogue option');
  }
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== 'catalogue')
    throw new ConfigError('Invalid catalogue command');
  const values = parsed.values;
  const durationValue = optionString(values.duration);
  if (durationValue === undefined) throw new ConfigError('catalogue requires duration');
  const durationMs = parseDuration(durationValue);
  const targetBlock = safeBlock(optionString(values['to-block']));
  const budget = optionString(values['max-rpc-calls']);
  if (
    budget !== undefined &&
    (!/^\d+$/.test(budget) || !Number.isSafeInteger(Number(budget)) || Number(budget) < 1)
  )
    throw new ConfigError('Invalid RPC budget');
  const evidence = String(values.evidence ?? 'sampled');
  if (!['full', 'sampled', 'off'].includes(evidence))
    throw new ConfigError('Invalid evidence policy');
  const config = loadChainConfig(String(values.config ?? 'config/robinhood.json'));
  const watchlistPath = resolve(String(values.watchlist ?? 'config/watchlist.stocks.json'));
  // Parse the watchlist before opening the catalogue DB so invalid input has no partial output.
  loadAssetVersion(watchlistPath);
  const report = await runCatalogue({
    config,
    env: loadEnv(options.environment ?? process.env),
    watchlistPath,
    databasePath: resolve(String(values.db ?? 'data/recorder.sqlite')),
    outputDirectory: resolve(String(values.out ?? 'artifacts/catalogue')),
    durationMs,
    maxCalls: budget === undefined ? config.recorderMaxRpcCalls : Number(budget),
    evidenceMode: evidence as 'full' | 'sampled' | 'off',
    ...(targetBlock === undefined ? {} : { targetBlock }),
    ...(options.readerFactory ? { readerFactory: options.readerFactory } : {}),
  });
  console.log(encodeJson(report));
  return report.status === 'complete' || report.status === 'stopped' ? 0 : 4;
}
