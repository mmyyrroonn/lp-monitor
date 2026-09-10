import { afterEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import { AlertOutbox } from '../../src/notify/outbox.js';
import type { AlertRecord } from '../../src/signals/types.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function setup() {
  const db = openDatabase(':memory:');
  databases.push(db);
  return { db, outbox: new AlertOutbox(db) };
}
// Persistence tests intentionally use a minimal payload; engine/format tests
// exercise the full domain record. The outbox must not interpret business data.
const alert = { id: 'a', revision: 1, kind: 'hot', endAnchor: { number: 99n } } as AlertRecord;
test('100 identical commits create one durable revision; live delivery resumes once', async () => {
  const { db, outbox } = setup();
  for (let i = 0; i < 100; i++) db.transaction(() => outbox.enqueue('s', alert, 'live'))();
  const delivered: AlertRecord[] = [];
  expect(
    await new AlertOutbox(db).deliverPending((a) => {
      delivered.push(a);
    }),
  ).toMatchObject({ sent: 1, failed: 0 });
  expect(delivered[0]!.endAnchor.number).toBe(99n);
  expect(
    await outbox.deliverPending(() => {
      throw Error('duplicate');
    }),
  ).toMatchObject({ sent: 0, failed: 0 });
});
test('rollback cannot publish and delivery is forbidden inside an open transaction', async () => {
  const { db, outbox } = setup();
  expect(() =>
    db.transaction(() => {
      outbox.enqueue('s', alert, 'live');
      throw Error('crash');
    })(),
  ).toThrow('crash');
  expect(
    await outbox.deliverPending(() => {
      throw Error('must not run');
    }),
  ).toMatchObject({ sent: 0 });
  db.exec('begin');
  await expect(outbox.deliverPending(() => {})).rejects.toThrow('transaction');
  db.exec('rollback');
});
test('failed delivery retries with stable id/revision and counts attempts', async () => {
  const { db, outbox } = setup();
  outbox.enqueue('s', alert, 'live');
  expect(
    await outbox.deliverPending(() => {
      throw Error('disk unavailable');
    }),
  ).toMatchObject({ failed: 1 });
  const seen: string[] = [];
  expect(
    await outbox.deliverPending((a) => {
      seen.push(a.id + '/' + a.revision);
    }),
  ).toMatchObject({ sent: 1 });
  expect(seen).toEqual(['a/1']);
  expect(db.prepare('select attempts,status from alert_outbox').get()).toEqual({
    attempts: 2,
    status: 'sent',
  });
});
test('backfill and synthetic records never enter the live sink', async () => {
  const { outbox } = setup();
  outbox.enqueue('s', alert, 'backfill');
  outbox.enqueue('s', { ...alert, id: 'b' }, 'synthetic');
  expect(
    await outbox.deliverPending(() => {
      throw Error('not live');
    }),
  ).toMatchObject({ sent: 0, failed: 0 });
});
test('append succeeded but sent update crashed permits identifiable delivery retry', async () => {
  const { db, outbox } = setup();
  outbox.enqueue('s', alert, 'live');
  db.exec(
    "create trigger fail_sent before update of status on alert_outbox when new.status='sent' begin select raise(abort,'crash'); end",
  );
  const delivered: string[] = [];
  expect(
    await outbox.deliverPending((a) => {
      delivered.push(a.id + '/' + a.revision);
    }),
  ).toMatchObject({ failed: 1 });
  db.exec('drop trigger fail_sent');
  await outbox.deliverPending((a) => {
    delivered.push(a.id + '/' + a.revision);
  });
  expect(delivered).toEqual(['a/1', 'a/1']);
});

test('a retraction supersedes a pending obsolete revision before restart delivery', async () => {
  const { db, outbox } = setup();
  outbox.enqueue('s', alert, 'live');
  outbox.enqueue('s', { ...alert, revision: 2, kind: 'retracted', status: 'retracted' }, 'live');
  const seen: AlertRecord[] = [];
  await new AlertOutbox(db).deliverPending((a) => {
    seen.push(a);
  });
  expect(seen.map((a) => [a.kind, a.revision])).toEqual([['retracted', 2]]);
  expect(db.prepare('select status from alert_outbox where revision=1').get()).toEqual({
    status: 'superseded',
  });
});
test('drain rechecks a cached row after an awaited sink enqueues a newer revision', async () => {
  const { db, outbox } = setup();
  outbox.enqueue('s', alert, 'live');
  outbox.enqueue('s', { ...alert, id: 'b' }, 'live');
  const seen: string[] = [];
  await outbox.deliverPending(async (record) => {
    seen.push(`${record.id}/${record.revision}`);
    if (record.id === 'a') {
      outbox.enqueue(
        's',
        { ...alert, id: 'b', revision: 2, kind: 'retracted', status: 'retracted' },
        'live',
      );
      await Promise.resolve();
    }
  });
  expect(seen).toEqual(['a/1']);
  expect(
    db.prepare("select status from alert_outbox where alert_id='b' and revision=1").get(),
  ).toEqual({ status: 'superseded' });
  await outbox.deliverPending((record) => {
    seen.push(record.id + '/' + record.revision);
  });
  expect(seen).toEqual(['a/1', 'b/2']);
});

test('failed in-flight delivery cannot resurrect a revision superseded by its sink', async () => {
  const { db, outbox } = setup();
  outbox.enqueue('s', alert, 'live');
  expect(
    await outbox.deliverPending(async () => {
      outbox.enqueue(
        's',
        { ...alert, revision: 2, kind: 'retracted', status: 'retracted' },
        'live',
      );
      await Promise.resolve();
      throw new Error('local sink failed after supersession');
    }),
  ).toMatchObject({ failed: 1 });
  expect(db.prepare('select revision,status from alert_outbox order by revision').all()).toEqual([
    { revision: 1, status: 'superseded' },
    { revision: 2, status: 'pending' },
  ]);
  const seen: number[] = [];
  await outbox.deliverPending((record) => {
    seen.push(record.revision);
  });
  expect(seen).toEqual([2]);
});

test('retracted-only drain leaves ordinary pending alerts untouched', async () => {
  const { db, outbox } = setup();
  outbox.enqueue('s', alert, 'live');
  outbox.enqueue(
    's',
    { ...alert, id: 'withdrawal', revision: 2, kind: 'retracted', status: 'retracted' },
    'live',
  );
  const seen: string[] = [];
  await outbox.deliverPending(
    (record) => {
      seen.push(record.id);
    },
    's',
    'retracted',
  );
  expect(seen).toEqual(['withdrawal']);
  expect(db.prepare("select status from alert_outbox where alert_id='a'").get()).toEqual({
    status: 'pending',
  });
});

test('backfill revision cannot supersede a pending live reminder', async () => {
  const { db, outbox } = setup();
  outbox.enqueue('s', alert, 'live');
  outbox.enqueue('s', { ...alert, revision: 2 }, 'backfill');
  const seen: number[] = [];
  expect(
    await outbox.deliverPending((record) => {
      seen.push(record.revision);
    }),
  ).toEqual({ sent: 1, failed: 0 });
  expect(seen).toEqual([1]);
  expect(db.prepare('select status from alert_outbox where revision=2').get()).toEqual({
    status: 'pending',
  });
});

test('failed alert does not block unrelated alert identities', async () => {
  const { db, outbox } = setup();
  outbox.enqueue('s', alert, 'live');
  outbox.enqueue('s', { ...alert, id: 'unrelated' }, 'live');
  const seen: string[] = [];
  expect(
    await outbox.deliverPending((record) => {
      seen.push(record.id);
      if (record.id === 'a') throw new Error('failed');
    }),
  ).toEqual({ sent: 1, failed: 1 });
  expect(seen).toEqual(['a', 'unrelated']);
  expect(db.prepare("select status from alert_outbox where alert_id='a'").get()).toEqual({
    status: 'failed',
  });
});

test('alerts SQL rejects invalid capture mode and active flag', () => {
  const { db } = setup();
  const insert = db.prepare(
    'insert into alerts(scope_id,id,revision,capture_mode,active,payload_json) values(?,?,?,?,?,?)',
  );
  expect(() => insert.run('s', 'a', 1, 'invalid', 1, '{}')).toThrow();
  expect(() => insert.run('s', 'a', 1, 'live', 2, '{}')).toThrow();
  insert.run('s', 'a', 1, 'live', 1, '{}');
  expect(() => db.prepare('update alerts set active=2').run()).toThrow();
});

test('pending scope drain uses a partial sequence index', () => {
  const { db } = setup();
  const plan = db
    .prepare(
      "explain query plan select sequence,payload_json from alert_outbox where capture_mode='live' and status in ('pending','failed') and scope_id=? order by sequence",
    )
    .all('s');
  expect(JSON.stringify(plan)).toContain('alert_outbox_live_pending_scope');
  expect(JSON.stringify(plan)).not.toContain('TEMP B-TREE');
});
