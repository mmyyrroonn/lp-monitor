import type { EventEmitter } from 'node:events';

export class ShutdownRequested extends Error {
  constructor() {
    super('Cooperative shutdown requested');
  }
}

/** Stop between ranges/transactions after finishing pending I/O; never exit the process. */
export function createShutdownController(target: Pick<EventEmitter, 'on' | 'off'> = process) {
  let reason: string | null = null;
  const waiters = new Set<() => void>();
  const request = (why: string) => {
    reason ??= why;
    for (const wake of waiters) wake();
  };
  const interrupt = () => request('SIGINT');
  const terminate = () => request('SIGTERM');
  target.on('SIGINT', interrupt);
  target.on('SIGTERM', terminate);
  return {
    get requested() {
      return reason !== null;
    },
    get reason() {
      return reason;
    },
    request,
    throwIfRequested() {
      if (reason !== null) throw new ShutdownRequested();
    },
    wait(ms: number): Promise<void> {
      if (reason !== null) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        waiters.add(done);
      });
    },
    dispose() {
      target.off('SIGINT', interrupt);
      target.off('SIGTERM', terminate);
      for (const wake of waiters) wake();
    },
  };
}
export type ShutdownController = ReturnType<typeof createShutdownController>;
