import test from 'node:test';
import assert from 'node:assert/strict';
import { startPiClientWithRetry } from '../../src/feishu-bridge/pi-client-retry.js';

test('startPiClientWithRetry retries startup and succeeds on a later attempt', async () => {
  const attempts: number[] = [];
  const stopped: number[] = [];

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
      stop() {
        stopped.push(attempts.length);
      },
    }),
  });

  assert.equal(attempts.length, 3);
  assert.deepEqual(stopped, [1, 2]);
  assert.equal(typeof result.getRecentStderrSummary, 'function');
  assert.equal(typeof result.stop, 'function');
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
        stop() {},
      }),
    }),
    /stderr摘要: stderr line 1 \| stderr line 2/,
  );
});

test('startPiClientWithRetry stops every failed client before retrying and after the final failure', async () => {
  const stopped: number[] = [];
  let attempt = 0;

  await assert.rejects(
    startPiClientWithRetry({
      maxAttempts: 3,
      createClient: () => {
        attempt += 1;
        const current = attempt;
        return {
          async start() {
            throw new Error(`fail-${current}`);
          },
          getRecentStderrSummary() {
            return `stderr-${current}`;
          },
          stop() {
            stopped.push(current);
          },
        };
      },
    }),
    (error: unknown) => {
      if (!(error instanceof Error)) {
        return false;
      }
      return /已重试 3 次/.test(error.message) && /stderr摘要: stderr-3/.test(error.message);
    },
  );

  assert.deepEqual(stopped, [1, 2, 3]);
});

test('startPiClientWithRetry preserves the startup error when stop cleanup fails', async () => {
  const stopped: number[] = [];
  let attempt = 0;

  await assert.rejects(
    startPiClientWithRetry({
      maxAttempts: 2,
      createClient: () => {
        attempt += 1;
        const current = attempt;
        return {
          async start() {
            throw new Error(`startup-fail-${current}`);
          },
          getRecentStderrSummary() {
            return '';
          },
          stop() {
            stopped.push(current);
            throw new Error('stop-fail');
          },
        };
      },
    }),
    /startup-fail-2/,
  );

  assert.deepEqual(stopped, [1, 2]);
});
