import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
test('native SQLite stores uint256 text losslessly', () => {
  const db = new Database(':memory:');
  try {
    const value = ((1n << 256n) - 1n).toString();
    db.exec('create table sample(amount TEXT NOT NULL)');
    db.prepare('insert into sample values (?)').run(value);
    expect(db.prepare('select amount from sample').get()).toEqual({ amount: value });
  } finally { db.close(); }
});
