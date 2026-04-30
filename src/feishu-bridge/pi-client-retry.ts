import { PiRpcClient } from './pi-client.js';

export interface StartPiClientWithRetryOptions {
  maxAttempts: number;
  createClient: () => Pick<PiRpcClient, 'start' | 'getRecentStderrSummary'>;
}

export async function startPiClientWithRetry(
  options: StartPiClientWithRetryOptions,
): Promise<Pick<PiRpcClient, 'start' | 'getRecentStderrSummary'>> {
  let lastError: unknown;
  let lastSummary = '';

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const client = options.createClient();
    try {
      await client.start();
      return client;
    } catch (error) {
      lastError = error;
      lastSummary = client.getRecentStderrSummary();
    }
  }

  const message = [
    `PI 客户端启动失败，已重试 ${options.maxAttempts} 次`,
    lastError instanceof Error ? lastError.message : String(lastError),
    lastSummary ? `stderr摘要: ${lastSummary}` : '',
  ]
    .filter(Boolean)
    .join('；');

  throw new Error(message);
}
