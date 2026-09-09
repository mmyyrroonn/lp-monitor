import { expect, test, vi } from 'vitest';
import { runRecorderCli } from '../../src/ops/recorder-cli.js';

test.each([
  ['follow', '--duration', '1s', '--notify', 'webhook'],
  ['ingest', '--from-block', '1', '--to-block', '2', '--notify', 'local'],
])('rejects unsupported notification mode before RPC: %s', async (...args) => {
  const factory = vi.fn();
  await expect(runRecorderCli(args, { environment: {}, readerFactory: factory })).rejects.toThrow(
    'notify',
  );
  expect(factory).not.toHaveBeenCalled();
});

test('strict signals config is checked before RPC', async () => {
  const factory = vi.fn();
  await expect(
    runRecorderCli(
      ['follow', '--duration', '1s', '--notify', 'local', '--signals', 'config/robinhood.json'],
      { environment: {}, readerFactory: factory },
    ),
  ).rejects.toThrow('signal');
  expect(factory).not.toHaveBeenCalled();
});
