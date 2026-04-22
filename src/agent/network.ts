export interface FetchTimeoutHandle {
  signal: AbortSignal;
  clear: () => void;
}

export function resolveFetchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const rawValue = env.PI_FETCH_TIMEOUT_MS?.trim();
  if (!rawValue) {
    return 10_000;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return 10_000;
  }

  return Math.floor(parsedValue);
}

export function withRequestTimeout(timeoutMs: number): FetchTimeoutHandle {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    clear: () => globalThis.clearTimeout(timeoutId)
  };
}

export function getBearerHeaders(apiKey: string): Headers {
  return new Headers({
    Authorization: `Bearer ${apiKey}`
  });
}

export async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new Error("Failed to parse JSON response.");
  }
}

export function getResponseStatusError(response: Response, context: string): Error {
  const statusText = response.statusText?.trim();
  const suffix = statusText ? ` ${statusText}` : "";
  return new Error(`${context} failed with HTTP ${response.status}${suffix}.`);
}
