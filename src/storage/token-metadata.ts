import type Database from 'better-sqlite3';
import { toHex, type Address } from 'viem';
import type { BlockAnchor } from '../domain/types.js';
import { decimalsAt, type MetricMetadata } from '../metrics/metadata.js';
import { RpcFailure, classifyRpcError } from '../rpc/errors.js';

type Reader = {
  getAnchor(block: bigint | 'latest'): Promise<BlockAnchor>;
  request(method: string, params: readonly unknown[]): Promise<unknown>;
};
export type TokenMetadataTarget = { address: Address; blockNumber: bigint };
const empty: MetricMetadata = {
  version: 'onchain-v1',
  chainId: 4663,
  source: 'eth_call decimals at anchored block',
  entries: [],
};
function hasCache(db: Database.Database) {
  return !!db
    .prepare("select 1 from sqlite_master where type='table' and name='token_metadata'")
    .get();
}
export function readCachedMetricMetadata(
  db: Database.Database,
  seed: MetricMetadata,
): MetricMetadata {
  if (!hasCache(db)) return seed;
  const rows = db
    .prepare(
      'select address,decimals,block_number,block_hash from token_metadata order by block_number,address',
    )
    .all() as { address: string; decimals: number; block_number: number; block_hash: string }[];
  const invalidRows = db
    .prepare('select block_number,block_hash from token_metadata_invalid_anchors')
    .all() as { block_number: number; block_hash: string }[];
  if (!rows.length && !invalidRows.length) return seed;
  const invalid = new Set(
    invalidRows.map((r) => String(r.block_number) + ':' + r.block_hash.toLowerCase()),
  );
  const merged = new Map(
    seed.entries
      .filter((e) => !invalid.has(e.observedAtBlock + ':' + e.blockHash.toLowerCase()))
      .map((e) => [e.address + ':' + e.observedAtBlock, e]),
  );
  for (const row of rows)
    merged.set(row.address + ':' + row.block_number, {
      address: row.address,
      decimals: row.decimals,
      observedAtBlock: String(row.block_number),
      blockHash: row.block_hash,
    });
  return {
    ...seed,
    version: seed.version + '+onchain-v1',
    source: seed.source + '; recorder token_metadata',
    entries: [...merged.values()],
  };
}
function critical(error: unknown): void {
  const failure = classifyRpcError(error);
  if (
    ['budget', 'deadline', 'reader-closed', 'evidence-write'].includes(failure.kind) ||
    failure.evidenceFailure ||
    (error instanceof Error && error.constructor.name === 'ShutdownRequested')
  )
    throw error;
}
export async function validateTokenMetadata(
  db: Database.Database,
  reader: Reader,
  seed: MetricMetadata = empty,
): Promise<void> {
  if (!hasCache(db)) return;
  const rows = db.prepare('select distinct block_number,block_hash from token_metadata').all() as {
    block_number: number;
    block_hash: string;
  }[];
  const stored = new Set(
    rows.map((r) => String(r.block_number) + ':' + r.block_hash.toLowerCase()),
  );
  rows.push(
    ...seed.entries.map((e) => ({
      block_number: Number(e.observedAtBlock),
      block_hash: e.blockHash,
    })),
  );
  const byHeight = new Map<number, Set<string>>();
  for (const row of rows)
    byHeight.set(
      row.block_number,
      new Set([...(byHeight.get(row.block_number) ?? []), row.block_hash.toLowerCase()]),
    );
  for (const [height, hashes] of byHeight) {
    const anchor = await reader.getAnchor(BigInt(height));
    db.transaction(() => {
      for (const hash of hashes) {
        if (anchor.hash.toLowerCase() !== hash) {
          db.prepare(
            'insert or ignore into token_metadata_invalid_anchors(block_number,block_hash) values(?,?)',
          ).run(height, hash);
          if (stored.has(String(height) + ':' + hash)) {
            db.prepare('delete from token_metadata where block_number>=?').run(height);
            db.prepare('delete from token_metadata_failures').run();
          }
        } else
          db.prepare(
            'delete from token_metadata_invalid_anchors where block_number=? and block_hash=?',
          ).run(height, hash);
      }
    })();
  }
}
export async function refreshTokenMetadata(
  db: Database.Database,
  reader: Reader,
  targets: readonly TokenMetadataTarget[],
  options: { nowMs?: number; maxTokens?: number; seed?: MetricMetadata } = {},
) {
  const now = options.nowMs ?? Date.now(),
    max = options.maxTokens ?? 16;
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('Invalid metadata lookup limit');
  const result = { attempted: 0, resolved: 0, failed: 0, deferred: 0 };
  const cached = readCachedMetricMetadata(db, options.seed ?? empty);
  const unique = new Map<string, TokenMetadataTarget>();
  for (const target of targets) {
    const address = target.address.toLowerCase() as Address;
    if (
      !/^0x[0-9a-f]{40}$/.test(address) ||
      target.blockNumber < 0n ||
      target.blockNumber > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new RangeError('Invalid metadata target');
    // Native currency has no ERC20 contract to query.
    if (address === toHex(0, { size: 20 })) continue;
    const old = unique.get(address);
    if (!old || target.blockNumber < old.blockNumber)
      unique.set(address, { address, blockNumber: target.blockNumber });
  }
  const groups = new Map<bigint, TokenMetadataTarget[]>();
  const failures = new Map(
    (
      db.prepare('select address,next_retry_ms from token_metadata_failures').all() as {
        address: string;
        next_retry_ms: number;
      }[]
    ).map((r) => [r.address, r]),
  );
  // Never-attempted tokens first, then the oldest retry deadline: failures cannot monopolize a slow recorder.
  const fair = [...unique.values()].sort(
    (a, b) =>
      (failures.get(a.address)?.next_retry_ms ?? -1) -
      (failures.get(b.address)?.next_retry_ms ?? -1),
  );
  for (const target of fair) {
    if (decimalsAt(cached, target.address, target.blockNumber) !== null) continue;
    const failed = failures.get(target.address);
    if ((failed && failed.next_retry_ms > now) || result.attempted >= max) {
      result.deferred++;
      continue;
    }
    result.attempted++;
    groups.set(target.blockNumber, [...(groups.get(target.blockNumber) ?? []), target]);
  }
  const fail = (address: string, reason: string) => {
    db.prepare(
      'insert into token_metadata_failures(address,next_retry_ms,reason) values(?,?,?) on conflict(address) do update set next_retry_ms=excluded.next_retry_ms,reason=excluded.reason',
    ).run(address, now + 60000, reason);
    result.failed++;
  };
  for (const [height, group] of groups) {
    let before: BlockAnchor;
    try {
      before = await reader.getAnchor(height);
    } catch (error) {
      critical(error);
      for (const target of group) fail(target.address, classifyRpcError(error).kind);
      continue;
    }
    const successes: { address: Address; decimals: number }[] = [];
    for (const target of group) {
      try {
        const raw = await reader.request('eth_call', [
          { to: target.address, data: '0x313ce567' },
          toHex(height),
        ]);
        if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw) || BigInt(raw) > 255n)
          throw new RpcFailure('invalid-decimals');
        successes.push({ address: target.address, decimals: Number(BigInt(raw)) });
      } catch (error) {
        critical(error);
        fail(target.address, classifyRpcError(error).kind);
      }
    }
    if (!successes.length) continue;
    let after: BlockAnchor;
    try {
      after = await reader.getAnchor(height);
    } catch (error) {
      critical(error);
      for (const token of successes) fail(token.address, classifyRpcError(error).kind);
      continue;
    }
    if (
      before.number !== height ||
      after.number !== height ||
      before.hash.toLowerCase() !== after.hash.toLowerCase()
    ) {
      for (const token of successes) fail(token.address, 'metadata-anchor-changed');
      continue;
    }
    db.transaction(() => {
      for (const token of successes) {
        db.prepare(
          'insert into token_metadata(address,decimals,block_number,block_hash) values(?,?,?,?) on conflict(address,block_number) do update set decimals=excluded.decimals,block_hash=excluded.block_hash',
        ).run(token.address, token.decimals, Number(height), after.hash.toLowerCase());
        db.prepare('delete from token_metadata_failures where address=?').run(token.address);
        result.resolved++;
      }
    })();
  }
  return result;
}
