import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { ConfigError } from '../config/env.js';
import { loadChainConfig } from '../config/chain.js';
import { loadAssetVersion } from '../registry/assets.js';
import { loadMetricMetadata } from '../metrics/metadata.js';
import { computeWatchScopeId } from '../ingest/filter-plan.js';
import { createDashboardReader } from './snapshot.js';
import { createDashboardServer } from './server.js';
export async function runDashboardCli(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
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
  const reader = createDashboardReader(path, input, {
    legacySnapshot: values['legacy-snapshot'] === true,
  });
  const server = createDashboardServer({
    readSnapshot: (at) => reader.read(at),
  });
  return new Promise<number>((resolveResult) => {
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      reader.close();
      resolveResult(code);
    };
    const stop = () => {
      server.close(() => finish(0));
      server.closeIdleConnections();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    server.once('error', () => {
      console.error('Unable to start local dashboard; check the port and local configuration.');
      finish(2);
    });
    server.listen(port, '127.0.0.1', () =>
      console.log(`Dashboard: http://127.0.0.1:${port} (read-only; Ctrl+C stops)`),
    );
  });
}
