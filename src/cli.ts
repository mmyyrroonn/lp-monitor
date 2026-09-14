import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { ConfigError, loadEnv } from './config/env.js';
import { loadChainConfig } from './config/chain.js';
import { createChainReader } from './rpc/client.js';
import { probeCapabilities } from './ops/capabilities.js';
import { classifyRpcError, RpcFailure } from './rpc/errors.js';
import { captureFixture } from './ops/fixture-capture.js';
import { saveJson, repositoryRelativePath } from './ops/files.js';
import { CHAIN_ID } from './domain/chain.js';
import { encodeJson } from './domain/json.js';

const help = `Robinhood read-only P0/P1/P2/P3/P4/P5/P6 CLI
  pnpm lp dashboard --db data/recorder.sqlite --port 8787 [--legacy-snapshot]
  pnpm lp history --from-block N --to-block M --db data/recorder.sqlite [--out artifacts/history]
  pnpm lp catalogue --duration 10m --db data/recorder.sqlite --out artifacts/catalogue [--to-block N]
  pnpm lp storage audit --db data/recorder.sqlite [--artifacts artifacts/p1]
  pnpm lp storage compact --source data/recorder.sqlite --out data/recorder-compact.sqlite
  pnpm lp status --db data/recorder.sqlite --scope SCOPE_ID
  pnpm lp backup --db data/recorder.sqlite --out data/backup.sqlite
  P6: follow writes <db>.health.json and per-run ops-report.json; SIGINT stops cooperatively.
  pnpm lp replay --manifest PATH --rules PATH --mode minute-close|recorded-observed --out PATH
  pnpm lp study --cases config/history.cases.json --grid config/signals.grid.json --out artifacts/p5
  pnpm lp stocks refresh --input PATH [--before PRIOR_WATCHLIST] --out DIR
  P5: offline, uses existing raw only; insufficient history exits 4.
  pnpm lp metrics --db data/recorder.sqlite --rwa AMC --window 15m
  pnpm lp rank --db data/recorder.sqlite --sort volume5m
  P3: offline; --out PATH saves JSON, --save persists derived cache.
  pnpm lp project --db data/recorder.sqlite --rebuild
  pnpm lp inspect-pool --db data/recorder.sqlite --pool amc-usdg-v3
  P2 commands are offline; no RPC environment required.
  pnpm lp ingest --config config/robinhood.json --from-block N --to-block N
  pnpm lp follow --config config/robinhood.json --duration 10m
  P4: follow --notify local [--signals config/signals.initial.json] [--metadata PATH]
  Local alerts: console and <db>.alerts.jsonl; default follow only records.
  Default follow starts at the latest block on every launch; no historical discovery or catch-up.
  Known pools only; unregistered historical pools remain unknown. Explicit --from-block keeps historical discovery.
  Live follow incrementally projects changed logs and retains bounded metric windows; 2s polling is not a latency guarantee.
  P1: --db PATH --watchlist PATH --max-rpc-calls N (default 10000)
  P1: --evidence full|sampled|off (default sampled); bounded run only.
  pnpm lp probe --config config/robinhood.json --out artifacts/p0/capabilities.json
  pnpm lp capture --config config/robinhood.json --last-blocks 300 --out artifacts/p0/raw
  pnpm lp capture --from-block N --to-block N --out artifacts/p0/raw
  --evidence full|sampled|off  Request evidence policy (default full).
  --help  Show this help (no RPC required).
Environment: RH_RPC_HTTP (required), RH_RPC_WS (optional), RH_PROVIDER_ALIAS, LP_DATA_DIR.
Capture runs once, bounded to 150 method calls. Output contains a new timestamped run folder.
Exit codes: 0 success, 1 internal error, 2 configuration, 3 required RPC/identity failure, 4 incomplete data.
`;
export async function runCli(
  args = process.argv.slice(2),
  options: { environment?: NodeJS.ProcessEnv; readerFactory?: typeof createChainReader } = {},
): Promise<number> {
  if (args[0] === 'stocks') {
    const { runStocksCli } = await import('./ops/stocks-cli.js');
    return runStocksCli(args);
  }
  if (args[0] === 'catalogue' && !args.includes('--help') && !args.includes('-h')) {
    const { runCatalogueCli } = await import('./ops/catalogue-cli.js');
    return runCatalogueCli(args, options);
  }
  if (args[0] === 'storage' && !args.includes('--help') && !args.includes('-h')) {
    const { runStorageCli } = await import('./ops/storage-cli.js');
    return runStorageCli(args);
  }
  if (args[0] === 'dashboard' && !args.includes('--help') && !args.includes('-h')) {
    const { runDashboardCli } = await import('./dashboard/cli.js');
    return runDashboardCli(args, options.environment ?? process.env);
  }
  if (args[0] === 'history' && !args.includes('--help') && !args.includes('-h')) {
    const { runHistoryCli } = await import('./ops/history-cli.js');
    return runHistoryCli(args, options);
  }
  if (
    ['status', 'backup'].includes(args[0] ?? '') &&
    !args.includes('--help') &&
    !args.includes('-h')
  ) {
    const { runStatusCli } = await import('./ops/status-cli.js');
    return runStatusCli(args, options.environment ?? process.env);
  }
  if (
    ['ingest', 'follow'].includes(args[0] ?? '') &&
    !args.includes('--help') &&
    !args.includes('-h')
  ) {
    const { runRecorderCli } = await import('./ops/recorder-cli.js');
    return runRecorderCli(args, options);
  }
  if (
    ['project', 'inspect-pool'].includes(args[0] ?? '') &&
    !args.includes('--help') &&
    !args.includes('-h')
  ) {
    const { runProjectionCli } = await import('./ops/projection-cli.js');
    return runProjectionCli(args, options.environment ?? process.env);
  }
  if (
    ['metrics', 'rank'].includes(args[0] ?? '') &&
    !args.includes('--help') &&
    !args.includes('-h')
  ) {
    const { runMetricsCli } = await import('./ops/metrics-cli.js');
    return runMetricsCli(args, options.environment ?? process.env);
  }
  if (args[0] === 'replay' && !args.includes('--help')) {
    const { runReplayCli } = await import('./replay/cli.js');
    return runReplayCli(args);
  }
  if (args[0] === 'study' && !args.includes('--help') && !args.includes('-h')) {
    const { runStudyCli } = await import('./replay/study-cli.js');
    return runStudyCli(args);
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        config: { type: 'string' },
        out: { type: 'string' },
        evidence: { type: 'string' },
        'last-blocks': { type: 'string' },
        'from-block': { type: 'string' },
        'to-block': { type: 'string' },
      },
    });
  } catch {
    throw new ConfigError('Invalid command option');
  }
  const values = parsed.values;
  const command = parsed.positionals[0];
  if (values.help || !command) {
    console.log(help);
    return 0;
  }
  if (parsed.positionals.length !== 1 || !['probe', 'capture'].includes(command))
    throw new ConfigError('Invalid command');
  function integer(key: string): bigint | undefined {
    const text = values[key];
    if (text === undefined) return undefined;
    if (typeof text !== 'string' || !/^\d+$/.test(text))
      throw new ConfigError('Invalid block argument');
    return BigInt(text);
  }
  const from = integer('from-block');
  const to = integer('to-block');
  const last = integer('last-blocks');
  if (
    (from === undefined) !== (to === undefined) ||
    (from !== undefined && (from > to! || last !== undefined)) ||
    last === 0n ||
    (last !== undefined && last > 10000n)
  )
    throw new ConfigError('Invalid block range');
  if (command === 'probe' && [from, to, last].some((x) => x !== undefined))
    throw new ConfigError('Block arguments require capture');
  const env = loadEnv(options.environment ?? process.env);
  const config = loadChainConfig(String(values.config ?? 'config/robinhood.json'));
  const evidenceMode = values.evidence ?? 'full';
  if (!['full', 'sampled', 'off'].includes(String(evidenceMode)))
    throw new ConfigError('Invalid evidence policy');
  const rangeLimit = BigInt(config.maxRangeBlocks);
  if (
    (last !== undefined && last > rangeLimit) ||
    (from !== undefined && to! - from + 1n > rangeLimit)
  )
    throw new ConfigError('Block range exceeds configured maxRangeBlocks');
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const output = resolve(
    String(
      values.out ?? (command === 'probe' ? 'artifacts/p0/capabilities.json' : env.dataDir + '/p0'),
    ),
  );
  const evidenceDir =
    command === 'probe' ? resolve(dirname(output), `probe-${runId}`) : resolve(output, runId);
  const evidenceFile = resolve(evidenceDir, 'requests.jsonl');
  const reader = (options.readerFactory ?? createChainReader)(env, {
    maxCalls: Math.min(config.maxRpcCalls ?? 150, 150),
    perSecond: Math.min(config.rpcPerSecond, 5),
    timeoutMs: Math.min(config.timeoutMs, 10000),
    maxRetries: config.maxRetries,
    evidenceFile,
    evidenceMode: evidenceMode as 'full' | 'sampled' | 'off',
  });
  let primaryError: unknown;
  let failed = false;
  let incompleteCapture = false;
  try {
    if (command === 'probe') {
      const report = await probeCapabilities(reader, { config, evidenceFile });
      let identities: unknown = null;
      let identityPassed = false;
      if (report.chainId === CHAIN_ID && report.requiredPassed) {
        try {
          const { verifyIdentity } = await import('./registry/identity.js');
          const anchor = await reader.getAnchor('latest');
          const result = await verifyIdentity(reader, config, anchor);
          identities = result;
          identityPassed = result.requiredPassed;
        } catch (error) {
          if (error instanceof RpcFailure && (error.kind === 'budget' || error.evidenceFailure))
            throw error;
          identities = {
            status: 'unverified',
            requiredPassed: false,
            failure: classifyRpcError(error).kind,
          };
        }
      }
      const forDirectory = (base: string) => {
        const relativeEvidence =
          evidenceMode === 'off' ? '' : repositoryRelativePath(evidenceFile, base);
        return {
          ...report,
          pathBase: 'artifact-directory',
          identityPassed,
          evidenceMode,
          meter: reader.meter.summary(),
          evidenceFile: relativeEvidence,
          capabilities: Object.fromEntries(
            Object.entries(report.capabilities).map(([name, item]) => [
              name,
              { ...item, evidenceFile: relativeEvidence },
            ]),
          ),
        };
      };
      for (const base of [dirname(output), evidenceDir]) {
        const identityEvidence = {
          pathBase: 'artifact-directory',
          sourceAlias: env.providerAlias,
          evidenceFile: evidenceMode === 'off' ? '' : repositoryRelativePath(evidenceFile, base),
          report: identities,
        };
        saveJson(resolve(base, 'identity-evidence.json'), identityEvidence, base);
      }
      const final = forDirectory(dirname(output));
      await reader.flush?.();
      saveJson(output, final, dirname(output));
      saveJson(resolve(evidenceDir, 'capabilities.json'), forDirectory(evidenceDir), evidenceDir);
      console.log(
        encodeJson({
          output,
          sourceAlias: env.providerAlias,
          requiredPassed: report.requiredPassed,
          identityPassed,
          meter: final.meter,
        }),
      );
      return report.requiredPassed && identityPassed ? 0 : 3;
    }
    const head = await reader.getAnchor('latest');
    const toBlock = to ?? head.number;
    const fromBlock = from ?? toBlock - (last ?? (rangeLimit < 300n ? rangeLimit : 300n)) + 1n;
    if (fromBlock < 0n || toBlock > head.number || toBlock - fromBlock >= rangeLimit)
      throw new ConfigError('Block range outside available bounded capture');
    const manifest = await captureFixture(reader, config, {
      fromBlock,
      toBlock,
      captureMode: from === undefined ? 'live' : 'backfill',
      outDir: evidenceDir,
    });
    console.log(
      encodeJson({
        manifest: resolve(evidenceDir, 'manifest.json'),
        categories: manifest.categories,
        missing: manifest.missing,
        failures: manifest.failures,
        acceptancePassed: manifest.acceptancePassed,
        meter: manifest.meter,
      }),
    );
    incompleteCapture = !manifest.acceptancePassed;
    return manifest.acceptancePassed ? 0 : 4;
  } catch (error) {
    failed = true;
    primaryError = error;
    throw error;
  } finally {
    try {
      await reader.close?.();
    } catch (closeError) {
      if (!failed && !incompleteCapture) throw closeError;
      if (incompleteCapture)
        console.error(encodeJson({ evidenceFailure: classifyRpcError(closeError).kind }));
      if (primaryError instanceof RpcFailure && primaryError !== closeError)
        primaryError.evidenceFailure ??= classifyRpcError(closeError);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (error instanceof ConfigError) {
        console.error(error.message);
        process.exitCode = 2;
      } else if (error instanceof RpcFailure) {
        console.error(`RPC ${error.kind}`);
        if (error.evidenceFailure)
          console.error(encodeJson({ evidenceFailure: error.evidenceFailure.kind }));
        process.exitCode = error.kind === 'budget' ? 4 : 3;
      } else {
        console.error('Internal error; no provider details emitted');
        process.exitCode = 1;
      }
    });
