import type { Address, Hex } from 'viem';
import { countWork } from '../ops/work-counters.js';
import { poolRegistrationId, type PoolRegistration } from '../registry/pools.js';
import type { PreparedRegistry, RegistryView } from '../storage/registry-cache.js';
import {
  buildOperationShardFilters,
  lower,
  type OperationShard,
  type PlannedFilter,
  type ProtocolDeployments,
} from './filter-plan.js';

/** One round's requests, plus the settlement that decides whether its discoveries stay. */
export interface OperationFilterLease {
  plan(fromBlock: bigint, toBlock: bigint): readonly PlannedFilter[];
  /** Keep this round's discoveries: they are committed, so the next round still plans them. */
  publish(): void;
  /** Drop this round's discoveries: the batch they came from will not be accepted. */
  discard(): void;
}

/**
 * One pool identity in the index. The key is the value a request carries — a pool address for V3,
 * a pool id for V4 — and the registration id it came from, so a journal row naming that
 * registration can be resolved without reading anything else.
 */
type Member =
  | { readonly id: string; readonly protocol: 'v3'; readonly value: Address }
  | { readonly id: string; readonly protocol: 'v4'; readonly value: Hex };

function memberOf(registration: PoolRegistration): Member {
  const pool = registration.pool;
  return pool.protocol === 'v3'
    ? { id: poolRegistrationId(registration), protocol: 'v3', value: lower(pool.address) }
    : { id: poolRegistrationId(registration), protocol: 'v4', value: lower(pool.poolId) };
}

/**
 * The pool values every operation request is built from, held sorted and split into request-sized
 * shards for as long as the registry behind them does not move.
 *
 * A round with no registry change re-reads nothing: the shards are already sorted, already split,
 * and only the block bounds around them are new. A registry change touches one protocol's index,
 * and a changed pool is resolved by the identity the journal named — so a change costs its own
 * rows rather than a catalogue sweep, and is counted as the catalogue change it is.
 *
 * The index is a cache, never an authority: every value it holds came from a view it was prepared
 * with, or from a registration that view already carried, and a pool the registry drops leaves the
 * plan on the round that replays the change.
 */
export class OperationFilterIndex {
  /** The deployments these templates belong to; a range planned with them must match. */
  readonly deployments: ProtocolDeployments;
  /** The value limit every template was split to; a range planned with them must match. */
  readonly maxFilterValues: number;
  /** Pool identity -> member, and registration id -> member. One identity is one member. */
  readonly #members = new Map<string, Member>();
  readonly #held = new Map<string, Member>();
  #v3: readonly OperationShard[] = [];
  #v4: readonly OperationShard[] = [];
  #scopeKey: string | null = null;
  #revisionKey: string | null = null;
  #stale = { v3: true, v4: true };
  #lease: OperationFilterLease | null = null;

  constructor(deployments: ProtocolDeployments, maxFilterValues: number) {
    if (!Number.isSafeInteger(maxFilterValues) || maxFilterValues <= 0)
      throw new RangeError('maxFilterValues must be a positive safe integer');
    this.deployments = {
      v3Factory: lower(deployments.v3Factory),
      v4Manager: lower(deployments.v4Manager),
    };
    this.maxFilterValues = maxFilterValues;
  }

  /**
   * Take the registry context one round will be planned and decoded against, with the discoveries
   * that round staged. The outstanding lease of the previous round — if its batch never settled —
   * is dropped first: an unsettled batch commits nothing, so its discoveries never become members.
   */
  prepare(prepared: PreparedRegistry, staged: readonly PoolRegistration[]): OperationFilterLease {
    this.#lease?.discard();
    const view = prepared.view;
    if (this.#scopeKey !== prepared.scopeKey) this.#adopt(view, prepared.scopeKey);
    else if (this.#revisionKey !== view.revisionKey) {
      this.#applyChanged(view, prepared.changedPoolIds);
      this.#revisionKey = view.revisionKey;
    }
    // A pool discovered and swapped in the same block has to be planned by the batch that found
    // it, so the staged identities are members from the moment this round starts. They outlive it
    // only if the batch that staged them is committed.
    const staged0 = staged.map((registration) => {
      const member = memberOf(registration);
      return { member, held: this.#held.has(member.id) };
    });
    for (const entry of staged0) this.#remember(entry.member);
    let settled = false;
    const settle = (committed: boolean): void => {
      if (settled) return;
      settled = true;
      for (const entry of staged0) {
        if (committed) {
          // The rows are committed; the members stay, and the protocol they moved is re-derived
          // from the membership it now has on the next round rather than from a catalogue read.
          this.#stale[entry.member.protocol] = true;
        } else if (!entry.held) {
          this.#forget(entry.member.id);
        }
      }
      if (this.#lease === lease) this.#lease = null;
    };
    const lease: OperationFilterLease = {
      plan: (fromBlock, toBlock) => this.plan(fromBlock, toBlock),
      publish: () => settle(true),
      discard: () => settle(false),
    };
    this.#lease = lease;
    return lease;
  }

  /** Keep the outstanding round's discoveries. Safe to call when no round is outstanding. */
  publish(): void {
    this.#lease?.publish();
  }

  /** Drop the outstanding round's discoveries. Safe to call when no round is outstanding. */
  discard(): void {
    this.#lease?.discard();
  }

  /** The plan for one range, from the shards currently held. */
  plan(fromBlock: bigint, toBlock: bigint): readonly PlannedFilter[] {
    if (this.#stale.v3) this.#rebuild('v3');
    if (this.#stale.v4) this.#rebuild('v4');
    return [...this.#v3, ...this.#v4].map((shard) => ({
      id: shard.family,
      family: shard.family,
      filter: {
        fromBlock,
        toBlock,
        address: shard.filter.address,
        topics: shard.filter.topics,
      },
    }));
  }

  /** Take a whole catalogue as the new base: the one path where every pool is read. */
  #adopt(view: RegistryView, scopeKey: string): void {
    this.#members.clear();
    this.#held.clear();
    for (const registration of view.all()) this.#remember(memberOf(registration));
    this.#scopeKey = scopeKey;
    this.#revisionKey = view.revisionKey;
    this.#stale = { v3: true, v4: true };
  }

  #applyChanged(view: RegistryView, changed: ReadonlySet<string>): void {
    for (const id of changed) {
      const registration = view.get(id);
      if (registration === undefined) this.#forget(id);
      else this.#remember(memberOf(registration));
    }
  }

  #remember(member: Member): void {
    if (this.#held.has(member.id)) return;
    this.#held.set(member.id, member);
    this.#members.set(member.value, member);
    this.#stale[member.protocol] = true;
  }

  #forget(id: string): void {
    const previous = this.#held.get(id);
    if (previous === undefined) return;
    this.#held.delete(id);
    this.#members.delete(previous.value);
    this.#stale[previous.protocol] = true;
  }

  /**
   * Re-derive one protocol's shards from the members it currently has. The protocol's own values
   * are the only ones scanned, and a round that moved nothing scans nothing at all.
   */
  #rebuild(protocol: 'v3' | 'v4'): void {
    const addresses: Address[] = [];
    const poolIds: Hex[] = [];
    for (const member of this.#members.values()) {
      if (member.protocol === 'v3') addresses.push(member.value);
      else poolIds.push(member.value);
    }
    addresses.sort();
    poolIds.sort();
    const moved = protocol === 'v3' ? addresses.length : poolIds.length;
    countWork('operationFilterRebuilds');
    countWork('operationFilterValuesScanned', moved);
    const shards = buildOperationShardFilters(
      {
        v3Addresses: protocol === 'v3' ? addresses : [],
        v4PoolIds: protocol === 'v3' ? [] : poolIds,
      },
      this.deployments,
      this.maxFilterValues,
    );
    if (protocol === 'v3') {
      this.#v3 = shards;
      this.#stale.v3 = false;
    } else {
      this.#v4 = shards;
      this.#stale.v4 = false;
    }
  }
}
