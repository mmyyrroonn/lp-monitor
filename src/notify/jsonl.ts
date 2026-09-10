import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AlertRecord } from '../signals/types.js';
import type { AlertSink } from './console.js';

/** JSONL keeps JavaScript numbers numeric and encodes bigint fields as decimal strings. */
function losslessJson(alert: AlertRecord): string {
  return JSON.stringify(alert, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

export function createJsonlSink(path: string): AlertSink {
  let tail = Promise.resolve();
  return async (alert) => {
    const delivery = tail.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const file = await open(path, 'a');
      try {
        await file.writeFile(`${losslessJson(alert)}\n`, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
    });
    tail = delivery.catch(() => undefined);
    await delivery;
  };
}
