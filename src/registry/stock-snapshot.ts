import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Address } from 'viem';
import { CHAIN_ID } from '../domain/chain.js';
import {
  assetRegistrationSchema,
  stockSnapshotRecordSchema,
  type AssetRegistration,
} from './assets.js';

const sourceUrl = 'https://api.robinhood.com/rhj/assets' as const;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;

export interface StockSnapshot {
  version: string;
  chainId: typeof CHAIN_ID;
  fetchedAtSec: number;
  sourceUrl: typeof sourceUrl;
  sourceHash: string;
  rwa: AssetRegistration[];
  records: Array<{ symbol: string; address: string; status: 'active' | 'inactive' }>;
}

type RawAsset = { tokenSymbol?: unknown; status?: unknown; deployments?: unknown };

const storedSnapshotSchema = z.object({
  version: z.string().min(1),
  chainId: z.literal(CHAIN_ID),
  fetchedAtSec: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sourceUrl: z.literal(sourceUrl),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  rwa: z.array(assetRegistrationSchema).min(1),
  records: z.array(stockSnapshotRecordSchema),
});

/**
 * `sourceHash` identifies the exact UTF-8 response text kept as evidence. `version` identifies
 * normalized chain-4663 records, so formatting and retrieval time are not list-semantic changes.
 */
export function buildStockSnapshot(raw: string, fetchedAtSec: number): StockSnapshot {
  if (!Number.isSafeInteger(fetchedAtSec) || fetchedAtSec < 0)
    throw new RangeError('fetchedAtSec must be a non-negative safe integer');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError('Invalid assets response JSON');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.assets))
    throw new TypeError('Invalid assets response: assets must be an array');
  const normalized = parsed.assets
    .flatMap((item) => normalizeAsset(item as RawAsset))
    .sort(compareRecord);
  const byAddress = new Map<string, (typeof normalized)[number]>();
  for (const record of normalized) {
    const prior = byAddress.get(record.address);
    if (prior && prior.status !== record.status)
      throw new RangeError(`Conflicting status for address ${record.address}`);
    if (prior && prior.symbol !== record.symbol)
      throw new RangeError(`Conflicting symbol for address ${record.address}`);
    byAddress.set(record.address, record);
  }
  const records = [...byAddress.values()].sort(compareRecord);
  const rwa = records
    .filter((record) => record.status === 'active')
    .map((record): AssetRegistration => ({
      symbol: record.symbol,
      address: record.address as Address,
      identityStatus: 'official-registry-active',
    }));
  if (rwa.length === 0) throw new RangeError('At least one active chain-4663 asset is required');
  return {
    version: createHash('sha256').update(JSON.stringify(records), 'utf8').digest('hex'),
    chainId: CHAIN_ID,
    fetchedAtSec,
    sourceUrl,
    sourceHash: createHash('sha256').update(raw, 'utf8').digest('hex'),
    rwa,
    records,
  };
}

export function loadStockSnapshot(path: string): StockSnapshot {
  return storedSnapshotSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function diffStockSnapshots(before: StockSnapshot, after: StockSnapshot) {
  const prior = new Map(before.records.map((record) => [record.address, record]));
  const next = new Map(after.records.map((record) => [record.address, record]));
  return {
    added: [...next.keys()].filter((address) => !prior.has(address)).sort(),
    removed: [...prior.keys()].filter((address) => !next.has(address)).sort(),
    statusChanged: [...next.entries()]
      .filter(
        ([address, record]) => prior.has(address) && prior.get(address)?.status !== record.status,
      )
      .map(([address]) => address)
      .sort(),
  };
}

function normalizeAsset(asset: RawAsset): StockSnapshot['records'] {
  if (!isRecord(asset) || typeof asset.tokenSymbol !== 'string' || asset.tokenSymbol.trim() === '')
    throw new TypeError('Invalid assets response: tokenSymbol');
  if (asset.status !== 'ASSET_STATUS_ACTIVE' && asset.status !== 'ASSET_STATUS_INACTIVE')
    throw new TypeError('Invalid assets response: status');
  if (!Array.isArray(asset.deployments))
    throw new TypeError('Invalid assets response: deployments');
  const symbol = asset.tokenSymbol.trim();
  return asset.deployments.flatMap((deployment) => {
    if (!isRecord(deployment) || typeof deployment.chainId !== 'number')
      throw new TypeError('Invalid assets response: deployment');
    if (deployment.chainId !== CHAIN_ID) return [];
    if (
      typeof deployment.contractAddress !== 'string' ||
      !addressPattern.test(deployment.contractAddress)
    )
      throw new TypeError('Invalid assets response: contract address');
    return [
      {
        symbol,
        address: deployment.contractAddress.toLowerCase(),
        status: asset.status === 'ASSET_STATUS_ACTIVE' ? 'active' : 'inactive',
      },
    ];
  });
}

function compareRecord(
  left: StockSnapshot['records'][number],
  right: StockSnapshot['records'][number],
): number {
  return left.address.localeCompare(right.address) || left.symbol.localeCompare(right.symbol);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
