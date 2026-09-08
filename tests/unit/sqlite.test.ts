import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
test('native SQLite stores uint256 text losslessly', () => {
  const db = new Database(':memory:');
  try {
    const value = ((1n << 256n) - 1n).toString();
    db.exec('create table sample(amount TEXT NOT NULL)');
    db.prepare('insert into sample values (?)').run(value);
    expect(db.prepare('select amount from sample').get()).toEqual({ amount: value });
  } finally {
    db.close();
  }
});

test('SQLite runtime and installed declarations cover the P1 storage API', () => {
  const db = new Database(':memory:', { timeout: 1000 });
  try {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.exec('create table records(id INTEGER PRIMARY KEY, amount TEXT NOT NULL)');
    const insert = db.prepare<[number, string]>('insert into records values (?, ?)');
    const batch = db.transaction((values: Array<[number, string]>) => {
      for (const value of values) insert.run(...value);
    });
    batch.immediate([
      [1, '123'],
      [2, '456'],
    ]);
    const select = db
      .prepare<[], { id: bigint; amount: string }>('select * from records order by id')
      .safeIntegers();
    expect(select.all()).toEqual([
      { id: 1n, amount: '123' },
      { id: 2n, amount: '456' },
    ]);
    expect([...select.iterate()]).toEqual(select.all());
    expect(() =>
      batch([
        [3, '789'],
        [1, 'duplicate'],
      ]),
    ).toThrow();
    expect(db.prepare('select count(*) as count from records').get()).toEqual({ count: 2 });
    expect(db.inTransaction).toBe(false);
  } finally {
    db.close();
  }
  expect(db.open).toBe(false);
});
