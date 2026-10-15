import test from 'node:test';
import assert from 'node:assert/strict';
import { createPerKeyQueue } from '../../dist/src/feishu-bridge/chat-queue.js';

test('a rejected queue task does not surface as an unhandledRejection and the queue keeps draining', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => {
    if (reason instanceof Error && reason.message === 'queue-boom') {
      unhandled.push(reason);
    }
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const queue = createPerKeyQueue();
    let ran = false;
    queue.enqueue('chat-a', async () => {
      throw new Error('queue-boom');
    });
    queue.enqueue('chat-a', async () => {
      ran = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(ran, true);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
