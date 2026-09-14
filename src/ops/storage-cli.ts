import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { ConfigError } from '../config/env.js';
import { encodeJson } from '../domain/json.js';
import { saveJson } from './files.js';
import { auditStorage, compactStorage } from './storage-audit.js';

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
