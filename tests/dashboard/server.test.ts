import { afterEach, expect, test } from 'vitest';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { emptySnapshot } from '../../src/dashboard/snapshot.js';
import { metricInput } from '../helpers/alert-fixture.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request, type Server } from 'node:http';
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});
async function start(
  readSnapshot = async (_at?: number) => emptySnapshot(metricInput, 'empty', '没有数据'),
  assetsDir?: string,
) {
  const server = createDashboardServer({ readSnapshot, assetsDir });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('address');
  return `http://127.0.0.1:${address.port}`;
}
test('serves snapshot, rejects invalid cutoffs, methods and origin/host', async () => {
  const url = await start();
  expect((await fetch(url + '/api/snapshot')).status).toBe(200);
  for (const path of [
    '/api/snapshot?at=1.5',
    '/api/snapshot?at=60',
    '/api/snapshot?x=2',
    '/api/snapshot?at=59&at=119',
  ])
    expect((await fetch(url + path)).status).toBe(400);
  expect((await fetch(url + '/api/snapshot', { method: 'POST' })).status).toBe(405);
  expect(
    (await fetch(url + '/api/snapshot', { headers: { Origin: 'https://evil.example' } })).status,
  ).toBe(403);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(url + '/api/snapshot', { headers: { host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  expect(status).toBe(403);
});
test('static routes are allowlisted, with MIME, CSP and HEAD support', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-assets-'));
  writeFileSync(join(dir, 'index.html'), '<h1>Local</h1>');
  writeFileSync(join(dir, 'app.js'), 'export {};');
  const url = await start(undefined, dir),
    response = await fetch(url + '/');
  expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(await response.text()).toContain('Local');
  expect((await fetch(url + '/app.js')).headers.get('content-type')).toContain('javascript');
  expect(await (await fetch(url + '/', { method: 'HEAD' })).text()).toBe('');
  expect((await fetch(url + '/package.json')).status).toBe(404);
});
test('sanitizes unexpected source failures and coalesces concurrent refreshes', async () => {
  let calls = 0;
  const url = await start(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 15));
    throw Error('secret local path and api token');
  });
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => fetch(url + '/api/snapshot')),
  );
  expect(calls).toBe(1);
  for (const response of responses) {
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret');
  }
});
