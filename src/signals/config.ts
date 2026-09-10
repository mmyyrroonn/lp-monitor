import { z } from 'zod';
import { createHash } from 'node:crypto';
const version = z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/);
const rule = z
  .object({ enabled: z.boolean(), threshold: z.string().regex(/^[1-9][0-9]*$/), version })
  .strict();
const relative = rule
  .extend({
    multiple: z.number().int().positive().safe(),
    samples: z.number().int().positive().safe(),
  })
  .strict();
export const signalConfigSchema = z
  .object({
    version,
    episodeExpiry: z
      .object({ enabled: z.boolean(), threshold: z.number().int().positive().safe(), version })
      .strict()
      .default({ enabled: true, threshold: 3600, version: '1' }),
    candidate: relative,
    confirmRelative: relative,
    confirmConsecutive: rule
      .extend({ buckets: z.union([z.literal(1), z.literal(2)]).optional() })
      .strict(),
    cooldown: z
      .object({ enabled: z.boolean(), threshold: z.number().int().nonnegative().safe(), version })
      .strict(),
    upgrade: z
      .object({ enabled: z.boolean(), threshold: z.number().int().min(2).safe(), version })
      .strict(),
    cooling: z
      .object({
        enabled: z.boolean(),
        threshold: z.number().int().min(1).max(100),
        buckets: z.number().int().positive().safe(),
        version,
      })
      .strict(),
  })
  .strict();
export type SignalConfig = z.infer<typeof signalConfigSchema>;
export function parseSignalConfig(value: unknown): SignalConfig {
  return signalConfigSchema.parse(value);
}
export const initialSignalConfig: SignalConfig = parseSignalConfig({
  version: 'p4-v2',
  candidate: { enabled: true, threshold: '20000000000', multiple: 5, samples: 60, version: '1' },
  confirmRelative: {
    enabled: true,
    threshold: '100000000000',
    multiple: 5,
    samples: 12,
    version: '1',
  },
  confirmConsecutive: { enabled: true, threshold: '50000000000', version: '1' },
  cooldown: { enabled: true, threshold: 300, version: '1' },
  upgrade: { enabled: true, threshold: 2, version: '1' },
  cooling: { enabled: true, threshold: 25, buckets: 3, version: '1' },
});
export function signalConfigVersion(config: SignalConfig): string {
  return `${config.version}:${createHash('sha256')
    .update(JSON.stringify(parseSignalConfig(config)))
    .digest('hex')}`;
}
