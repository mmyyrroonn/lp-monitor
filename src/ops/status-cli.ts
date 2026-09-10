import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { ConfigError } from '../config/env.js';
import { encodeJson } from '../domain/json.js';
import { backupDatabase, inspectDatabaseStatus } from './status.js';

export async function runStatusCli(
  args: string[],
  _environment: NodeJS.ProcessEnv = process.env,
  output: (line: string) => void = console.log,
): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        db: { type: 'string' },
        scope: { type: 'string' },
        out: { type: 'string' },
        'source-alias': { type: 'string' },
        sidecar: { type: 'string' },
      },
    });
  } catch {
    throw new ConfigError('Invalid status option');
  }
  const command = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || (command !== 'status' && command !== 'backup'))
    throw new ConfigError('Invalid status command');
  const db = parsed.values.db;
  if (typeof db !== 'string' || !db.trim()) throw new ConfigError('--db is required');
  if (command === 'status') {
    const explicitScope = parsed.values.scope;
    const inferredScope =
      explicitScope === undefined && parsed.values.sidecar === undefined
        ? inferDefaultSidecarScope(db)
        : null;
    const scope =
      typeof explicitScope === 'string' && explicitScope.trim() ? explicitScope : inferredScope;
    if (scope === null) throw new ConfigError('--scope is required');
    if (parsed.values.out !== undefined) throw new ConfigError('--out requires backup');
    output(
      encodeJson(
        inspectDatabaseStatus(db, {
          scopeId: scope,
          sourceAlias:
            typeof parsed.values['source-alias'] === 'string'
              ? parsed.values['source-alias']
              : undefined,
          sidecarPath:
            typeof parsed.values.sidecar === 'string' ? parsed.values.sidecar : undefined,
        }),
      ),
    );
    return 0;
  }
  if (
    parsed.values.scope !== undefined ||
    parsed.values.sidecar !== undefined ||
    parsed.values['source-alias'] !== undefined
  )
    throw new ConfigError('scope/source-alias/sidecar require status');
  const out = parsed.values.out;
  if (typeof out !== 'string' || !out.trim()) throw new ConfigError('--out is required');
  await backupDatabase(db, out);
  output(encodeJson({ status: 'complete', source: resolve(db), target: resolve(out) }));
  return 0;
}

function inferDefaultSidecarScope(databaseValue: string): string | null {
  const database = resolve(databaseValue);
  const sidecar = database + '.health.json';
  if (!existsSync(sidecar)) return null;
  try {
    const value = JSON.parse(readFileSync(sidecar, 'utf8')) as {
      databasePath?: unknown;
      scopeId?: unknown;
    };
    if (typeof value.databasePath !== 'string' || resolve(value.databasePath) !== database)
      return null;
    if (typeof value.scopeId !== 'string' || !value.scopeId.trim()) return null;
    return value.scopeId;
  } catch {
    return null;
  }
}
