import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { ConfigError } from '../config/env.js';
import { parseSignalConfig } from '../signals/config.js';
import { replay } from './runner.js';
import { encodeJson } from '../domain/json.js';
export async function runReplayCli(args: string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    const parsed = parseArgs({
      args: args.slice(1),
      strict: true,
      options: {
        manifest: { type: 'string' },
        rules: { type: 'string' },
        mode: { type: 'string' },
        out: { type: 'string' },
      },
    });
    values = parsed.values;
  } catch {
    throw new ConfigError('Invalid replay options');
  }
  if (
    typeof values.manifest !== 'string' ||
    typeof values.rules !== 'string' ||
    typeof values.out !== 'string' ||
    !['minute-close', 'recorded-observed'].includes(String(values.mode))
  )
    throw new ConfigError(
      'Replay requires --manifest --rules --mode minute-close|recorded-observed --out',
    );
  const report = await replay(
    values.manifest,
    parseSignalConfig(JSON.parse(readFileSync(values.rules, 'utf8'))),
    values.mode as 'minute-close' | 'recorded-observed',
    { outDirectory: values.out },
  );
  console.log(
    encodeJson({
      replayRunId: report.replayRunId,
      status: report.status,
      outputDirectory: report.outputDirectory,
      issues: report.integrity.issues,
    }),
  );
  return report.status === 'complete' ? 0 : 4;
}
