import { Session } from 'node:inspector';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBenchmarkOptions, runBenchmark } from '../../scripts/benchmark-live-performance.mjs';
const options = parseBenchmarkOptions(process.argv.slice(2));
const session = new Session();
session.connect();
const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
await post('Profiler.enable');
await post('Profiler.setSamplingInterval', { interval: 1000 });
let start = post('Profiler.start');
let stop;
const report = await runBenchmark(options, { onProgress(line) {
  process.stdout.write(line + '\n');

  if (line.startsWith('init ')) stop = post('Profiler.stop');
}});
await start;
const { profile } = await stop;
mkdirSync(options.out, { recursive: true });
writeFileSync(join(options.out, 'benchmark.json'), JSON.stringify(report, null, 2) + '\n');
writeFileSync(join(options.out, 'init.cpuprofile'), JSON.stringify(profile));
session.disconnect();
console.log(JSON.stringify({ out: options.out, normal: report.normal.localProcessingMs, http: report.http.latencyMs }));
