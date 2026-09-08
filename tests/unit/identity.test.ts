import { expect, test } from 'vitest';
import {
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import configJson from '../../config/robinhood.json' with { type: 'json' };
import type { ChainConfig } from '../../src/config/chain.js';
import type { BlockAnchor } from '../../src/domain/types.js';
import { RequestMeter } from '../../src/ops/request-meter.js';
import { v3FactoryAbi, v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';
import type { EvidenceReader } from '../../src/rpc/client.js';
import { verifyIdentity } from '../../src/rpc/identity.js';

const config = configJson as ChainConfig;
const anchor: BlockAnchor = {
  number: 10_000n,
  hash: `0x${'ab'.repeat(32)}`,
  timestampSec: 1_788_500_000,
};
const stateViewAbi = parseAbi(['function poolManager() view returns (address)']);
const code = `0x${'60'.repeat(20)}` as Hex;

type FixtureOptions = {
  chainId?: number;
  deployedAt?: bigint;
  history?: 'available' | 'unsupported';
  stateViewCall?: 'available' | 'unsupported';
  poolFactory?: Address;
  changedAnchor?: boolean;
  maxCalls?: number;
};

function fixtureReader(options: FixtureOptions = {}): EvidenceReader {
  const meter = new RequestMeter(options.maxCalls ?? 150);
  const deployedAt = options.deployedAt ?? 9_070n;
  return {
    meter,
    sourceAlias: 'unit',
    async flush() {},
    async close() {},
    async getAnchor() {
      meter.begin('eth_getBlockByNumber', false);
      return options.changedAnchor ? { ...anchor, hash: `0x${'cd'.repeat(32)}` as Hex } : anchor;
    },
    async getLogs() {
      return [];
    },
    async request(method, params) {
      meter.begin(method, false);
      if (method === 'eth_chainId') return `0x${(options.chainId ?? 4663).toString(16)}`;
      if (method === 'eth_getCode') {
        const block = BigInt(params[1] as string);
        if (options.history === 'unsupported' && block !== anchor.number)
          throw new Error('historical state unavailable at https://provider.invalid/?key=secret');
        return block >= deployedAt ? code : '0x';
      }
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
      const call = params[0] as { to: Address; data: Hex };
      if (call.to.toLowerCase() === config.stateView.toLowerCase()) {
        if (options.stateViewCall === 'unsupported') throw new Error('method unavailable');
        return encodeFunctionResult({
          abi: stateViewAbi,
          functionName: 'poolManager',
          result: config.v4Manager,
        });
      }
      if (
        Object.values(config.tokens).some(
          (address) => address.toLowerCase() === call.to.toLowerCase(),
        )
      ) {
        return encodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', result: 18 });
      }
      if (call.to.toLowerCase() === config.v3Pools[0]!.toLowerCase()) {
        const decoded = decodeFunctionData({ abi: v3PoolAbi, data: call.data });
        if (decoded.functionName === 'factory')
          return encodeFunctionResult({
            abi: v3PoolAbi,
            functionName: 'factory',
            result: options.poolFactory ?? config.v3Factory,
          });
        if (decoded.functionName === 'token0')
          return encodeFunctionResult({
            abi: v3PoolAbi,
            functionName: 'token0',
            result: config.tokens.AMC,
          });
        if (decoded.functionName === 'token1')
          return encodeFunctionResult({
            abi: v3PoolAbi,
            functionName: 'token1',
            result: config.tokens.USDG,
          });
        if (decoded.functionName === 'fee')
          return encodeFunctionResult({ abi: v3PoolAbi, functionName: 'fee', result: 3_000 });
      }
      if (call.to.toLowerCase() === config.v3Factory.toLowerCase()) {
        return encodeFunctionResult({
          abi: v3FactoryAbi,
          functionName: 'getPool',
          result: config.v3Pools[0]!,
        });
      }
      throw new Error(`unexpected eth_call to ${call.to}`);
    },
  };
}

test('verifies fixed-anchor code and callable identities, then proves deployment block 9070', async () => {
  const report = await verifyIdentity(fixtureReader(), config, anchor);

  expect(report.currentIdentityStatus).toBe('verified');
  expect(report.status).toBe('verified');
  expect(report.requiredPassed).toBe(true);
  expect(report.contracts.v3Factory.codeHash).toBe(keccak256(code));
  expect(report.tokens.AMC.decimals).toBe(18);
  expect(report.v3Pools[0]).toMatchObject({
    factory: config.v3Factory,
    token0: config.tokens.AMC,
    token1: config.tokens.USDG,
    fee: 3_000,
    status: 'verified',
  });
  expect(report.deployments.v3Factory).toMatchObject({
    status: 'verified',
    firstCodeBlock: 9_070n,
    candidateChecked: true,
  });
  expect(report.deployments.v4Manager).toMatchObject({
    status: 'verified',
    firstCodeBlock: 9_070n,
    candidateChecked: true,
  });
  expect(report.rpcCallsUsed).toBeLessThanOrEqual(150);
});

test('fails the mandatory chain gate before contract identity calls', async () => {
  const reader = fixtureReader({ chainId: 1 });
  const report = await verifyIdentity(reader, config, anchor);

  expect(report.status).toBe('unverified');
  expect(report.requiredPassed).toBe(false);
  expect(report.currentIdentityStatus).toBe('unverified');
  expect(report.chainId).toMatchObject({ expected: 4663, observed: 1, status: 'unverified' });
  expect(reader.meter.summary().methods).toEqual({ eth_chainId: 1 });
});

test('keeps current identity distinct from unavailable historical deployment proof', async () => {
  const report = await verifyIdentity(fixtureReader({ history: 'unsupported' }), config, anchor);

  expect(report.currentIdentityStatus).toBe('verified');
  expect(report.status).toBe('unverified');
  expect(report.requiredPassed).toBe(true);
  expect(report.deployments.v3Factory).toMatchObject({
    status: 'unverified',
    firstCodeBlock: null,
    candidateChecked: true,
  });
  expect(report.deployments.v3Factory.reason).toBe('RPC historical-state-missing');
  expect(
    Object.values(report.deployments)
      .map(({ reason }) => reason)
      .join(' '),
  ).not.toContain('secret');
});

test('treats candidate 9070 as a hint and finds a later deployment', async () => {
  const report = await verifyIdentity(fixtureReader({ deployedAt: 9_500n }), config, anchor);

  expect(report.deployments.v3Factory).toMatchObject({
    status: 'verified',
    firstCodeBlock: 9_500n,
    candidateChecked: true,
  });
  expect(report.deployments.v4Manager).toMatchObject({
    status: 'verified',
    firstCodeBlock: 9_500n,
    candidateChecked: true,
  });
  expect(report.requiredPassed).toBe(true);
});

test('rejects evidence when the fixed anchor hash changes during verification', async () => {
  await expect(
    verifyIdentity(fixtureReader({ changedAnchor: true }), config, anchor),
  ).rejects.toThrow(/anchor/i);
});

test('reserves the final anchor call when optional deployment search reaches its budget', async () => {
  const reader = fixtureReader({ maxCalls: 17 });
  const report = await verifyIdentity(reader, config, anchor);

  expect(report.currentIdentityStatus).toBe('verified');
  expect(report.requiredPassed).toBe(true);
  expect(report.status).toBe('unverified');
  expect(report.deployments.v3Factory.reason).toBe('RPC optional-budget-reserved');
  expect(report.deployments.v4Manager.reason).toBe('RPC optional-budget-reserved');
  expect(reader.meter.summary()).toMatchObject({ calls: 16, maxCalls: 17 });
  expect(reader.meter.summary().methods.eth_getBlockByNumber).toBe(1);
});

test('treats StateView.poolManager as optional but records its failure', async () => {
  const report = await verifyIdentity(
    fixtureReader({ stateViewCall: 'unsupported' }),
    config,
    anchor,
  );

  expect(report.currentIdentityStatus).toBe('verified');
  expect(report.contracts.stateView.status).toBe('verified');
  expect(report.stateViewPoolManager).toMatchObject({
    status: 'unverified',
    required: false,
    observed: null,
  });
});

test('rejects a V3 pool whose own factory differs from the configured factory', async () => {
  const report = await verifyIdentity(
    fixtureReader({ poolFactory: '0x0000000000000000000000000000000000000001' }),
    config,
    anchor,
  );

  expect(report.currentIdentityStatus).toBe('unverified');
  expect(report.v3Pools[0]?.status).toBe('unverified');
  expect(report.v3Pools[0]?.reason).toMatch(/factory/i);
});

test('deployment bisection caches historical code reads within each search', async () => {
  const reader = fixtureReader({ deployedAt: 9050n });
  const request = reader.request.bind(reader);
  const historical = new Set<string>();
  reader.request = async (method, params) => {
    if (method === 'eth_getCode' && BigInt(params[1] as string) !== anchor.number) {
      const key = String(params[0]) + ':' + String(params[1]);
      expect(historical.has(key)).toBe(false);
      historical.add(key);
    }
    return request(method, params);
  };
  const report = await verifyIdentity(reader, config, anchor);
  expect(report.deployments.v3Factory.firstCodeBlock).toBe(9050n);
  expect(report.deployments.v4Manager.firstCodeBlock).toBe(9050n);
});
test.each([0, 1])('preserves exhausted mandatory identity budget %i', async (maxCalls) => {
  await expect(verifyIdentity(fixtureReader({ maxCalls }), config, anchor)).rejects.toMatchObject({
    kind: 'budget',
  });
});
test('preserves budget failure during mandatory final anchor recheck', async () => {
  const reader = fixtureReader();
  reader.getAnchor = async () => {
    const { RpcFailure } = await import('../../src/rpc/errors.js');
    throw new RpcFailure('budget');
  };
  await expect(verifyIdentity(reader, config, anchor)).rejects.toMatchObject({ kind: 'budget' });
});
