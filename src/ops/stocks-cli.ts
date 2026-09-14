import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError } from '../config/env.js';
import { encodeJson } from '../domain/json.js';
import {
  buildStockSnapshot,
  diffStockSnapshots,
  loadStockSnapshot,
  type StockSnapshot,
} from '../registry/stock-snapshot.js';

const sourceUrl = 'https://api.robinhood.com/rhj/assets';

export async function runStocksCli(
  args: string[],
  options: { fetch?: typeof fetch; nowSec?: () => number } = {},
): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        input: { type: 'string' },
        before: { type: 'string' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch {
    throw new ConfigError('Invalid stocks option');
  }
  if (parsed.values.help) {
    console.log('stocks refresh --input PATH [--before PRIOR_WATCHLIST] --out DIR');
    return 0;
  }
  if (
    parsed.positionals.length !== 2 ||
    parsed.positionals[0] !== 'stocks' ||
    parsed.positionals[1] !== 'refresh'
  )
    throw new ConfigError('Invalid stocks command');
  const outputArgument = parsed.values.out;
  if (typeof outputArgument !== 'string') throw new ConfigError('stocks refresh requires --out');
  const inputArgument = parsed.values.input;
  if (inputArgument !== undefined && typeof inputArgument !== 'string')
    throw new ConfigError('Invalid stocks input');
  const beforeArgument = parsed.values.before;
  if (beforeArgument !== undefined && typeof beforeArgument !== 'string')
    throw new ConfigError('Invalid stocks before snapshot');
  const output = resolve(outputArgument);
  const raw = inputArgument
    ? readFileSync(resolve(inputArgument), 'utf8')
    : await fetchAssets(options.fetch ?? globalThis.fetch);
  const snapshot = buildStockSnapshot(
    raw,
    (options.nowSec ?? (() => Math.floor(Date.now() / 1000)))(),
  );
  const diff = diffStockSnapshots(
    beforeArgument ? loadStockSnapshot(resolve(beforeArgument)) : emptySnapshot(snapshot),
    snapshot,
  );
  writeSnapshot(output, raw, snapshot, diff);
  console.log(
    encodeJson({
      result: 'source.json + watchlist.json + diff.json',
      watchlist: join(output, 'watchlist.json'),
      coverageRecheckAddresses: [...diff.added, ...diff.statusChanged],
    }),
  );
  return 0;
}

async function fetchAssets(fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(sourceUrl);
  if (!response.ok) throw new Error(`Asset registry request failed: ${response.status}`);
  return response.text();
}

function writeSnapshot(
  output: string,
  raw: string,
  snapshot: StockSnapshot,
  diff: ReturnType<typeof diffStockSnapshots>,
): void {
  if (existsSync(output))
    throw new ConfigError('stocks refresh refuses to overwrite an existing output');
  const temporary = mkdtempSync(join(dirname(output), '.stocks-refresh-'));
  try {
    writeFileSync(join(temporary, 'source.json'), raw, { flag: 'wx' });
    writeFileSync(join(temporary, 'watchlist.json'), encodeJson(snapshot) + '\n', { flag: 'wx' });
    writeFileSync(join(temporary, 'diff.json'), encodeJson(diff) + '\n', { flag: 'wx' });
    renameSync(temporary, output);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function emptySnapshot(snapshot: StockSnapshot): StockSnapshot {
  return { ...snapshot, rwa: [], records: [] };
}
