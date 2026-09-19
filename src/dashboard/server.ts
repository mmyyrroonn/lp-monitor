import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SNAPSHOT_DETAIL_CONCURRENCY,
  SnapshotBusyError,
  SnapshotUnavailableError,
  type SnapshotCoordinator,
} from './snapshot-coordinator.js';
import {
  GENERATION_MAX_LENGTH,
  POOL_PAGE_DEFAULT_LIMIT,
  POOL_PAGE_MAX_LIMIT,
  SnapshotExpiredError,
} from './read-model.js';
import type { DashboardSnapshot, TokenMinute, WindowName } from './types.js';
/**
 * The two ways a snapshot can be answered, kept apart at the type level: a caller that hands in a
 * coordinator gets the worker-backed reader, and a caller that hands in `readSnapshot` gets exactly
 * the legacy path it always got. Passing both is not expressible, so there is no runtime choice to
 * get wrong.
 */
export type DashboardSnapshotSource =
  | { coordinator: SnapshotCoordinator; readSnapshot?: never }
  | {
      readSnapshot: (at?: number) => DashboardSnapshot | Promise<DashboardSnapshot>;
      coordinator?: never;
    };
export type DashboardServerOptions = DashboardSnapshotSource & {
  assetsDir?: string;
  cacheMs?: number;
};
/** How many tokens one overview batch may name in a single request. */
export const HISTORY_BATCH_MAX_ADDRESSES = 250;
/**
 * How many minutes one overview batch may ask for. The page derives its own ask from the drawn
 * horizon through `overviewMinutes`, which stops at the same three hours the reader retains.
 */
export const HISTORY_BATCH_MAX_MINUTES = 180;
export const HISTORY_BATCH_DEFAULT_MINUTES = 30;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const WINDOWS: readonly string[] = ['1m', '5m', '15m', '1h'];
const DETAIL_PATH = /^\/api\/tokens\/([^/]+)\/(pools|history)$/;
const staticAssets: Record<string, { name: string; mime: string }> = {
  '/': { name: 'index.html', mime: 'text/html; charset=utf-8' },
  '/index.html': { name: 'index.html', mime: 'text/html; charset=utf-8' },
  '/styles.css': { name: 'styles.css', mime: 'text/css; charset=utf-8' },
  '/app.js': { name: 'app.js', mime: 'text/javascript; charset=utf-8' },
  '/view-model.js': { name: 'view-model.js', mime: 'text/javascript; charset=utf-8' },
};
/**
 * One failure, one wire shape. A caller is told whether asking again can help — the generation is
 * gone, the reader is busy, or there is no reader — and never what the reader's stack, its SQL or
 * its local paths looked like.
 */
function failure(error: unknown): { status: number; body: { code?: string; error: string } } {
  if (error instanceof SnapshotExpiredError)
    return { status: 409, body: { code: 'SNAPSHOT_EXPIRED', error: 'Snapshot expired' } };
  if (error instanceof SnapshotBusyError)
    return { status: 503, body: { code: 'SNAPSHOT_BUSY', error: 'Snapshot is refreshing' } };
  if (error instanceof SnapshotUnavailableError)
    return {
      status: 503,
      body: { code: 'SNAPSHOT_UNAVAILABLE', error: 'Snapshot is unavailable' },
    };
  if (error instanceof RangeError)
    return { status: 400, body: { error: 'Invalid detail request' } };
  return { status: 503, body: { code: 'SNAPSHOT_UNAVAILABLE', error: 'Snapshot is unavailable' } };
}

/**
 * The parameters one route accepts, each named exactly once. A repeated or unknown name is not
 * guessed at — it is a bad request, the same rule the cutoff query has always used.
 */
function readQuery(url: URL, allowed: readonly string[]): Map<string, string> | null {
  const values = new Map<string, string>();
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    if (!allowed.includes(key) || all.length > 1) return null;
    values.set(key, all[0]!);
  }
  return values;
}

/** A whole number a request stated, or the default when it stated none. */
function readCount(
  value: string | undefined,
  bounds: { fallback: number; min: number; max: number },
): number | null {
  if (value === undefined) return bounds.fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < bounds.min || parsed > bounds.max) return null;
  return parsed;
}

/**
 * The overview's minute series: the same single-token read the detail chart makes, asked for every
 * stock at once under a bounded fan-out. One stock the reader cannot answer for fails the whole
 * request rather than quietly shortening the page — the caller keeps what it already drew and asks
 * again, which it cannot do if a token is simply missing.
 */
async function readBatchHistory(
  coordinator: SnapshotCoordinator,
  generation: string,
  addresses: readonly string[],
  minutes: number,
): Promise<{
  generation: string;
  minutes: number;
  tokens: { address: string; minutes: TokenMinute[] }[];
}> {
  const tokens = new Array<{ address: string; minutes: TokenMinute[] }>(addresses.length);
  let next = 0;
  const readers = Array.from(
    { length: Math.min(SNAPSHOT_DETAIL_CONCURRENCY, addresses.length) },
    async () => {
      for (let index = next++; index < addresses.length; index = next++) {
        const history = await coordinator.history({ generation, address: addresses[index]! });
        // The reader keeps a whole three-hour series; the overview draws at most an hour of it.
        tokens[index] = { address: history.tokenAddress, minutes: history.minutes.slice(-minutes) };
      }
    },
  );
  await Promise.all(readers);
  return { generation, minutes, tokens };
}

export function createDashboardServer(options: DashboardServerOptions): Server {
  const base = dirname(fileURLToPath(import.meta.url));
  const compiled = join(base, 'web');
  const assetsDir =
    options.assetsDir ??
    (existsSync(join(compiled, 'app.js')) ? compiled : join(base, '../../dist/dashboard/web'));
  const read = options.readSnapshot;
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
      .then(() => read!(at))
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
        if (options.coordinator !== undefined) {
          // Asking for a newer generation never blocks the answer: what is published right now is
          // what this request returns, and the next one sees whatever the worker produced. A cutoff
          // that is a valid minute end but has no evidence behind it is one of those answers — an
          // empty or stale summary a page can render — not a status code the page has to interpret.
          options.coordinator.refresh(at);
          json(200, options.coordinator.latest(at));
          return;
        }
        json(200, await snapshot(at));
        return;
      }
      const coordinator = options.coordinator;
      if (coordinator !== undefined) {
        const detail = DETAIL_PATH.exec(url.pathname);
        if (url.pathname === '/api/history' || detail !== null) {
          try {
            if (detail === null) {
              const query = readQuery(url, ['generation', 'addresses', 'minutes']);
              const generation = query?.get('generation');
              const asked = query?.get('addresses')?.split(',') ?? null;
              const minutes = readCount(query?.get('minutes'), {
                fallback: HISTORY_BATCH_DEFAULT_MINUTES,
                min: 1,
                max: HISTORY_BATCH_MAX_MINUTES,
              });
              // A caller that names the same token twice gets it answered once.
              const addresses =
                asked === null ? [] : [...new Set(asked.map((a) => a.toLowerCase()))];
              if (
                query === null ||
                generation === undefined ||
                generation.length === 0 ||
                generation.length > GENERATION_MAX_LENGTH ||
                minutes === null ||
                addresses.length === 0 ||
                addresses.length > HISTORY_BATCH_MAX_ADDRESSES ||
                !addresses.every((candidate) => ADDRESS_PATTERN.test(candidate))
              ) {
                json(400, { error: 'Invalid detail query' });
                return;
              }
              json(200, await readBatchHistory(coordinator, generation, addresses, minutes));
              return;
            }
            const address = detail[1]!;
            if (!ADDRESS_PATTERN.test(address)) {
              json(400, { error: 'Invalid detail query' });
              return;
            }
            if (detail[2] === 'history') {
              const query = readQuery(url, ['generation']);
              const generation = query?.get('generation');
              if (
                query === null ||
                generation === undefined ||
                generation.length === 0 ||
                generation.length > GENERATION_MAX_LENGTH
              ) {
                json(400, { error: 'Invalid detail query' });
                return;
              }
              json(200, await coordinator.history({ generation, address }));
              return;
            }
            const query = readQuery(url, ['generation', 'window', 'offset', 'limit']);
            const generation = query?.get('generation');
            const window = query?.get('window') ?? '';
            const offset = readCount(query?.get('offset'), {
              fallback: 0,
              min: 0,
              max: Number.MAX_SAFE_INTEGER,
            });
            const limit = readCount(query?.get('limit'), {
              fallback: POOL_PAGE_DEFAULT_LIMIT,
              min: 1,
              max: POOL_PAGE_MAX_LIMIT,
            });
            if (
              query === null ||
              generation === undefined ||
              generation.length === 0 ||
              generation.length > GENERATION_MAX_LENGTH ||
              !WINDOWS.includes(window) ||
              offset === null ||
              limit === null
            ) {
              json(400, { error: 'Invalid detail query' });
              return;
            }
            json(
              200,
              await coordinator.pools({
                generation,
                address,
                window: window as WindowName,
                offset,
                limit,
              }),
            );
            return;
          } catch (error) {
            const { status, body } = failure(error);
            json(status, body);
            return;
          }
        }
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
