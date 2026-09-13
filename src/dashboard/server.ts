import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DashboardSnapshot } from './types.js';
export interface DashboardServerOptions {
  readSnapshot: (at?: number) => DashboardSnapshot | Promise<DashboardSnapshot>;
  assetsDir?: string;
  cacheMs?: number;
}
const staticAssets: Record<string, { name: string; mime: string }> = {
  '/': { name: 'index.html', mime: 'text/html; charset=utf-8' },
  '/index.html': { name: 'index.html', mime: 'text/html; charset=utf-8' },
  '/styles.css': { name: 'styles.css', mime: 'text/css; charset=utf-8' },
  '/app.js': { name: 'app.js', mime: 'text/javascript; charset=utf-8' },
  '/view-model.js': { name: 'view-model.js', mime: 'text/javascript; charset=utf-8' },
};
export function createDashboardServer(options: DashboardServerOptions): Server {
  const base = dirname(fileURLToPath(import.meta.url));
  const compiled = join(base, 'web');
  const assetsDir =
    options.assetsDir ??
    (existsSync(join(compiled, 'app.js')) ? compiled : join(base, '../../dist/dashboard/web'));
  const cache = new Map<string, { at: number; value: DashboardSnapshot }>();
  const pending = new Map<string, Promise<DashboardSnapshot>>();
  let serial: Promise<unknown> = Promise.resolve();
  const snapshot = (at?: number) => {
    const key = at === undefined ? 'live' : String(at),
      prior = cache.get(key);
    if (prior && Date.now() - prior.at < (options.cacheMs ?? 5000))
      return Promise.resolve(prior.value);
    const inflight = pending.get(key);
    if (inflight) return inflight;
    const work = serial
      .then(() => options.readSnapshot(at))
      .then((value) => {
        cache.set(key, { at: Date.now(), value });
        while (cache.size > 8) cache.delete(cache.keys().next().value!);
        return value;
      })
      .finally(() => {
        pending.delete(key);
      });
    pending.set(key, work);
    serial = work.catch(() => undefined);
    return work;
  };
  const server = createServer(async (req, res) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const json = (status: number, value: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(value));
    };
    const bound = server.address();
    const port = bound && typeof bound !== 'string' ? bound.port : null;
    const host = req.headers.host;
    if (
      req.socket.remoteAddress !== '127.0.0.1' ||
      !host ||
      ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host) ||
      (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`)
    ) {
      json(403, { error: 'Local same-origin requests only' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      json(405, { error: 'Read-only endpoint' });
      return;
    }
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) {
        json(400, { error: 'Invalid request URL' });
        return;
      }
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname === '/api/snapshot') {
        const values = url.searchParams.getAll('at');
        if (
          [...url.searchParams.keys()].some((k) => k !== 'at') ||
          values.length > 1 ||
          (values[0] !== undefined && !/^(0|[1-9]\d*)$/.test(values[0]))
        ) {
          json(400, { error: 'Invalid cutoff query' });
          return;
        }
        const at = values[0] === undefined ? undefined : Number(values[0]);
        if (at !== undefined && (!Number.isSafeInteger(at) || at % 60 !== 59)) {
          json(400, { error: 'Cutoff must be the final second of a minute' });
          return;
        }
        const value = await snapshot(at);
        json(200, value);
        return;
      }
      const asset = Object.hasOwn(staticAssets, url.pathname)
        ? staticAssets[url.pathname]
        : undefined;
      if (!asset || url.search) {
        json(404, { error: 'Not found' });
        return;
      }
      let body: Buffer;
      try {
        body = readFileSync(join(assetsDir, asset.name));
      } catch {
        json(503, { error: 'Dashboard assets unavailable; run pnpm build' });
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', asset.mime);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      json(error instanceof RangeError ? 400 : 503, {
        error:
          error instanceof RangeError
            ? 'Cutoff is outside retained chain-time evidence'
            : 'Local snapshot unavailable',
      });
    }
  });
  // No caller can accidentally expose this server on an external interface.
  const listen = server.listen.bind(server);
  server.listen = ((...args: unknown[]) => {
    if (typeof args[0] !== 'number' || args[1] !== '127.0.0.1')
      throw new Error('Dashboard must bind to 127.0.0.1');
    return (listen as (...args: unknown[]) => Server)(...args);
  }) as Server['listen'];
  return server;
}
