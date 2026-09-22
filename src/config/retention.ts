import type { ChainConfig } from './chain.js';
import { ConfigError } from './env.js';
import type { SignalConfig } from '../signals/config.js';

/** Matches the live metric/signal reader: dashboard floor, signal baselines and
 * cooling buckets, plus its two-minute preceding-quote/evidence margin. */
export function requiredRetentionMinutes(config: ChainConfig, signals?: SignalConfig): number {
  return Math.max(
    Math.max(
      180,
      (signals?.candidate.samples ?? 0) + 10,
      (signals?.confirmRelative.samples ?? 0) * 5 + 10,
      (signals?.cooling.buckets ?? 0) * 5 + 10,
    ) + 2,
    config.warmupMinutes,
    config.checkpointRetentionMinutes,
  );
}

export function validateRetentionConfig(config: ChainConfig, signals?: SignalConfig): number {
  const minutes = requiredRetentionMinutes(config, signals);
  if (
    !Number.isSafeInteger(minutes) ||
    !Number.isSafeInteger(minutes * 60) ||
    config.liveRetentionMinutes < minutes
  )
    throw new ConfigError(
      `liveRetentionMinutes must cover the signal, quote and recovery window (${minutes} minutes)`,
    );
  if (
    config.rawRetentionDays !== null &&
    (!Number.isSafeInteger(config.rawRetentionDays * 86400) ||
      config.rawRetentionDays * 1440 < minutes)
  )
    throw new ConfigError(
      `rawRetentionDays must cover the signal, quote and recovery window (${minutes} minutes)`,
    );
  return minutes;
}
