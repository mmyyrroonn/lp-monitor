import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const EVENT_COUNT = 10_000;
const SELECTOR_COUNT = 100;
const EVALUATION_COUNT = 100;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseOutput(argv) {
  const index = argv.indexOf('--out');
  if (index < 0 || !argv[index + 1])
    throw new Error('Usage: node scripts/benchmark-heat-storage.mjs --out DIR');
  return resolve(argv[index + 1]);
}

function json(value) {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item));
}

const output = parseOutput(process.argv.slice(2));
if (existsSync(output)) throw new Error('Benchmark output already exists; choose a new directory');
mkdirSync(dirname(output), { recursive: true });
mkdirSync(output);

const selectors = Array.from({ length: SELECTOR_COUNT }, (_, index) => ({
  address: `0x${(index + 1).toString(16).padStart(40, '0')}`,
  topics: [`0x${(index + 1000).toString(16).padStart(64, '0')}`],
}));
const evaluations = Array.from({ length: EVALUATION_COUNT }, (_, index) => ({
  version: 'p3-v3',
  threshold: '2.0',
  window: '5m',
  outcome: index % 3 === 0 ? 'candidate' : 'quiet',
}));
const events = Array.from({ length: EVENT_COUNT }, (_, index) => ({
  id: `event-${index}`,
  blockNumber: BigInt(61_000_000 + index),
  selector: selectors[index % SELECTOR_COUNT],
  evaluation: evaluations[index % EVALUATION_COUNT],
  amount: String(1_000_000 + (index % 97)),
  poolId: `pool-${index % 200}`,
}));

const oldBytes = Buffer.from(events.map((event) => json(event)).join('\n') + '\n', 'utf8');
const compactRows = events.map((event, index) =>
  json({
    id: event.id,
    blockNumber: event.blockNumber,
    selectorRef: `selector-${index % SELECTOR_COUNT}`,
    evaluationRef: `evaluation-${index % EVALUATION_COUNT}`,
    amount: event.amount,
    poolId: event.poolId,
  }),
);
const compactBytes = Buffer.from(
  json({
    format: 'heat-storage-benchmark-v1',
    selectors,
    evaluations,
    events: compactRows.map((row) => JSON.parse(row)),
  }),
  'utf8',
);
const oldGzip = gzipSync(oldBytes, { level: 9 });
const compactGzip = gzipSync(compactBytes, { level: 9 });
const logicalHash = sha256(Buffer.from(json(events), 'utf8'));
writeFileSync(resolve(output, 'legacy.jsonl'), oldBytes);
writeFileSync(resolve(output, 'compact.json.gz'), compactGzip);

const totalLegacy = oldBytes.byteLength;
const totalCompact = compactBytes.byteLength + compactGzip.byteLength;
const report = {
  version: 1,
  status: totalCompact < totalLegacy * 0.5 ? 'passed' : 'not-passed',
  eventCount: events.length,
  selectorCount: selectors.length,
  evaluationCount: evaluations.length,
  logicalHash,
  legacyBytes: totalLegacy,
  legacyGzipBytes: oldGzip.byteLength,
  compactLogicalBytes: compactBytes.byteLength,
  compactGzipBytes: compactGzip.byteLength,
  comparableLegacyBytes: totalLegacy,
  comparableCompactBytes: totalCompact,
  reductionRatio: 1 - totalCompact / totalLegacy,
  notes: [
    'Synthetic repeated-selector/evaluation fixture; no RPC and no production database copy',
    'A benchmark result does not extrapolate to full-chain or full-month storage',
  ],
};
writeFileSync(resolve(output, 'report.json'), json(report) + '\n');
console.log(json(report));
