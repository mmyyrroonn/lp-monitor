import { createServer, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { expect, test } from 'vitest';
import { createChainReader } from '../../src/rpc/client.js';
import { createShutdownController } from '../../src/ops/shutdown.js';

async function localRpc(handle: (res: ServerResponse) => void) {
  let connections = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => handle(res));
  });
  server.on('connection', (socket) => {
    connections++;
    socket.on('close', () => connections--);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen');
  return {
    env: {
      httpRpcUrl: `http://127.0.0.1:${address.port}`,
      providerAlias: 'local-test',
      dataDir: 'data',
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await expect.poll(() => connections).toBe(0);
    },
  };
}

test('absolute deadline cancels an active trickle even though body idle timeout never fires', async () => {
  let closed = false;
  const server = await localRpc((res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"jsonrpc":"2.0","id":1,"result":"');
    const timer = setInterval(() => res.write('a'), 20);
    res.on('close', () => {
      closed = true;
      clearInterval(timer);
    });
  });
  const started = Date.now();
  const reader = createChainReader(server.env, {
    deadlineMs: started + 250,
    timeoutMs: 150,
    maxRetries: 0,
  });
  try {
    await expect(reader.request('eth_chainId', [])).rejects.toMatchObject({
      kind: 'deadline',
      retryable: false,
    });
    expect(Date.now() - started).toBeLessThan(1200);
    await reader.close();
    expect(reader.meter.summary()).toMatchObject({
      calls: 1,
      retries: 0,
      activeRpc: 0,
      queueDepth: 0,
    });
    await expect.poll(() => closed).toBe(true);
  } finally {
    await server.stop();
  }
}, 2000);

test.each([0, 60_000])(
  'an oversized declared body releases its connection with idle timeout %i',
  async (timeoutMs) => {
    let closed = false;
    const server = await localRpc((res) => {
      res.on('close', () => {
        closed = true;
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': 11 * 1024 * 1024,
      });
      res.write('{"jsonrpc":"2.0","id":1,"result":"');
    });
    const reader = createChainReader(server.env, { timeoutMs, maxRetries: 0 });
    try {
      await expect(reader.request('eth_chainId', [])).rejects.toMatchObject({
        kind: 'range-limit',
      });
      // A rejected request owns no connection, even before the reader itself closes.
      await expect.poll(() => closed, { timeout: 1000 }).toBe(true);
      expect(reader.meter.summary()).toMatchObject({ calls: 1, activeRpc: 0, queueDepth: 0 });
    } finally {
      await reader.close();
      await server.stop();
    }
  },
);

test('a slow progressing response within the absolute budget still succeeds', async () => {
  const server = await localRpc((res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"jsonrpc":"2.0","id":1,"result":"');
    let chunks = 0;
    const timer = setInterval(() => {
      if (++chunks < 5) res.write('a');
      else {
        clearInterval(timer);
        res.end('"}');
      }
    }, 40);
    res.on('close', () => clearInterval(timer));
  });
  const reader = createChainReader(server.env, {
    deadlineMs: Date.now() + 1500,
    timeoutMs: 150,
    maxRetries: 0,
  });
  try {
    await expect(reader.request('eth_chainId', [])).resolves.toBe('aaaa');
    await reader.close();
  } finally {
    await server.stop();
  }
});

test.each(['headers', 'body', 'queue'] as const)(
  'SIGINT cancels %s waiting and drains without dispatching extra work',
  async (phase) => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => (entered = resolve));
    const server = await localRpc((res) => {
      if (phase === 'body') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"jsonrpc":');
      }
      if (phase === 'queue') res.end('{"jsonrpc":"2.0","id":1,"result":"0x1"}');
      entered();
    });
    const target = new EventEmitter();
    const shutdown = createShutdownController(target);
    const reader = createChainReader(server.env, {
      signal: shutdown.signal,
      deadlineMs: Date.now() + 5000,
      timeoutMs: 0,
      perSecond: 0.1,
      maxConcurrentRpc: 1,
    });
    try {
      const first = reader.request('eth_chainId', []);
      const result = first.catch((error) => error);
      await ready;
      if (phase === 'queue') await first;
      const queued = reader.request('eth_chainId', []).catch((error) => error);
      const started = Date.now();
      target.emit('SIGINT');
      if (phase !== 'queue')
        expect(await result).toMatchObject({ kind: 'aborted', retryable: false });
      expect(await queued).toMatchObject({ kind: 'aborted', retryable: false });
      await reader.close();
      expect(Date.now() - started).toBeLessThan(1000);
      expect(reader.meter.summary()).toMatchObject({ calls: 1, activeRpc: 0, queueDepth: 0 });
    } finally {
      shutdown.dispose();
      await server.stop();
    }
  },
  2000,
);
