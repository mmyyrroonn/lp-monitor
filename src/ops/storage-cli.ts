import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { SIGNAL_EVALUATION_RETENTION_PER_POOL } from '../config/chain.js';
import { ConfigError } from '../config/env.js';
import { encodeJson } from '../domain/json.js';
import { previewSignalEvaluationRetention } from '../signals/project.js';
import { openDatabase } from '../storage/database.js';
import { saveJson } from './files.js';
import { auditStorage, compactStorage } from './storage-audit.js';
import { previewRawRetention } from '../storage/retention.js';
import { pinRetention, releaseRetentionPin } from '../storage/retention-state.js';
import { existsSync, statSync } from 'node:fs';

/**
 * What the recorder's own retention would delete, counted on a read-only connection.
 *
 * The pass that deletes is bounded and periodic, so this answers for the whole backlog at once:
 * how many rows are past their pool's limit, what they hold, and which content-addressed objects
 * the reclamation that follows them would collect. Nothing is deleted and no vacuum is implied —
 * the pages the rows occupy are freed for reuse, and the file only shrinks when it is rewritten.
 */
function retentionPreview(
  databasePath: string,
  requested: string | undefined,
  keepPerPool: number,
) {
  const db = openDatabase(resolve(databasePath), { readonly: true });
  try {
    const scopes = db
      .prepare('select distinct scope_id from signal_evaluations order by scope_id')
      .pluck()
      .all() as string[];
    if (scopes.length === 0) throw new ConfigError('No evaluated scope to preview');
    if (requested !== undefined && !scopes.includes(requested))
      throw new ConfigError('Retention scope holds no evaluations');
    if (requested === undefined && scopes.length > 1)
      throw new ConfigError('Retention requires --scope when the database holds more than one');
    const scopeId = requested ?? scopes[0]!;
    return {
      scopeId,
      keepPerPool,
      scopes: scopes.length,
      ...previewSignalEvaluationRetention(db, scopeId, keepPerPool),
      notes: [
        'Preview only: nothing was deleted. A retention pass frees the pages its rows held for reuse; the file itself shrinks only when it is rewritten.',
      ],
    };
  } finally {
    db.close();
  }
}

export async function runStorageCli(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        db: { type: 'string' },
        artifacts: { type: 'string' },
        source: { type: 'string' },
        out: { type: 'string' },
        scope: { type: 'string' },
        keep: { type: 'string' },
        raw: { type: 'boolean' },
        'max-rows': { type: 'string' },
        id: { type: 'string' },
        kind: { type: 'string' },
      },
    });
  } catch {
    throw new ConfigError('Invalid storage option');
  }
  if (parsed.positionals.length !== 2 || parsed.positionals[0] !== 'storage')
    throw new ConfigError('Invalid storage command');
  const command = parsed.positionals[1];
  if (command === 'audit') {
    const db = parsed.values.db;
    if (typeof db !== 'string' || !db.trim()) throw new ConfigError('storage audit requires --db');
    const result = auditStorage(
      db,
      typeof parsed.values.artifacts === 'string' ? parsed.values.artifacts : undefined,
    );
    if (parsed.values.out !== undefined) {
      if (typeof parsed.values.out !== 'string') throw new ConfigError('Invalid storage output');
      const output = resolve(parsed.values.out);
      saveJson(output, result, dirname(output));
    }
    console.log(encodeJson(result));
    return result.integrity.ok ? 0 : 1;
  }
  if (command === 'retention') {
    const db = parsed.values.db;
    if (typeof db !== 'string' || !db.trim())
      throw new ConfigError('storage retention requires --db');
    const keep = parsed.values.keep;
    const keepPerPool =
      keep === undefined ? SIGNAL_EVALUATION_RETENTION_PER_POOL : Number(String(keep));
    if (!Number.isSafeInteger(keepPerPool) || keepPerPool < 0)
      throw new ConfigError('Invalid retention limit');
    const scope = parsed.values.scope;
    if (scope !== undefined && (typeof scope !== 'string' || !scope.trim()))
      throw new ConfigError('Invalid retention scope');
    let result;
    if (parsed.values.raw) {
      if (scope !== undefined || parsed.values.keep !== undefined)
        throw new ConfigError(
          'Raw retention preview uses every persisted consumer; --scope and --keep are not supported',
        );
      const maxRows =
        parsed.values['max-rows'] === undefined ? 50_000 : Number(parsed.values['max-rows']);
      if (!Number.isSafeInteger(maxRows) || maxRows < 1)
        throw new ConfigError('Invalid retention batch size');
      const source = openDatabase(resolve(db), { readonly: true });
      try {
        result = previewRawRetention(source, maxRows);
      } finally {
        source.close();
      }
    } else {
      if (parsed.values['max-rows'] !== undefined)
        throw new ConfigError('--max-rows requires --raw');
      result = retentionPreview(db, scope === undefined ? undefined : String(scope), keepPerPool);
    }
    if (parsed.values.out !== undefined) {
      if (typeof parsed.values.out !== 'string') throw new ConfigError('Invalid storage output');
      const output = resolve(parsed.values.out);
      saveJson(output, result, dirname(output));
    }
    console.log(encodeJson(result));
    return 0;
  }
  if (command === 'pin' || command === 'unpin') {
    const path = parsed.values.db;
    const id = parsed.values.id;
    if (typeof path !== 'string' || !path.trim() || !existsSync(path) || !statSync(path).isFile())
      throw new ConfigError('Retention pin requires an existing --db');
    if (typeof id !== 'string' || !id.trim()) throw new ConfigError('Retention pin requires --id');
    const kind = parsed.values.kind;
    if (command === 'pin' && kind !== 'history' && kind !== 'replay')
      throw new ConfigError('Retention pin requires --kind history|replay');
    const db = openDatabase(resolve(path));
    try {
      if (command === 'pin') pinRetention(db, id, kind as 'history' | 'replay');
      else if (!releaseRetentionPin(db, id))
        throw new ConfigError('Active retention pin not found');
      console.log(encodeJson({ id, status: command === 'pin' ? 'active' : 'released' }));
    } finally {
      db.close();
    }
    return 0;
  }
  if (command === 'compact') {
    const source = parsed.values.source;
    const target = parsed.values.out;
    if (typeof source !== 'string' || !source.trim())
      throw new ConfigError('storage compact requires --source');
    if (typeof target !== 'string' || !target.trim())
      throw new ConfigError('storage compact requires --out');
    const result = await compactStorage(
      source,
      target,
      typeof parsed.values.artifacts === 'string' ? parsed.values.artifacts : undefined,
    );
    console.log(encodeJson(result));
    return 0;
  }
  throw new ConfigError('Invalid storage command');
}
