import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPerKeyQueue } from '../../src/feishu-bridge/chat-queue.js';

test('per-key queue preserves order within a key but allows different keys to start independently', async () => {
  const events = new EventEmitter();
  const queue = createPerKeyQueue();
  const order: string[] = [];

  queue.enqueue('chat-a', async () => {
    order.push('a1-start');
    await new Promise<void>((resolve) => events.once('release-a1', () => resolve()));
    order.push('a1-end');
  });

  queue.enqueue('chat-a', async () => {
    order.push('a2-start');
    order.push('a2-end');
  });

  queue.enqueue('chat-b', async () => {
    order.push('b1-start');
    order.push('b1-end');
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(order, ['a1-start', 'b1-start', 'b1-end']);

  events.emit('release-a1');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(order, ['a1-start', 'b1-start', 'b1-end', 'a1-end', 'a2-start', 'a2-end']);
});
