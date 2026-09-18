import { expect, test } from 'vitest';
import { createServer } from 'node:http';
import { createChainReader } from '../../src/rpc/client.js';
/**
 * The unit tests drive the watchdog through an injected fetch, which can only show that its signal
 * is aborted. Whether an abort actually tears the connection down is undici's behaviour, so it is
 * settled here, against a real server holding a real socket open.
 */
test('a stalled body is abandoned instead of left holding the socket', async () => {
  let firstCloseAtMs = 0;
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      // Headers now, body never: the shape a stalling proxy presents to the reader.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"jsonrpc":"2.0","id":1,');
    });
  });
  server.on('connection', (socket) => {
    socket.on('close', () => (firstCloseAtMs ||= Date.now()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen');
  try {
    const reader = createChainReader(
      { httpRpcUrl: `http://127.0.0.1:${address.port}`, providerAlias: 'test', dataDir: 'data' },
      { timeoutMs: 200, maxRetries: 0, perSecond: 10000 },
    );
    const start = Date.now();
    await expect(reader.request('eth_chainId', [])).rejects.toMatchObject({
      kind: 'timeout-or-network',
      retryable: true,
    });
    // Well inside undici's 300s body default, which is all that ended this read before.
    const failedAtMs = Date.now();
    expect(failedAtMs - start).toBeLessThan(1000);
    // The connection has to go, not merely stop being read: an ESTABLISHED socket with nobody
    // reading it is the symptom the watchdog exists to remove. Only the first close is asserted --
    // undici opens a second, idle connection while tearing an aborted request down, which a bare
    // fetch with a bare AbortController does too, so waiting for the pool to drain proves nothing.
    await expect.poll(() => firstCloseAtMs, { timeout: 1500 }).toBeGreaterThan(0);
    expect(firstCloseAtMs - failedAtMs).toBeLessThan(1000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
