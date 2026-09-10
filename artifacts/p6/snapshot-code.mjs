import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { saveJson } from '../../dist/ops/files.js';
const stage = process.argv[2];
if (!['smoke', 'soak'].includes(stage)) throw Error('Expected smoke or soak');
const output = resolve('artifacts/p6', stage + '-code.json');
if (existsSync(output)) throw Error('Code snapshot exists');
const hash = data => createHash('sha256').update(data).digest('hex');
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(x => x.isDirectory() ? files(join(path, x.name)) : [join(path, x.name)]);
}
const entries = [...files('dist').filter(x => x.endsWith('.js')), 'config/runtime.local.json', 'config/signals.initial.json', 'config/metric-metadata.json', 'config/watchlist.amc.json', 'package.json', 'pnpm-lock.yaml']
  .sort().map(path => ({ path: path.replaceAll('\\', '/'), sha256: hash(readFileSync(path)) }));
saveJson(output, { stage, capturedAtMs: Date.now(), nodeVersion: process.version,
  fingerprint: hash(JSON.stringify(entries)), files: entries,
  note: 'Hash of the built JavaScript/configuration used by this stage; local branch changes are uncommitted. Stage fingerprints may differ after measured optimization.' }, resolve('artifacts/p6'));
console.log(output);
