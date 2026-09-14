import { parseArgs } from 'node:util';
import { ConfigError } from '../config/env.js';
import { encodeJson } from '../domain/json.js';
import { study, studyWithConfig } from './study.js';
export async function runStudyCli(args: string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: args.slice(1),
      strict: true,
      options: {
        cases: { type: 'string' },
        grid: { type: 'string' },
        out: { type: 'string' },
        'study-config': { type: 'string' },
      },
    }).values;
  } catch {
    throw new ConfigError('Invalid study options');
  }
  if (typeof values['study-config'] === 'string') {
    if (typeof values.out !== 'string')
      throw new ConfigError('Study config requires --study-config --out');
    const report = await studyWithConfig(values['study-config'], values.out);
    console.log(
      encodeJson({
        studyRunId: report.studyRunId,
        status: report.status,
        outputDirectory: report.outputDirectory,
        conclusion: report.conclusion,
        issues: report.issues,
      }),
    );
    return report.status === 'complete' ? 0 : 4;
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
