import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ConfigError } from './env.js';
const address = z.templateLiteral(['0x', z.string()]).refine(v => /^0x[0-9a-fA-F]{40}$/.test(v));
const hash = z.templateLiteral(['0x', z.string()]).refine(v => /^0x[0-9a-fA-F]{64}$/.test(v));
const historyHint = z.object({ poolId: hash, timestampSec: z.number().int().positive().safe() });
const schema = z.object({
  version: z.string(), chainId: z.literal(4663), v3Factory: address, v4Manager: address, stateView: address,
  tokens: z.object({ AMC: address, USDG: address }), v3Pools: z.array(address).min(1), v4PoolIds: z.array(hash).min(1),
  deploymentCandidateBlock: z.string().regex(/^\d+$/), historyTimestampSec: z.number().int().positive().safe(),
  v4PoolHistoryHints: z.array(historyHint).min(1),
  pollIntervalMs: z.literal(2000), maxRangeBlocks: z.number().int().positive().max(10000), overlapBlocks: z.number().int().nonnegative(),
  logResponseGuard: z.number().int().positive(), maxRpcCalls: z.number().int().positive().max(150),
  rpcPerSecond: z.number().positive().max(5), timeoutMs: z.number().int().positive().max(10000), maxRetries: z.number().int().min(0).max(2),
}).superRefine((value, context) => {
  const configured = new Set(value.v4PoolIds.map(id => id.toLowerCase()));
  const hinted = value.v4PoolHistoryHints.map(hint => hint.poolId.toLowerCase());
  for (const poolId of configured) if (hinted.filter(id => id === poolId).length !== 1) {
    context.addIssue({ code: 'custom', message: `Expected exactly one history hint for V4 pool ${poolId}`, path: ['v4PoolHistoryHints'] });
  }
  for (const poolId of hinted) if (!configured.has(poolId)) {
    context.addIssue({ code: 'custom', message: `History hint is not a configured V4 pool ${poolId}`, path: ['v4PoolHistoryHints'] });
  }
});
export type ChainConfig = z.infer<typeof schema>;
export function loadChainConfig(path: string): ChainConfig {
  try { return schema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { throw new ConfigError('Invalid or unreadable chain config'); }
}
