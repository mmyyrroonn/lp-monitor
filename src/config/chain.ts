import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CHAIN_ID } from '../domain/chain.js';
import { ConfigError } from './env.js';
const address = z
  .templateLiteral(['0x', z.string()])
  .refine((v) => /^0x[0-9a-fA-F]{40}$/.test(v))
  .transform((v) => v.toLowerCase() as `0x${string}`);
const hash = z
  .templateLiteral(['0x', z.string()])
  .refine((v) => /^0x[0-9a-fA-F]{64}$/.test(v))
  .transform((v) => v.toLowerCase() as `0x${string}`);
const historyHint = z
  .strictObject({
    poolId: hash,
    timestampSec: z.number().int().positive().safe(),
    fromBlock: z
      .string()
      .regex(/^(?:0|[1-9][0-9]*)$/)
      .optional(),
    toBlock: z
      .string()
      .regex(/^(?:0|[1-9][0-9]*)$/)
      .optional(),
  })
  .superRefine((hint, context) => {
    if (
      (hint.fromBlock === undefined) !== (hint.toBlock === undefined) ||
      (hint.fromBlock !== undefined &&
        hint.toBlock !== undefined &&
        BigInt(hint.fromBlock) > BigInt(hint.toBlock))
    )
      context.addIssue({
        code: 'custom',
        message: 'Expected paired ordered hint bounds',
        path: ['fromBlock'],
      });
  });
/**
 * Evaluation audit rows kept per pool.
 *
 * Nothing reads `signal_evaluations`, so one row per pool is the state that pool was last
 * evaluated in; a larger number only keeps more audit history behind it. The limit is per pool
 * rather than per scope because a full snapshot writes every pool at once, and a scope-wide
 * limit would keep the pools of the newest snapshot and drop every other pool's last state.
 */
export const SIGNAL_EVALUATION_RETENTION_PER_POOL = 1;
/** How often the recorder prunes, at its poll gap: often enough to keep up with a live round,
 * rare enough that the pass which ranks every row is not paying for itself continuously. */
export const SIGNAL_EVALUATION_PRUNE_INTERVAL_MINUTES = 5;
/** Rows one pass may delete. A backlog drains over several passes instead of in a single
 * transaction that holds the writer for its whole duration and grows the WAL by the table. */
export const SIGNAL_EVALUATION_PRUNE_BATCH_ROWS = 50_000;
const schema = z
  .strictObject({
    version: z.string(),
    chainId: z.literal(CHAIN_ID),
    v3Factory: address,
    v4Manager: address,
    stateView: address,
    tokens: z.strictObject({ AMC: address, USDG: address }),
    v3Pools: z.array(address).min(1),
    v4PoolIds: z.array(hash).min(1),
    deploymentCandidateBlock: z.string().regex(/^\d+$/),
    historyTimestampSec: z.number().int().positive().safe(),
    v4PoolHistoryHints: z.array(historyHint).min(1),
    // P1 polling/recovery settings; P0 only uses maxRangeBlocks.
    pollIntervalMs: z.number().int().positive().safe(),
    maxRangeBlocks: z.number().int().positive().max(10000),
    overlapBlocks: z.number().int().nonnegative(),
    logResponseGuard: z.number().int().positive(),
    maxRpcCalls: z.number().int().positive().safe().nullable(),
    rpcPerSecond: z.number().positive().finite(),
    timeoutMs: z.number().int().positive().max(2147483647),
    maxRetries: z.number().int().min(0).max(2),
    recorderMaxRpcCalls: z.number().int().positive().safe().default(10000),
    maxConcurrentRpc: z.number().int().positive().max(16).default(2),
    maxBackfillRpcRps: z.number().positive().finite().default(1),
    warmupMinutes: z.number().int().positive().safe().default(60),
    checkpointRetentionMinutes: z.number().int().positive().safe().default(180),
    discoveryMaxRangeBlocks: z.number().int().positive().safe().default(1000000),
    maxFilterValues: z.number().int().positive().safe().default(1000),
    maxLogsPerResponse: z.number().int().positive().safe().nullable().default(null),
    signalEvaluationRetentionPerPool: z
      .number()
      .int()
      .nonnegative()
      .safe()
      .default(SIGNAL_EVALUATION_RETENTION_PER_POOL),
    signalEvaluationPruneIntervalMinutes: z
      .number()
      .int()
      .positive()
      .safe()
      .default(SIGNAL_EVALUATION_PRUNE_INTERVAL_MINUTES),
    signalEvaluationPruneBatchRows: z
      .number()
      .int()
      .positive()
      .safe()
      .default(SIGNAL_EVALUATION_PRUNE_BATCH_ROWS),
  })
  .superRefine((value, context) => {
    const configured = new Set(value.v4PoolIds.map((id) => id.toLowerCase()));
    const hinted = value.v4PoolHistoryHints.map((hint) => hint.poolId.toLowerCase());
    for (const poolId of configured)
      if (hinted.filter((id) => id === poolId).length !== 1) {
        context.addIssue({
          code: 'custom',
          message: `Expected exactly one history hint for V4 pool ${poolId}`,
          path: ['v4PoolHistoryHints'],
        });
      }
    for (const poolId of hinted)
      if (!configured.has(poolId)) {
        context.addIssue({
          code: 'custom',
          message: `History hint is not a configured V4 pool ${poolId}`,
          path: ['v4PoolHistoryHints'],
        });
      }
  });
export type ChainConfig = z.infer<typeof schema>;
export function loadChainConfig(path: string): ChainConfig {
  try {
    return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error instanceof z.ZodError) {
      const fields = [
        ...new Set(
          error.issues.map((issue) =>
            issue.code === 'unrecognized_keys' ? 'unknown field' : issue.path.join('.') || 'root',
          ),
        ),
      ];
      throw new ConfigError('Invalid chain config fields: ' + fields.join(', '));
    }
    if (error instanceof SyntaxError) throw new ConfigError('Invalid chain config JSON');
    throw new ConfigError('Unreadable chain config');
  }
}
