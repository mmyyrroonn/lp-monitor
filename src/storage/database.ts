import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

function loadMigration(name: string): string {
  try {
    return readFileSync(new URL('./migrations/' + name, import.meta.url), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return readFileSync(
      new URL('../../../src/storage/migrations/' + name, import.meta.url),
      'utf8',
    );
  }
}

const migration = ['001-raw.sql', '002-projections.sql'].map(loadMigration).join('\n');

export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const database = new Database(path);
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  if (path !== ':memory:') database.pragma('journal_mode = WAL');
  database.exec(migration);
  const poolColumns = database.pragma('table_info(pools)') as { name: string }[];
  if (!poolColumns.some((column) => column.name === 'protocol'))
    database.exec('alter table pools add column protocol TEXT');
  database.exec(
    "update pools set protocol = json_extract(payload_json, '$.pool.protocol') where protocol is null",
  );
  return database;
}
