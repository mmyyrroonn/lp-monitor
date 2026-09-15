import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Address } from 'viem';
import { CHAIN_ID } from '../domain/chain.js';

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase() as Address);
export const assetRegistrationSchema = z.strictObject({
  symbol: z.string().min(1),
  address: addressSchema,
  identityStatus: z.string().min(1),
});
export const stockSnapshotRecordSchema = z.strictObject({
  symbol: z.string().min(1),
  address: addressSchema,
  status: z.enum(['active', 'inactive']),
});
const watchlistSchema = z.object({
  version: z.string().min(1),
  chainId: z.literal(CHAIN_ID),
  rwa: z.array(assetRegistrationSchema).min(1),
  records: z.array(stockSnapshotRecordSchema).optional(),
});

export type AssetRegistration = z.infer<typeof assetRegistrationSchema>;
export type StockSnapshotRecord = z.infer<typeof stockSnapshotRecordSchema>;
export interface AssetRegistry {
  readonly chainId: typeof CHAIN_ID;
  readonly version: string;
  readonly assets: readonly AssetRegistration[];
  readonly addresses: readonly Address[];
  has(address: Address): boolean;
}

/**
 * The one constructor both loaders share, exported so a worker rebuilt from serializable inputs
 * keeps the very same validation and symbol handling the file loader applies.
 */
export function buildAssetRegistry(
  version: string,
  assets: readonly AssetRegistration[],
): AssetRegistry {
  if (version.trim().length === 0) throw new RangeError('Asset version must not be empty');
  const normalized = assets
    .map((asset) => ({ ...asset, address: asset.address.toLowerCase() as Address }))
    .sort((left, right) => left.address.localeCompare(right.address));
  const unique = new Map(normalized.map((asset) => [asset.address, asset]));
  if (unique.size !== normalized.length) throw new RangeError('Asset addresses must be unique');
  if (unique.size === 0) throw new RangeError('At least one observed RWA is required');
  const stableAssets = Object.freeze([...unique.values()]);
  const addresses = Object.freeze(stableAssets.map((asset) => asset.address));
  const addressSet = new Set(addresses);
  return Object.freeze({
    chainId: CHAIN_ID,
    version,
    assets: stableAssets,
    addresses,
    has(address: Address) {
      return addressSet.has(address.toLowerCase() as Address);
    },
  });
}

export function createAssetRegistry(version: string, addresses: readonly Address[]): AssetRegistry {
  return buildAssetRegistry(
    version,
    addresses.map((address) => ({ symbol: address, address, identityStatus: 'observed' })),
  );
}

export function loadAssetVersion(path: string): AssetRegistry {
  const parsed = watchlistSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  return buildAssetRegistry(parsed.version, parsed.rwa);
}
