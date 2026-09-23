import type Database from 'better-sqlite3';
import {
  registerRetentionConsumer,
  type RetentionPolicy,
} from '../../src/storage/retention-state.js';

export function retentionConsumer(
  db: Database.Database,
  scopeId: string,
  options: Partial<RetentionPolicy> & {
    tipBlock?: number;
    tipSec?: number;
    anchorBlock?: number;
    anchorSec?: number;
  } = {},
): void {
  registerRetentionConsumer(db, {
    scopeId,
    registryScopeId: scopeId,
    rawRetentionSec: 60,
    liveRetentionSec: 60,
    requiredLookbackSec: 0,
    overlapBlocks: 0,
    ...options,
  });
  db.prepare('insert or replace into scope_cursors values(?,?,?,?)').run(
    scopeId,
    options.tipBlock ?? 1000,
    '0x0',
    options.tipSec ?? 1_000_020,
  );
  db.prepare('insert or replace into anchors values(?,?,?,?)').run(
    scopeId,
    options.anchorBlock ?? 900,
    '0x0',
    options.anchorSec ?? 900_000,
  );
}
