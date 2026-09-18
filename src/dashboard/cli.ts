import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { ConfigError } from '../config/env.js';
import { loadChainConfig } from '../config/chain.js';
import { loadAssetVersion } from '../registry/assets.js';
import { loadMetricMetadata } from '../metrics/metadata.js';
import { computeWatchScopeId } from '../ingest/filter-plan.js';
import { createDashboardReader } from './snapshot.js';
import {
  createSnapshotCoordinator,
  type SnapshotCoordinator,
  type SnapshotWorkerFactory,
} from './snapshot-coordinator.js';
import { createDashboardServer } from './server.js';
export async function runDashboardCli(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  options: { workerFactory?: SnapshotWorkerFactory } = {},
): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        db: { type: 'string' },
        config: { type: 'string' },
        watchlist: { type: 'string' },
        metadata: { type: 'string' },
        port: { type: 'string' },
        'legacy-snapshot': { type: 'boolean' },
      },
    });
  } catch {
    throw new ConfigError('Invalid dashboard option');
  }
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== 'dashboard')
    throw new ConfigError('Invalid dashboard command');
  const values = parsed.values,
    port = Number(values.port ?? 8787);
  if (
    !/^\d+$/.test(String(values.port ?? 8787)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new ConfigError('Dashboard port must be 1..65535');
  const config = loadChainConfig(String(values.config ?? 'config/robinhood.json'));
  const assets = loadAssetVersion(String(values.watchlist ?? 'config/watchlist.stocks.json'));
  const metadata = loadMetricMetadata(String(values.metadata ?? 'config/metric-metadata.json'));
  const pathValue = String(values.db ?? (environment.LP_DATA_DIR ?? 'data') + '/recorder.sqlite');
  if (!pathValue.trim()) throw new ConfigError('Database path must not be blank');
  const path = resolve(pathValue);
  const input = {
    scopeId: computeWatchScopeId(assets, 'operations', config),
    registryScopeId: computeWatchScopeId(assets, 'discovery-only', config),
    configVersion: config.version,
    assets,
    usdg: config.tokens.USDG,
    metadata,
  };
  // `--legacy-snapshot` is the one explicit way back to the in-process reader; everything else is
  // answered by the worker-backed coordinator.
  const legacy = values['legacy-snapshot'] === true,
    reader = legacy ? createDashboardReader(path, input, { legacySnapshot: true }) : null,
    coordinator: SnapshotCoordinator | null = legacy
      ? null
      : createSnapshotCoordinator({
          dbPath: path,
          scopeId: input.scopeId,
          registryScopeId: input.registryScopeId,
          configVersion: input.configVersion,
          assetVersion: input.assets.version,
          // The worker rebuilds its own registry from these, so what crosses is JSON, not the class.
          assets: input.assets.assets,
          usdg: input.usdg,
          metadata: input.metadata,
          ...options,
        });
  // Said before the server binds, because the moment it binds this reader can stop answering: the
  // first read runs the whole source verification synchronously on this thread, and every request —
  // the page included — waits behind it.
  if (legacy)
    console.warn(
      'WARNING: --legacy-snapshot verifies the whole source on this thread at first read; ' +
        'the page and every other request stop answering until it finishes.',
    );
  const server =
    coordinator === null
      ? createDashboardServer({ readSnapshot: (at) => reader!.read(at) })
      : createDashboardServer({ coordinator });
  return new Promise<number>((resolveResult) => {
    let done = false;
    const finish = async (code: number) => {
      if (done) return;
      done = true;
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      reader?.close();
      await coordinator?.close();
      resolveResult(code);
    };
    const stop = () => {
      server.close(() => void finish(0));
      server.closeIdleConnections();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    server.once('error', () => {
      console.error('Unable to start local dashboard; check the port and local configuration.');
      void finish(2);
    });
    server.listen(port, '127.0.0.1', () =>
      console.log(`Dashboard: http://127.0.0.1:${port} (read-only; Ctrl+C stops)`),
    );
  });
}
