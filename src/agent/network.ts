export interface FetchTimeoutHandle {
  signal: AbortSignal;
  dispose: () => void;
}

export function resolveFetchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const rawValue = env.PI_FETCH_TIMEOUT_MS?.trim();
  if (!rawValue) {
    return 10_000;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0 || Math.floor(parsedValue) <= 0) {
    throw new Error("Invalid PI_FETCH_TIMEOUT_MS value.");
  }

  return Math.floor(parsedValue);
}

export function withRequestTimeout(timeoutMs: number): FetchTimeoutHandle {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    dispose: () => globalThis.clearTimeout(timeoutId)
  };
}

export function getBearerHeaders(apiKey: string): Headers {
  return new Headers({
    Authorization: `Bearer ${apiKey}`
  });
}

export async function parseJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    await cancelResponseBody(response);
    throw new Error("Expected JSON content-type.");
  }

  try {
    return await response.json();
  } catch (error) {
    await cancelResponseBody(response);
    throw new Error("Failed to parse JSON response.");
  }
}

export async function cancelResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* Preserve the original request failure. */ }
}

export async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("Invalid response byte limit.");
  const tooLarge = () => new Error(`Response exceeds the ${maxBytes} byte limit.`);
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await cancelResponseBody(response);
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw tooLarge();
      chunks.push(chunk.value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    try { await reader.cancel(); } catch { /* Keep the read/limit error. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function getResponseStatusError(response: Response, context: string): Error {
  const statusText = response.statusText?.trim();
  const suffix = statusText ? ` ${statusText}` : "";
  return new Error(`${context} failed with HTTP ${response.status}${suffix}.`);
}
