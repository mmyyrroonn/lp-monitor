import { existsSync, lstatSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { ConfigError } from '../config/env.js';
import { openDatabase } from '../storage/database.js';
import { readBatch, writeCompactBatch } from '../storage/payload-store.js';

export interface StorageAudit {
  sampledAtMs: number;
  databaseBytes: number;
  walBytes: number;
  artifactBytes: number;
  tables: Array<{ name: string; bytes: number | null; rows: number }>;
  rawPayloadBytes: number;
  compressedObjectBytes: number;
  coverageHours: number | null;
  notes: string[];
}

function fileBytes(path: string): number {
  try {
    return statSync(path).isFile() ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

function artifactBytes(path: string, notes: string[]): number {
  if (!existsSync(path)) {
    notes.push('Artifact directory does not exist');
    return 0;
  }
  let total = 0;
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        notes.push(`Skipped symbolic link: ${target}`);
        continue;
      }
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) total += fileBytes(target);
    }
  };
  if (lstatSync(path).isDirectory()) visit(path);
  else notes.push('Artifact path is not a directory');
  return total;
}

function quoteIdentifier(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"';
}

function tableBytes(db: Database.Database, name: string): number | null {
  try {
    const row = db
      .prepare('select coalesce(sum(pgsize),0) as bytes from dbstat where name=?')
      .get(name) as { bytes: number };
    return Number(row.bytes);
  } catch {
    return null;
  }
}

function tableRows(db: Database.Database, name: string): number {
  return Number(
    db
      .prepare(`select count(*) as n from ${quoteIdentifier(name)}`)
      .pluck()
      .get(),
  );
}

function hasTable(db: Database.Database, name: string): boolean {
  return (
    db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name) !== undefined
  );
}

function sumColumn(db: Database.Database, table: string, column: string): number {
  if (!hasTable(db, table)) return 0;
  const row = db
    .prepare(
      `select coalesce(sum(length(${quoteIdentifier(column)})),0) as bytes from ${quoteIdentifier(table)}`,
    )
    .get() as { bytes: number };
  return Number(row.bytes);
}

/** Read-only byte and coverage accounting. It never runs migrations or writes the database. */
export function auditStorage(databasePath: string, artifactDirectory?: string): StorageAudit {
  const path = resolve(databasePath);
  if (!existsSync(path) || !statSync(path).isFile())
    throw new ConfigError('Recorded database must exist');
  const notes: string[] = [];
  const db = openDatabase(path, { readonly: true });
  try {
    const tableNames = (
      db
        .prepare(
          "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    const tables = tableNames.map((name) => ({
      name,
      bytes: tableBytes(db, name),
      rows: tableRows(db, name),
    }));
    if (tables.some((table) => table.bytes === null))
      notes.push('SQLite dbstat is unavailable; table bytes are null');
    let coverageHours: number | null = null;
    if (hasTable(db, 'scope_cursors')) {
      const row = db
        .prepare(
          'select min(timestamp_sec) as first, max(timestamp_sec) as last from scope_cursors',
        )
        .get() as { first: number | null; last: number | null };
      if (row.first !== null && row.last !== null)
        coverageHours = Math.max(0, row.last - row.first) / 3600;
    }
    const rawPayloadBytes =
      sumColumn(db, 'raw_logs', 'payload_json') + sumColumn(db, 'ingest_batches', 'payload_json');
    const compressedObjectBytes = sumColumn(db, 'payload_objects', 'payload');
    if (!hasTable(db, 'payload_objects'))
      notes.push('No payload_objects table; compact payload bytes are zero');
    notes.push(
      'Database and WAL bytes are reported separately; table bytes come from SQLite dbstat when available',
    );
    notes.push(
      'Coverage hours use the persisted scope cursor range and are not an all-chain estimate',
    );
    return {
      sampledAtMs: Date.now(),
      databaseBytes: fileBytes(path),
      walBytes: fileBytes(path + '-wal'),
      artifactBytes:
        artifactDirectory === undefined ? 0 : artifactBytes(resolve(artifactDirectory), notes),
      tables,
      rawPayloadBytes,
      compressedObjectBytes,
      coverageHours,
      notes,
    };
  } finally {
    db.close();
  }
}

export interface StorageCompactReport {
  version: 1;
  status: 'complete';
  source: string;
  target: string;
  sourceAudit: StorageAudit;
  targetAudit: StorageAudit;
  batchesCompacted: number;
  physical: {
    sourceBytes: number;
    targetBytes: number;
    savedBytes: number;
    savedRatio: number;
  };
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

/** Create a new compact database while preserving the source file and its WAL. */
export async function compactStorage(
  sourcePath: string,
  targetPath: string,
  artifactDirectory?: string,
): Promise<StorageCompactReport> {
  const source = resolve(sourcePath);
  const target = resolve(targetPath);
  if (samePath(source, target)) throw new ConfigError('Compact source and target must differ');
  if (!existsSync(source) || !statSync(source).isFile())
    throw new ConfigError('Compact source must exist');
  if (existsSync(target)) throw new ConfigError('Compact target already exists');
  const sourceAudit = auditStorage(source, artifactDirectory);
  const temporary = join(resolve(target, '..'), `.${basename(target)}.${Date.now()}.tmp.sqlite`);
  if (existsSync(temporary)) throw new ConfigError('Compact temporary target already exists');
  let sourceDb: Database.Database | null = null;
  let compactDb: Database.Database | null = null;
  let published = false;
  let batchesCompacted = 0;
  try {
    sourceDb = openDatabase(source, { readonly: true });
    await sourceDb.backup(temporary);
    sourceDb.close();
    sourceDb = null;
    compactDb = openDatabase(temporary);
    const ids = (
      compactDb.prepare('select id from ingest_batches order by rowid').all() as { id: string }[]
    ).map((row) => row.id);
    batchesCompacted = ids.length;
    for (const id of ids) writeCompactBatch(compactDb, readBatch(compactDb, id));
    compactDb.pragma('wal_checkpoint(TRUNCATE)');
    // Rewriting batches leaves free pages behind; reclaim them before publication
    // so the new copy is physically smaller rather than merely logical.
    compactDb.exec('VACUUM');
    compactDb.pragma('wal_checkpoint(TRUNCATE)');
    compactDb.close();
    compactDb = null;
    // Rename is the only publication step; a failed conversion leaves no target path.
    renameSync(temporary, target);
    published = true;
  } finally {
    sourceDb?.close();
    compactDb?.close();
    if (!published) {
      rmSync(temporary, { force: true });
    }
  }
  const targetAudit = auditStorage(target, artifactDirectory);
  const sourceBytes = sourceAudit.databaseBytes + sourceAudit.walBytes;
  const targetBytes = targetAudit.databaseBytes + targetAudit.walBytes;
  return {
    version: 1,
    status: 'complete',
    source,
    target,
    sourceAudit,
    targetAudit,
    batchesCompacted,
    physical: {
      sourceBytes,
      targetBytes,
      savedBytes: sourceBytes - targetBytes,
      savedRatio: sourceBytes === 0 ? 0 : (sourceBytes - targetBytes) / sourceBytes,
    },
  };
}
