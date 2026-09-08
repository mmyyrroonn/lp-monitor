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
const historyHint = z.strictObject({
  poolId: hash,
  timestampSec: z.number().int().positive().safe(),
});
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
