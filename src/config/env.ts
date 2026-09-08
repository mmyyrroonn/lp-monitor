import { z } from 'zod';
export interface RuntimeEnv {
  httpRpcUrl: string;
  wsRpcUrl?: string;
  providerAlias: string;
  dataDir: string;
}
export class ConfigError extends Error {}
export function loadEnv(env: NodeJS.ProcessEnv): RuntimeEnv {
  function endpoint(key: string, protocols: string[], optional = false): string | undefined {
    const value = env[key]?.trim();
    if (!value && optional) return undefined;
    try {
      if (!value || !protocols.includes(new URL(value).protocol)) throw new Error();
      return value;
    } catch {
      throw new ConfigError(`Invalid or missing ${key}`);
    }
  }
  const httpRpcUrl = endpoint('RH_RPC_HTTP', ['http:', 'https:'])!;
  // Reserved for optional future capability validation; P0 uses HTTP only.
  const wsRpcUrl = endpoint('RH_RPC_WS', ['ws:', 'wss:'], true);
  const alias = z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .safeParse(env.RH_PROVIDER_ALIAS || 'configured-rpc');
  if (!alias.success) throw new ConfigError('Invalid RH_PROVIDER_ALIAS');
  return { httpRpcUrl, wsRpcUrl, providerAlias: alias.data, dataDir: env.LP_DATA_DIR || 'data' };
}
