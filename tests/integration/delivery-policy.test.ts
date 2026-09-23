import { expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import { AlertOutbox, ORDINARY_DELIVERY_MAX_AGE_MS } from '../../src/notify/outbox.js';
import { setDeliveryMode, readDeliveryPolicy } from '../../src/notify/delivery-policy.js';
import { encodeSignalState } from '../../src/signals/codec.js';
import type { AlertRecord } from '../../src/signals/types.js';

const SCOPE = 's';
function alert(
  id: string,
  revision: number,
  kind: AlertRecord['kind'],
  observedAtMs = 1_000,
): AlertRecord {
  return {
    id,
    revision,
    kind,
    status: kind === 'retracted' ? 'retracted' : 'provisional',
    observedAtMs,
    endAnchor: { number: 1n },
  } as AlertRecord;
}
/** The authoritative ledger row `saveRecord` writes in the same transaction as the intent. */
function writeAlert(db: Database.Database, record: AlertRecord): void {
  db.prepare(
    `insert into alerts(scope_id,id,revision,capture_mode,active,payload_json) values(?,?,?,?,?,?)
     on conflict(scope_id,id) do update set revision=excluded.revision,active=excluded.active,payload_json=excluded.payload_json`,
  ).run(
    SCOPE,
    record.id,
    record.revision,
    'live',
    record.kind === 'retracted' ? 0 : 1,
    encodeSignalState(record),
  );
}
function setup() {
  const db = openDatabase(':memory:');
  return { db, outbox: new AlertOutbox(db) };
}

test('a silent scope records the revision terminally instead of accumulating a deliverable intent', async () => {
  const { db, outbox } = setup();
  try {
    setDeliveryMode(db, SCOPE, 'none', 5_000);
    const hot = alert('a', 1, 'hot');
    writeAlert(db, hot);
    outbox.enqueue(SCOPE, hot, 'live');
    expect(db.prepare('select status,last_error from alert_outbox').get()).toEqual({
      status: 'superseded',
      last_error: 'delivery-disabled',
    });
    const sent: AlertRecord[] = [];
    expect(await outbox.deliverPending((a) => void sent.push(a), SCOPE)).toEqual({
      sent: 0,
      failed: 0,
    });
    expect(sent).toEqual([]);
    // The ledger keeps the authoritative revision; nothing was deleted or faked as sent.
    expect(db.prepare('select revision from alerts').pluck().get()).toBe(1);
  } finally {
    db.close();
  }
});

test('re-enabling promotes only withdrawals owed to identities that were really sent live', async () => {
  const { db, outbox } = setup();
  try {
    setDeliveryMode(db, SCOPE, 'local', 1_000);
    const hot = alert('a', 1, 'hot');
    writeAlert(db, hot);
    outbox.enqueue(SCOPE, hot, 'live');
    expect(await outbox.deliverPending(() => {}, SCOPE, undefined, { nowMs: 1_500 })).toEqual({
      sent: 1,
      failed: 0,
    });

    setDeliveryMode(db, SCOPE, 'none', 2_000);
    const withdrawal = alert('a', 2, 'retracted');
    writeAlert(db, withdrawal);
    outbox.enqueue(SCOPE, withdrawal, 'live');
    const ordinary = alert('b', 1, 'hot');
    writeAlert(db, ordinary);
    outbox.enqueue(SCOPE, ordinary, 'live');
    expect(
      db.prepare("select count(*) from alert_outbox where status='superseded'").pluck().get(),
    ).toBe(2);

    // The withdrawal for the identity that was actually sent live comes back; the silent-period
    // ordinary opportunity does not.
    expect(setDeliveryMode(db, SCOPE, 'local', 3_000).promoted).toBe(1);
    const seen: AlertRecord[] = [];
    expect(
      await outbox.deliverPending((a) => void seen.push(a), SCOPE, undefined, { nowMs: 3_500 }),
    ).toEqual({
      sent: 1,
      failed: 0,
    });
    expect(seen.map((a) => [a.id, a.kind, a.revision])).toEqual([['a', 'retracted', 2]]);
    expect(db.prepare("select status from alert_outbox where alert_id='b'").pluck().get()).toBe(
      'superseded',
    );
  } finally {
    db.close();
  }
});

test('a normal restart under an already-local policy retries only what is still pending', async () => {
  const { db, outbox } = setup();
  try {
    setDeliveryMode(db, SCOPE, 'none', 1_000);
    const withdrawal = alert('a', 2, 'retracted');
    writeAlert(db, withdrawal);
    outbox.enqueue(SCOPE, withdrawal, 'live');
    expect(setDeliveryMode(db, SCOPE, 'local', 2_000).promoted).toBe(1);
    // Simulate a crash between the promotion and its sink: the row is suppressed again.
    db.prepare("update alert_outbox set status='superseded',last_error='delivery-disabled'").run();
    const restart = setDeliveryMode(db, SCOPE, 'local', 3_000);
    expect(restart.transitioned).toBe(false);
    expect(restart.promoted).toBe(0);
    expect(
      db.prepare("select count(*) from alert_outbox where status='pending'").pluck().get(),
    ).toBe(0);
  } finally {
    db.close();
  }
});

test('delivery re-checks revision, activity and data age against the ledger', async () => {
  const { db, outbox } = setup();
  try {
    const nowMs = 10_000_000;
    // An ordinary opportunity that waited past its window is expired, not announced late.
    const stale = alert('old', 1, 'hot', nowMs - ORDINARY_DELIVERY_MAX_AGE_MS - 1);
    writeAlert(db, stale);
    outbox.enqueue(SCOPE, stale, 'live');
    expect(await outbox.deliverPending(() => {}, SCOPE, undefined, { nowMs })).toEqual({
      sent: 0,
      failed: 0,
    });
    expect(
      db.prepare("select status,last_error from alert_outbox where alert_id='old'").get(),
    ).toEqual({ status: 'superseded', last_error: 'expired' });

    // A withdrawal has its own rule: late is exactly what a correction may be.
    const sent = alert('withdrawn', 1, 'hot', nowMs);
    writeAlert(db, sent);
    outbox.enqueue(SCOPE, sent, 'live');
    await outbox.deliverPending(() => {}, SCOPE, undefined, { nowMs });
    const withdrawal = alert('withdrawn', 2, 'retracted', nowMs - 86_400_000);
    writeAlert(db, withdrawal);
    outbox.enqueue(SCOPE, withdrawal, 'live');
    expect(await outbox.deliverPending(() => {}, SCOPE, undefined, { nowMs })).toEqual({
      sent: 1,
      failed: 0,
    });

    // A row whose identity moved on is not announced: the newer revision already supersedes it.
    const moved = alert('moved', 1, 'hot', nowMs);
    writeAlert(db, moved);
    outbox.enqueue(SCOPE, moved, 'live');
    writeAlert(db, alert('moved', 2, 'hot', nowMs));
    await outbox.deliverPending(() => {}, SCOPE, undefined, { nowMs });
    expect(
      db.prepare("select status,last_error from alert_outbox where alert_id='moved'").get(),
    ).toEqual({ status: 'superseded', last_error: 'stale-revision' });
  } finally {
    db.close();
  }
});

test('policy generation separates a normal restart from leaving a silent period', () => {
  const { db } = setup();
  try {
    expect(readDeliveryPolicy(db, SCOPE)).toBeNull();
    expect(setDeliveryMode(db, SCOPE, 'local', 10)).toMatchObject({
      transitioned: true,
      policy: { mode: 'local', generation: 1, enabledAtMs: 10 },
    });
    expect(setDeliveryMode(db, SCOPE, 'local', 20).transitioned).toBe(false);
    expect(setDeliveryMode(db, SCOPE, 'none', 30)).toMatchObject({
      transitioned: true,
      policy: { mode: 'none', generation: 1, disabledAtMs: 30 },
    });
    expect(setDeliveryMode(db, SCOPE, 'local', 40)).toMatchObject({
      transitioned: true,
      policy: { mode: 'local', generation: 2, enabledAtMs: 40 },
    });
  } finally {
    db.close();
  }
});
