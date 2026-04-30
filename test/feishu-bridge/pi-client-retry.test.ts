import test from 'node:test';
import assert from 'node:assert/strict';
import { startPiClientWithRetry } from '../../src/feishu-bridge/pi-client-retry.js';

test('startPiClientWithRetry retries startup and succeeds on a later attempt', async () => {
  const attempts: number[] = [];

  const result = await startPiClientWithRetry({
    maxAttempts: 3,
    createClient: () => ({
      async start() {
        attempts.push(attempts.length + 1);
        if (attempts.length < 3) {
          throw new Error(`fail-${attempts.length}`);
        }
      },
      getRecentStderrSummary() {
        return '';
      },
    }),
  });

  assert.equal(attempts.length, 3);
  assert.equal(typeof result.getRecentStderrSummary, 'function');
});

test('startPiClientWithRetry includes recent stderr summary in the final error', async () => {
  await assert.rejects(
    startPiClientWithRetry({
      maxAttempts: 2,
      createClient: () => ({
        async start() {
          throw new Error('PI RPC 启动失败');
        },
        getRecentStderrSummary() {
          return 'stderr line 1 | stderr line 2';
        },
      }),
    }),
    /stderr摘要: stderr line 1 \| stderr line 2/,
  );
});
