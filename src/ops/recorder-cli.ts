import { loadValidatedJson } from '../config/json-file.js';
import { parseSignalConfig } from '../signals/config.js';
import { loadMetricMetadata } from '../metrics/metadata.js';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { ConfigError, loadEnv } from '../config/env.js';
import { loadChainConfig } from '../config/chain.js';
import type { createChainReader } from '../rpc/client.js';

export function parseDuration(value: string): number {
  const match = /^([1-9][0-9]*)(s|m|h)$/.exec(value);
  if (!match) throw new ConfigError('Duration must be a positive integer with s, m or h');
  const duration = Number(match[1]) * { s: 1000, m: 60000, h: 3600000 }[match[2]!]!;
  if (!Number.isSafeInteger(duration) || duration > 24 * 3600000)
    throw new ConfigError('Duration must not exceed 24h');
  return duration;
}
export async function runRecorderCli(
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
        notify: { type: 'string' },
        signals: { type: 'string' },
        metadata: { type: 'string' },
        watchlist: { type: 'string' },
        out: { type: 'string' },
        db: { type: 'string' },
        evidence: { type: 'string' },
        'from-block': { type: 'string' },
        'to-block': { type: 'string' },
        duration: { type: 'string' },
        'max-rpc-calls': { type: 'string' },
      },
    });
  } catch {
    throw new ConfigError('Invalid recorder option');
  }
  const values = parsed.values;
  const command = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || !['ingest', 'follow'].includes(command ?? ''))
    throw new ConfigError('Invalid recorder command');
  const block = (key: string) => {
    const value = values[key];
    if (value === undefined) return undefined;
    if (
      typeof value !== 'string' ||
      !/^\d+$/.test(value) ||
      BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new ConfigError('Invalid safe block height');
    return BigInt(value);
  };
  const fromBlock = block('from-block'),
    toBlock = block('to-block');
  if (
    command === 'ingest' &&
    (fromBlock === undefined || toBlock === undefined || fromBlock > toBlock)
  )
    throw new ConfigError('ingest requires ordered from-block and to-block');
  if (command === 'follow' && (values.duration === undefined || toBlock !== undefined))
    throw new ConfigError('follow requires duration and does not accept to-block');
  const durationMs = values.duration === undefined ? null : parseDuration(String(values.duration));
  if (command === 'ingest' && durationMs !== null)
    throw new ConfigError('Duration is only valid for follow');
  const evidence = String(values.evidence ?? 'sampled');
  if (!['full', 'sampled', 'off'].includes(evidence))
    throw new ConfigError('Invalid evidence policy');
  const budget = values['max-rpc-calls'];
  if (
    budget !== undefined &&
    (typeof budget !== 'string' ||
      !/^\d+$/.test(budget) ||
      !Number.isSafeInteger(Number(budget)) ||
      Number(budget) < 1)
  )
    throw new ConfigError('Invalid RPC budget');
  if (values.notify !== undefined && (values.notify !== 'local' || command !== 'follow'))
    throw new ConfigError('notify local is supported only for follow');
  if (values.notify !== 'local' && (values.signals !== undefined || values.metadata !== undefined))
    throw new ConfigError('--signals/--metadata requires --notify local');
  const notifications =
    values.notify === 'local'
      ? {
          notify: 'local' as const,
          signalConfig: loadValidatedJson(
            String(values.signals ?? 'config/signals.initial.json'),
            'signal configuration',
            parseSignalConfig,
          ),
          metricMetadata: loadMetricMetadata(
            String(values.metadata ?? 'config/metric-metadata.json'),
          ),
        }
      : {};
  const config = loadChainConfig(String(values.config ?? 'config/robinhood.json'));
  if (config.overlapBlocks >= config.maxRangeBlocks)
    throw new ConfigError('overlapBlocks must be smaller than maxRangeBlocks');
  const env = loadEnv(options.environment ?? process.env);
  const { runRecorder } = await import('./recorder.js');
  return runRecorder({
    command: command as 'ingest' | 'follow',
    ...notifications,
    config,
    env,
    watchlistPath: String(values.watchlist ?? 'config/watchlist.amc.json'),
    databasePath: resolve(String(values.db ?? env.dataDir + '/recorder.sqlite')),
    outputDirectory: resolve(String(values.out ?? 'artifacts/p1')),
    ...(fromBlock === undefined ? {} : { fromBlock }),
    ...(toBlock === undefined ? {} : { toBlock }),
    durationMs,
    maxCalls: budget === undefined ? config.recorderMaxRpcCalls : Number(budget),
    evidenceMode: evidence as 'full' | 'sampled' | 'off',
    ...(options.readerFactory ? { readerFactory: options.readerFactory } : {}),
  });
}
