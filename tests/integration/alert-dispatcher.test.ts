import { expect, test, vi } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import { AlertOutbox } from '../../src/notify/outbox.js';
import { AlertDispatcher } from '../../src/notify/dispatcher.js';
import { setDeliveryMode } from '../../src/notify/delivery-policy.js';
import type { AlertRecord } from '../../src/signals/types.js';

const SCOPE = 's';
const record = (id: string): AlertRecord =>
  ({
    id,
    revision: 1,
    kind: 'hot',
    status: 'provisional',
    observedAtMs: Date.now(),
    endAnchor: { number: 1n },
  }) as AlertRecord;

test('wake returns before the sink finishes and stop waits for the in-flight claim', async () => {
  const db = openDatabase(':memory:');
  try {
    const outbox = new AlertOutbox(db);
    setDeliveryMode(db, SCOPE, 'local', 1);
    for (const id of ['a', 'b']) outbox.enqueue(SCOPE, record(id), 'live');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const delivered: string[] = [];
    const dispatcher = new AlertDispatcher({
      db,
      outbox,
      scopeId: SCOPE,
      sink: async (alert) => {
        delivered.push(alert.id);
        if (alert.id === 'a') await gate;
      },
    });
    dispatcher.wake();
    // `wake` is synchronous: the follow loop has already moved on while the sink is still open.
    expect(delivered).toEqual([]);
    release();
    await dispatcher.stop();
    expect(delivered).toEqual(['a', 'b']);
    expect(dispatcher.stats).toMatchObject({ sent: 2, failed: 0, status: 'ok' });
  } finally {
    db.close();
  }
});

test('a catch-up wake claims withdrawals only; a later wake drains the rest', async () => {
  const db = openDatabase(':memory:');
  try {
    const outbox = new AlertOutbox(db);
    setDeliveryMode(db, SCOPE, 'local', 1);
    const kinds: (string | undefined)[] = [];
    vi.spyOn(outbox, 'deliverPending').mockImplementation(async (_sink, _scope, kind) => {
      kinds.push(kind);
      return { sent: 0, failed: 0 };
    });
    const dispatcher = new AlertDispatcher({ db, outbox, scopeId: SCOPE, sink: () => {} });
    dispatcher.wake({ retractionsOnly: true });
    await dispatcher.settle();
    expect(kinds).toEqual(['retracted']);
    dispatcher.wake();
    await dispatcher.settle();
    expect(kinds.slice(1)).toEqual([undefined]);
  } finally {
    db.close();
  }
});

test('a backlog drains in bounded pages and a failing sink cannot loop forever', async () => {
  const db = openDatabase(':memory:');
  try {
    const outbox = new AlertOutbox(db);
    setDeliveryMode(db, SCOPE, 'local', 1);
    for (let index = 0; index < 7; index += 1) outbox.enqueue(SCOPE, record(`a${index}`), 'live');
    const delivered: string[] = [];
    const dispatcher = new AlertDispatcher({
      db,
      outbox,
      scopeId: SCOPE,
      limit: 2,
      sink: (alert) => void delivered.push(alert.id),
    });
    dispatcher.wake();
    await dispatcher.settle();
    expect(delivered).toHaveLength(7);

    // Every claim of the next wake fails: the pump stops after one page instead of retrying the
    // same failed rows in a tight loop.
    for (let index = 0; index < 5; index += 1) outbox.enqueue(SCOPE, record(`b${index}`), 'live');
    vi.spyOn(outbox, 'deliverPending').mockImplementation(
      async (_sink, _scope, _kind, options) => ({
        sent: 0,
        failed: options?.limit ?? 0,
      }),
    );
    dispatcher.retryDue(0);
    await dispatcher.settle();
    expect(dispatcher.stats.failed).toBe(2);
  } finally {
    db.close();
  }
});

test('stop without drain leaves the backlog durable for the next run', async () => {
  const db = openDatabase(':memory:');
  try {
    const outbox = new AlertOutbox(db);
    setDeliveryMode(db, SCOPE, 'local', 1);
    outbox.enqueue(SCOPE, record('later'), 'live');
    const dispatcher = new AlertDispatcher({ db, outbox, scopeId: SCOPE, sink: () => {} });
    await dispatcher.settle();
    expect(dispatcher.stats.sent).toBe(0);
    expect(outbox.pendingCount(SCOPE)).toBe(1);
  } finally {
    db.close();
  }
});

test('the retry schedule is spaced but a commit wakeup is immediate', async () => {
  const db = openDatabase(':memory:');
  try {
    const outbox = new AlertOutbox(db);
    setDeliveryMode(db, SCOPE, 'local', 1);
    outbox.enqueue(SCOPE, record('a'), 'live');
    const delivered: string[] = [];
    let now = 1_000;
    const dispatcher = new AlertDispatcher({
      db,
      outbox,
      scopeId: SCOPE,
      now: () => now,
      sink: (alert) => void delivered.push(alert.id),
    });
    dispatcher.retryDue(5_000);
    await dispatcher.settle();
    expect(delivered).toEqual(['a']);

    outbox.enqueue(SCOPE, record('b'), 'live');
    now += 1_000;
    dispatcher.retryDue(5_000);
    await dispatcher.settle();
    expect(delivered).toEqual(['a']);

    now += 10_000;
    dispatcher.retryDue(5_000);
    await dispatcher.settle();
    expect(delivered).toEqual(['a', 'b']);

    outbox.enqueue(SCOPE, record('c'), 'live');
    dispatcher.wake();
    await dispatcher.settle();
    expect(delivered).toEqual(['a', 'b', 'c']);
  } finally {
    db.close();
  }
});
