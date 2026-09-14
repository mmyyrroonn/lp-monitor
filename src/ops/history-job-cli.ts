import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError } from '../config/env.js';
import { encodeJson } from '../domain/json.js';
import { parseDuration } from './recorder-cli.js';
import { prepareHistoryJob, runHistoryJob } from './history-job.js';
import { normalizeHistoryJobSpec, readHistoryJob } from '../storage/history-jobs.js';
import type { createChainReader } from '../rpc/client.js';

function value(values: Record<string, unknown>, key: string): string | undefined {
  const found = values[key];
  return typeof found === 'string' ? found : undefined;
}

function required(values: Record<string, unknown>, key: string): string {
  const found = value(values, key);
  if (!found?.trim()) throw new ConfigError(`history-job requires --${key}`);
  return found;
}

function budget(values: Record<string, unknown>): number | undefined {
  const found = value(values, 'max-rpc-calls');
  if (found === undefined) return undefined;
  if (!/^\d+$/.test(found) || !Number.isSafeInteger(Number(found)) || Number(found) < 1)
    throw new ConfigError('Invalid history-job RPC budget');
  return Number(found);
}

export async function runHistoryJobCli(
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
        spec: { type: 'string' },
        db: { type: 'string' },
        job: { type: 'string' },
        duration: { type: 'string' },
        'max-rpc-calls': { type: 'string' },
        metadata: { type: 'string' },
      },
    });
  } catch {
    throw new ConfigError('Invalid history-job option');
  }
  if (parsed.positionals.length !== 2 || parsed.positionals[0] !== 'history-job')
    throw new ConfigError('Invalid history-job command');
  const command = parsed.positionals[1];
  const values = parsed.values as Record<string, unknown>;
  if (command === 'prepare') {
    const specPath = resolve(required(values, 'spec'));
    let spec: unknown;
    try {
      spec = JSON.parse(readFileSync(specPath, 'utf8'));
    } catch {
      throw new ConfigError('Unreadable history-job spec');
    }
    const state = await prepareHistoryJob(normalizeHistoryJobSpec(spec as never));
    console.log(encodeJson(state));
    return 0;
  }
  const databasePath = resolve(required(values, 'db'));
  const jobId = required(values, 'job');
  if (command === 'status') {
    console.log(encodeJson(readHistoryJob(databasePath, jobId)));
    return 0;
  }
  if (command !== 'run' && command !== 'resume')
    throw new ConfigError('Invalid history-job command');
  const durationValue = value(values, 'duration');
  const durationMs = durationValue === undefined ? undefined : parseDuration(durationValue);
  const state = await runHistoryJob({
    studyDatabasePath: databasePath,
    jobId,
    durationMs,
    maxRpcCalls: budget(values),
    metadataPath: value(values, 'metadata'),
    environment: options.environment,
    readerFactory: options.readerFactory,
  });
  console.log(encodeJson(state));
  return state.status === 'complete' ? 0 : 4;
}
