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

test('the explicit mode matrix rejects illegal combinations before RPC', async () => {
  const factory = vi.fn();
  const reader = { environment: {}, readerFactory: factory };
  // record never delivers; monitor never records only the ingest phase.
  await expect(
    runRecorderCli(['follow', '--duration', '1s', '--mode', 'record', '--notify', 'local'], reader),
  ).rejects.toThrow('--mode monitor');
  await expect(
    runRecorderCli(['ingest', '--from-block', '1', '--to-block', '2', '--mode', 'monitor'], reader),
  ).rejects.toThrow('follow');
  // Signal rules are what monitor mode loads; a bare follow may not ask for them.
  await expect(
    runRecorderCli(['follow', '--duration', '1s', '--signals', 'unused'], reader),
  ).rejects.toThrow('--mode monitor');
  await expect(
    runRecorderCli(['follow', '--duration', '1s', '--mode', 'watch'], reader),
  ).rejects.toThrow('record or monitor');
  await expect(
    runRecorderCli(['follow', '--duration', '1s', '--notify', 'webhook'], reader),
  ).rejects.toThrow('none or local');
  expect(factory).not.toHaveBeenCalled();
});
