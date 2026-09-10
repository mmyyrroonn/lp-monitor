import { parseArgs } from 'node:util';
import { ConfigError } from '../config/env.js';
import { encodeJson } from '../domain/json.js';
import { study } from './study.js';
export async function runStudyCli(args: string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: args.slice(1),
      strict: true,
      options: { cases: { type: 'string' }, grid: { type: 'string' }, out: { type: 'string' } },
    }).values;
  } catch {
    throw new ConfigError('Invalid study options');
  }
  if (
    typeof values.cases !== 'string' ||
    typeof values.grid !== 'string' ||
    typeof values.out !== 'string'
  )
    throw new ConfigError('Study requires --cases --grid --out');
  const report = await study(values.cases, values.grid, values.out);
  console.log(
    encodeJson({
      studyRunId: report.studyRunId,
      status: report.status,
      combinations: report.experiments.length,
      outputDirectory: report.outputDirectory,
      coverageVerified: false,
    }),
  );
  return report.status === 'complete' ? 0 : 4;
}
