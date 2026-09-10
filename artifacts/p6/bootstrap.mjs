// Bounded registry/bootstrap preparation; uses only the public/local configured RPC.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from '../../dist/config/env.js';
import { loadChainConfig } from '../../dist/config/chain.js';
import { createChainReader } from '../../dist/rpc/client.js';
import { runCli } from '../../dist/cli.js';
import { saveJson } from '../../dist/ops/files.js';
import { encodeJson } from '../../dist/domain/json.js';
const out = resolve('artifacts/p6');
mkdirSync(out, { recursive: true });
const config = loadChainConfig('config/runtime.local.json');
const env = loadEnv(process.env);
const reader = createChainReader(env, { maxCalls: 5, deadlineMs: Date.now() + 20000,
  perSecond: config.rpcPerSecond, timeoutMs: config.timeoutMs, maxRetries: 1 });
let head;
try { head = await reader.getAnchor('latest'); }
finally { await reader.close(); }
saveJson(resolve(out, 'bootstrap-head.json'), { sourceAlias: env.providerAlias, head,
  meter: reader.meter.summary(), atMs: Date.now() }, out);
await new Promise(r => setTimeout(r, 1000));
const startedAtMs = Date.now();
const exitCode = await runCli(['ingest', '--config', 'config/runtime.local.json',
  '--db', 'data/p6.sqlite', '--out', 'artifacts/p6/runs', '--from-block', String(head.number - 99n),
  '--to-block', String(head.number), '--max-rpc-calls', '5000']);
saveJson(resolve(out, 'bootstrap-result.json'), { startedAtMs, finishedAtMs: Date.now(), exitCode,
  fromBlock: head.number - 99n, toBlock: head.number,
  note: 'Initial registry scan retained; operation seed is only the latest 100 observed blocks. Older baseline windows remain warming.' }, out);
console.log(encodeJson({ event: 'p6-bootstrap-finished', exitCode }));
process.exitCode = exitCode;
