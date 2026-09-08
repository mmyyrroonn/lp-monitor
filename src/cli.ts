import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { ConfigError, loadEnv } from './config/env.js';
import { loadChainConfig } from './config/chain.js';
import { createChainReader } from './rpc/client.js';
import { probeCapabilities } from './rpc/capabilities.js';
import { classifyRpcError, RpcFailure } from './rpc/errors.js';
import { captureFixture } from './ops/fixture-capture.js';
import { saveJson } from './ops/files.js';
import { encodeJson } from './domain/json.js';

const help = `Robinhood read-only P0 CLI
  pnpm lp probe --config config/robinhood.json --out artifacts/p0/capabilities.json
  pnpm lp capture --config config/robinhood.json --last-blocks 300 --out artifacts/p0/raw
  pnpm lp capture --from-block N --to-block N --out artifacts/p0/raw
  --help  Show this help (no RPC required).
Environment: RH_RPC_HTTP (required), RH_RPC_WS (optional), RH_PROVIDER_ALIAS, LP_DATA_DIR.
Capture runs once, bounded to 150 method calls. Output contains a new timestamped run folder.
Exit codes: 0 success, 1 internal error, 2 configuration, 3 required RPC/identity failure, 4 incomplete data.
`;
async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ allowPositionals: true, strict: true, options: {
      help: { type: 'boolean', short: 'h' }, config: { type: 'string' }, out: { type: 'string' },
      'last-blocks': { type: 'string' }, 'from-block': { type: 'string' }, 'to-block': { type: 'string' },
    } });
  } catch { throw new ConfigError('Invalid command option'); }
  const values = parsed.values; const command = parsed.positionals[0];
  if (values.help || !command) { console.log(help); return 0; }
  if (parsed.positionals.length !== 1 || !['probe', 'capture'].includes(command)) throw new ConfigError('Invalid command');
  function integer(key: string): bigint | undefined {
    const text = values[key]; if (text === undefined) return undefined;
    if (typeof text !== 'string' || !/^\d+$/.test(text)) throw new ConfigError('Invalid block argument');
    return BigInt(text);
  }
  const from = integer('from-block'); const to = integer('to-block'); const last = integer('last-blocks');
  if ((from === undefined) !== (to === undefined) || (from !== undefined && (from > to! || last !== undefined)) || last === 0n || (last !== undefined && last > 10000n)) throw new ConfigError('Invalid block range');
  if (command === 'probe' && [from, to, last].some(x => x !== undefined)) throw new ConfigError('Block arguments require capture');
  const env = loadEnv(process.env);
  const config = loadChainConfig(String(values.config ?? 'config/robinhood.json'));
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const output = resolve(String(values.out ?? (command === 'probe' ? 'artifacts/p0/capabilities.json' : env.dataDir + '/p0')));
  const evidenceDir = command === 'probe' ? resolve(dirname(output), `probe-${runId}`) : resolve(output, runId);
  const evidenceFile = resolve(evidenceDir, 'requests.jsonl');
  const reader = createChainReader(env, { maxCalls: config.maxRpcCalls, perSecond: config.rpcPerSecond, timeoutMs: config.timeoutMs, maxRetries: config.maxRetries, evidenceFile });
  if (command === 'probe') {
    const report = await probeCapabilities(reader, { config, evidenceFile });
    let identities: unknown = null; let identityPassed = false;
    if (report.chainId === 4663 && report.requiredPassed) {
      try {
        const { verifyIdentity } = await import('./rpc/identity.js');
        const anchor = await reader.getAnchor('latest');
        const result = await verifyIdentity(reader, config, anchor);
        identities = result; identityPassed = result.requiredPassed;
      } catch (error) {
        identities = { status: 'unverified', requiredPassed: false, failure: classifyRpcError(error).kind };
      }
    }
    const identityEvidence = { sourceAlias: env.providerAlias, evidenceFile, report: identities };
    saveJson(resolve(dirname(output), 'identity-evidence.json'), identityEvidence);
    saveJson(resolve(evidenceDir, 'identity-evidence.json'), identityEvidence);
    const final = { ...report, identityPassed, meter: reader.meter.summary(), evidenceFile };
    saveJson(output, final);
    saveJson(resolve(evidenceDir, 'capabilities.json'), final);
    console.log(encodeJson({ output, sourceAlias: env.providerAlias, requiredPassed: report.requiredPassed, identityPassed, meter: final.meter }));
    return report.requiredPassed && identityPassed ? 0 : 3;
  }
  const head = await reader.getAnchor('latest');
  const toBlock = to ?? head.number; const fromBlock = from ?? (toBlock - (last ?? 300n) + 1n);
  if (fromBlock < 0n || toBlock > head.number || toBlock - fromBlock >= 10000n) throw new ConfigError('Block range outside available bounded capture');
  const manifest = await captureFixture(reader, config, { fromBlock, toBlock, captureMode: from === undefined ? 'live' : 'backfill', outDir: evidenceDir });
  console.log(encodeJson({ manifest: resolve(evidenceDir, 'manifest.json'), categories: manifest.categories, missing: manifest.missing, failures: manifest.failures, acceptancePassed: manifest.acceptancePassed, meter: manifest.meter }));
  return manifest.acceptancePassed ? 0 : 4;
}
main().then(code => { process.exitCode = code; }).catch((error: unknown) => {
  if (error instanceof ConfigError) { console.error(error.message); process.exitCode = 2; }
  else if (error instanceof RpcFailure) { console.error(`RPC ${error.kind}`); process.exitCode = error.kind === 'budget' ? 4 : 3; }
  else { console.error('Internal error; no provider details emitted'); process.exitCode = 1; }
});
