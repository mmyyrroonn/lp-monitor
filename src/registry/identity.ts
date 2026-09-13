import { CHAIN_ID } from '../domain/chain.js';
import { parseRpcQuantity } from '../rpc/quantity.js';
import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import type { ChainConfig } from '../config/chain.js';
import type { BlockAnchor } from '../domain/types.js';
import { v3FactoryAbi, v3PoolAbi } from '../protocols/uniswap-v3/abi.js';
import type { EvidenceReader } from '../rpc/client.js';
import { classifyRpcError, RpcFailure } from '../rpc/errors.js';

export type IdentityStatus = 'verified' | 'unverified';
export type ContractIdentity = {
  address: Address;
  required: boolean;
  status: IdentityStatus;
  codeHash: Hex | null;
  reason?: string;
};
export type TokenIdentity = ContractIdentity & { decimals: number | null };
export type V3PoolIdentity = ContractIdentity & {
  factory: Address | null;
  token0: Address | null;
  token1: Address | null;
  fee: number | null;
};
export type DeploymentIdentity = {
  address: Address;
  status: IdentityStatus;
  firstCodeBlock: bigint | null;
  candidateBlock: bigint;
  candidateChecked: boolean;
  reason?: string;
};
export type IdentityReport = {
  status: IdentityStatus;
  requiredPassed: boolean;
  currentIdentityStatus: IdentityStatus;
  anchor: BlockAnchor;
  chainId: {
    expected: typeof CHAIN_ID;
    observed: number | null;
    status: IdentityStatus;
    reason?: string;
  };
  contracts: {
    v3Factory: ContractIdentity;
    v4Manager: ContractIdentity;
    stateView: ContractIdentity;
  };
  tokens: { AMC: TokenIdentity; USDG: TokenIdentity };
  v3Pools: V3PoolIdentity[];
  stateViewPoolManager: {
    required: false;
    status: IdentityStatus;
    observed: Address | null;
    reason?: string;
  };
  deployments: { v3Factory: DeploymentIdentity; v4Manager: DeploymentIdentity };
  rpcCallsUsed: number;
};

const stateViewAbi = parseAbi(['function poolManager() view returns (address)']);
const emptyCode = (value: unknown): value is Hex =>
  typeof value === 'string' && /^0x(?:00)*$/i.test(value);
const safeRpcReason = (error: unknown): string => {
  const failure = classifyRpcError(error);
  // Exhaustion is incomplete data, never an unsupported identity or history result.
  // optional-budget-reserved remains a reportable optional deployment outcome.
  if (failure.kind === 'budget' || failure.evidenceFailure) throw failure;
  return failure.message;
};
const normalizedAddress = (address: Address) => address.toLowerCase() as Address;

function validHex(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(value))
    throw new Error('malformed bytecode response');
  return value as Hex;
}

async function codeAt(
  reader: EvidenceReader,
  address: Address,
  block: bigint,
): Promise<Hex | null> {
  const result = await reader.request('eth_getCode', [address, toHex(block)]);
  if (emptyCode(result)) return null;
  return validHex(result);
}

async function callAt<T>(
  reader: EvidenceReader,
  address: Address,
  block: bigint,
  abi: readonly unknown[],
  functionName: string,
  args?: readonly unknown[],
): Promise<T> {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const result = await reader.request('eth_call', [{ to: address, data }, toHex(block)]);
  if (typeof result !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(result))
    throw new Error('malformed eth_call response');
  return decodeFunctionResult({ abi, functionName, data: result as Hex } as never) as T;
}

async function inspectContract(
  reader: EvidenceReader,
  address: Address,
  block: bigint,
  required: boolean,
): Promise<ContractIdentity> {
  try {
    const code = await codeAt(reader, address, block);
    return code
      ? { address, required, status: 'verified', codeHash: keccak256(code) }
      : {
          address,
          required,
          status: 'unverified',
          codeHash: null,
          reason: 'no code at verification anchor',
        };
  } catch (error) {
    return {
      address,
      required,
      status: 'unverified',
      codeHash: null,
      reason: safeRpcReason(error),
    };
  }
}

async function inspectToken(
  reader: EvidenceReader,
  address: Address,
  block: bigint,
): Promise<TokenIdentity> {
  const contract = await inspectContract(reader, address, block, true);
  if (contract.status !== 'verified') return { ...contract, decimals: null };
  try {
    const decimals = await callAt<number>(reader, address, block, erc20Abi, 'decimals');
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)
      throw new Error('invalid token decimals');
    return { ...contract, decimals };
  } catch (error) {
    return { ...contract, status: 'unverified', decimals: null, reason: safeRpcReason(error) };
  }
}

async function inspectV3Pool(
  reader: EvidenceReader,
  config: ChainConfig,
  address: Address,
  block: bigint,
): Promise<V3PoolIdentity> {
  const contract = await inspectContract(reader, address, block, true);
  const base = { ...contract, factory: null, token0: null, token1: null, fee: null };
  if (contract.status !== 'verified') return base;
  try {
    const factory = normalizedAddress(
      await callAt<Address>(reader, address, block, v3PoolAbi, 'factory'),
    );
    const token0 = normalizedAddress(
      await callAt<Address>(reader, address, block, v3PoolAbi, 'token0'),
    );
    const token1 = normalizedAddress(
      await callAt<Address>(reader, address, block, v3PoolAbi, 'token1'),
    );
    const fee = await callAt<number>(reader, address, block, v3PoolAbi, 'fee');
    const registered = normalizedAddress(
      await callAt<Address>(reader, config.v3Factory, block, v3FactoryAbi, 'getPool', [
        token0,
        token1,
        fee,
      ]),
    );
    const consistent =
      isAddressEqual(factory, config.v3Factory) &&
      isAddressEqual(token0, config.tokens.AMC) &&
      isAddressEqual(token1, config.tokens.USDG) &&
      isAddressEqual(registered, address);
    return consistent
      ? { ...contract, factory, token0, token1, fee }
      : {
          ...contract,
          factory,
          token0,
          token1,
          fee,
          status: 'unverified',
          reason: 'V3 factory, token pair, or factory.getPool mismatch',
        };
  } catch (error) {
    return { ...base, status: 'unverified', reason: safeRpcReason(error) };
  }
}

async function findDeployment(
  reader: EvidenceReader,
  address: Address,
  anchorBlock: bigint,
  candidateBlock: bigint,
): Promise<DeploymentIdentity> {
  let candidateChecked = false;
  // Per-search historical cache: never retained across verification runs or reorg checks.
  const codeCache = new Map<bigint, Hex | null>();
  const deploymentCodeAt = async (block: bigint) => {
    // createChainReader permits at most two retries. Leave room for all attempts plus
    // the mandatory final getAnchor call, since deployment history is optional.
    if (codeCache.has(block)) return codeCache.get(block)!;
    const remaining = reader.meter.remainingCalls;
    if (remaining !== null && remaining <= 3) throw new RpcFailure('optional-budget-reserved');
    const code = await codeAt(reader, address, block);
    codeCache.set(block, code);
    return code;
  };
  try {
    if (candidateBlock > anchorBlock)
      throw new Error('deployment candidate is after verification anchor');
    candidateChecked = true;
    const candidateCode = await deploymentCodeAt(candidateBlock);
    if (
      candidateCode &&
      (candidateBlock === 0n || !(await deploymentCodeAt(candidateBlock - 1n)))
    ) {
      return {
        address,
        status: 'verified',
        firstCodeBlock: candidateBlock,
        candidateBlock,
        candidateChecked,
      };
    }
    let low = candidateCode ? 0n : candidateBlock + 1n;
    let high = candidateCode ? candidateBlock - 1n : anchorBlock;
    if (low > high || !(await deploymentCodeAt(high)))
      throw new RpcFailure('deployment-boundary-missing', 'unsupported');
    while (low < high) {
      const middle = (low + high) / 2n;
      if (await deploymentCodeAt(middle)) high = middle;
      else low = middle + 1n;
    }
    if (!(await deploymentCodeAt(low)))
      throw new RpcFailure('deployment-boundary-missing', 'unsupported');
    if (low > 0n && (await deploymentCodeAt(low - 1n)))
      throw new RpcFailure('deployment-boundary-unproven');
    return { address, status: 'verified', firstCodeBlock: low, candidateBlock, candidateChecked };
  } catch (error) {
    return {
      address,
      status: 'unverified',
      firstCodeBlock: null,
      candidateBlock,
      candidateChecked,
      reason: safeRpcReason(error),
    };
  }
}

export async function verifyIdentity(
  reader: EvidenceReader,
  config: ChainConfig,
  anchor: BlockAnchor,
  options: { verifyDeployments?: boolean } = {},
): Promise<IdentityReport> {
  let observedChainId: number | null = null;
  let chainReason: string | undefined;
  try {
    const raw = await reader.request('eth_chainId', []);
    const parsed = parseRpcQuantity(raw);
    if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new RpcFailure('malformed-response');
    observedChainId = Number(parsed);
  } catch (error) {
    chainReason = safeRpcReason(error);
  }
  const chainId =
    observedChainId === CHAIN_ID
      ? { expected: CHAIN_ID, observed: observedChainId, status: 'verified' as const }
      : {
          expected: CHAIN_ID,
          observed: observedChainId,
          status: 'unverified' as const,
          reason: chainReason ?? `expected chain 4663, received ${observedChainId}`,
        };
  const blankContract = (address: Address, required: boolean): ContractIdentity => ({
    address,
    required,
    status: 'unverified',
    codeHash: null,
    reason: 'chain gate failed',
  });
  const candidateBlock = BigInt(config.deploymentCandidateBlock);
  if (chainId.status !== 'verified') {
    return {
      status: 'unverified',
      requiredPassed: false,
      currentIdentityStatus: 'unverified',
      anchor,
      chainId,
      contracts: {
        v3Factory: blankContract(config.v3Factory, true),
        v4Manager: blankContract(config.v4Manager, true),
        stateView: blankContract(config.stateView, false),
      },
      tokens: {
        AMC: { ...blankContract(config.tokens.AMC, true), decimals: null },
        USDG: { ...blankContract(config.tokens.USDG, true), decimals: null },
      },
      v3Pools: config.v3Pools.map((address) => ({
        ...blankContract(address, true),
        factory: null,
        token0: null,
        token1: null,
        fee: null,
      })),
      stateViewPoolManager: {
        required: false,
        status: 'unverified',
        observed: null,
        reason: 'chain gate failed',
      },
      deployments: {
        v3Factory: {
          address: config.v3Factory,
          status: 'unverified',
          firstCodeBlock: null,
          candidateBlock,
          candidateChecked: false,
          reason: 'chain gate failed',
        },
        v4Manager: {
          address: config.v4Manager,
          status: 'unverified',
          firstCodeBlock: null,
          candidateBlock,
          candidateChecked: false,
          reason: 'chain gate failed',
        },
      },
      rpcCallsUsed: reader.meter.summary().calls,
    };
  }

  const v3Factory = await inspectContract(reader, config.v3Factory, anchor.number, true);
  const v4Manager = await inspectContract(reader, config.v4Manager, anchor.number, true);
  const stateView = await inspectContract(reader, config.stateView, anchor.number, false);
  const AMC = await inspectToken(reader, config.tokens.AMC, anchor.number);
  const USDG = await inspectToken(reader, config.tokens.USDG, anchor.number);
  const v3Pools: V3PoolIdentity[] = [];
  for (const address of config.v3Pools)
    v3Pools.push(await inspectV3Pool(reader, config, address, anchor.number));

  let stateViewPoolManager: IdentityReport['stateViewPoolManager'] = {
    required: false,
    status: 'unverified',
    observed: null,
    reason: 'StateView has no code at anchor',
  };
  if (stateView.status === 'verified') {
    try {
      const observed = normalizedAddress(
        await callAt<Address>(reader, config.stateView, anchor.number, stateViewAbi, 'poolManager'),
      );
      stateViewPoolManager = isAddressEqual(observed, config.v4Manager)
        ? { required: false, status: 'verified', observed }
        : {
            required: false,
            status: 'unverified',
            observed,
            reason: 'StateView.poolManager mismatch',
          };
    } catch (error) {
      stateViewPoolManager = {
        required: false,
        status: 'unverified',
        observed: null,
        reason: safeRpcReason(error),
      };
    }
  }

  const currentRequired = [v3Factory, v4Manager, AMC, USDG, ...v3Pools];
  const currentIdentityStatus: IdentityStatus = currentRequired.every(
    (item) => item.status === 'verified',
  )
    ? 'verified'
    : 'unverified';
  const deployment = (address: Address): Promise<DeploymentIdentity> =>
    options.verifyDeployments === false
      ? Promise.resolve({
          address,
          status: 'unverified',
          firstCodeBlock: null,
          candidateBlock,
          candidateChecked: false,
          reason: 'skipped-live-start',
        })
      : findDeployment(reader, address, anchor.number, candidateBlock);
  const deploymentFactory = await deployment(config.v3Factory);
  const deploymentManager = await deployment(config.v4Manager);
  const status: IdentityStatus =
    currentIdentityStatus === 'verified' &&
    deploymentFactory.status === 'verified' &&
    deploymentManager.status === 'verified'
      ? 'verified'
      : 'unverified';
  let recheckedAnchor: BlockAnchor;
  try {
    recheckedAnchor = await reader.getAnchor(anchor.number);
  } catch (error) {
    const failure = classifyRpcError(error);
    if (failure.kind === 'budget' || failure.evidenceFailure) throw failure;
    throw new RpcFailure('anchor-recheck-failed');
  }
  if (
    recheckedAnchor.number !== anchor.number ||
    recheckedAnchor.hash.toLowerCase() !== anchor.hash.toLowerCase()
  ) {
    throw new RpcFailure('anchor-changed');
  }
  return {
    status,
    requiredPassed: currentIdentityStatus === 'verified',
    currentIdentityStatus,
    anchor,
    chainId,
    contracts: { v3Factory, v4Manager, stateView },
    tokens: { AMC, USDG },
    v3Pools,
    stateViewPoolManager,
    deployments: { v3Factory: deploymentFactory, v4Manager: deploymentManager },
    rpcCallsUsed: reader.meter.summary().calls,
  };
}
