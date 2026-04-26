import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

const PROXY_ENV_NAMES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;

export interface EnvProxyConfig {
  enabled: boolean;
  proxyUrl?: string;
}

export function getEnvProxyUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of PROXY_ENV_NAMES) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function configureEnvProxy(env: NodeJS.ProcessEnv = process.env): EnvProxyConfig {
  if (env.PI_AGENT_DISABLE_ENV_PROXY === "1") {
    return { enabled: false };
  }

  const proxyUrl = getEnvProxyUrl(env);
  if (!proxyUrl) {
    return { enabled: false };
  }

  setGlobalDispatcher(new EnvHttpProxyAgent());
  return { enabled: true, proxyUrl };
}
