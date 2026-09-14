import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError } from '../config/env.js';
import { encodeJson } from '../domain/json.js';
import type { ReplayInputSnapshot } from './reader.js';
import { exportReplayDataset } from './export.js';

function block(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new ConfigError(`Replay export requires safe ${field}`);
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER))
    throw new ConfigError(`Replay export ${field} exceeds safe range`);
  return parsed;
}

function stringValue(values: Record<string, unknown>, key: string): string | undefined {
  return typeof values[key] === 'string' ? (values[key] as string) : undefined;
}

export async function runReplayExportCli(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: args.slice(1),
      strict: true,
      options: {
        db: { type: 'string' },
        scope: { type: 'string' },
        'discovery-scope': { type: 'string' },
        'from-block': { type: 'string' },
        'to-block': { type: 'string' },
        out: { type: 'string' },
        mode: { type: 'string' },
        'cohort-mode': { type: 'string' },
        snapshot: { type: 'string' },
        'code-hash': { type: 'string' },
        'abi-hash': { type: 'string' },
      },
    });
  } catch {
    throw new ConfigError('Invalid replay-export option');
  }
  const values = parsed.values as Record<string, unknown>;
  const db = stringValue(values, 'db');
  const scopeId = stringValue(values, 'scope');
  const from = stringValue(values, 'from-block');
  const to = stringValue(values, 'to-block');
  const out = stringValue(values, 'out');
  const mode = stringValue(values, 'mode');
  const cohortMode = stringValue(values, 'cohort-mode');
  if (!db || !scopeId || !from || !to || !out)
    throw new ConfigError('Replay export requires --db --scope --from-block --to-block --out');
  if (!['chain-time', 'recorded-observed'].includes(mode ?? ''))
    throw new ConfigError('Replay export requires --mode chain-time|recorded-observed');
  if (!['as-of', 'retrospective-cohort'].includes(cohortMode ?? ''))
    throw new ConfigError('Replay export requires --cohort-mode as-of|retrospective-cohort');
  let inputSnapshot: ReplayInputSnapshot | undefined;
  const snapshotPath = stringValue(values, 'snapshot');
  if (snapshotPath) {
    try {
      inputSnapshot = JSON.parse(
        readFileSync(resolve(snapshotPath), 'utf8'),
      ) as ReplayInputSnapshot;
    } catch {
      throw new ConfigError('Unreadable replay input snapshot');
    }
  }
  const result = await exportReplayDataset({
    databasePath: resolve(db),
    outputDirectory: resolve(out),
    scopeId,
    fromBlock: block(from, 'from-block'),
    toBlock: block(to, 'to-block'),
    mode: mode as 'chain-time' | 'recorded-observed',
    cohortMode: cohortMode as 'as-of' | 'retrospective-cohort',
    ...(stringValue(values, 'discovery-scope')
      ? { discoveryScopeId: stringValue(values, 'discovery-scope') }
      : {}),
    ...(inputSnapshot ? { inputSnapshot } : {}),
    ...(stringValue(values, 'code-hash') ? { codeHash: stringValue(values, 'code-hash') } : {}),
    ...(stringValue(values, 'abi-hash') ? { abiHash: stringValue(values, 'abi-hash') } : {}),
  });
  console.log(encodeJson(result));
  return result.complete ? 0 : 4;
}
