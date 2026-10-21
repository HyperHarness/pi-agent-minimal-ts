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

test('a rejected task keeps the queue alive and drains remaining tasks', async () => {
  const queue = createPerKeyQueue();
  const order: string[] = [];

  queue.enqueue('chat-a', async () => {
    order.push('a1-start');
    throw new Error('boom');
  });
  queue.enqueue('chat-a', async () => {
    order.push('a2');
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(order, ['a1-start', 'a2']);
});

test('a rejected task is reported to the error observer with its key', async () => {
  const errors: unknown[] = [];
  const keys: string[] = [];
  const queue = createPerKeyQueue({
    onError: (error, key) => {
      errors.push(error);
      keys.push(key);
    },
  });
  const order: string[] = [];

  queue.enqueue('chat-a', async () => {
    throw new Error('boom');
  });
  queue.enqueue('chat-a', async () => {
    order.push('a2');
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof Error);
  assert.equal((errors[0] as Error).message, 'boom');
  assert.deepEqual(keys, ['chat-a']);
  assert.deepEqual(order, ['a2']);
});

test('a throwing error observer does not break the queue', async () => {
  const queue = createPerKeyQueue({
    onError: () => {
      throw new Error('observer-throw');
    },
  });
  const order: string[] = [];

  queue.enqueue('chat-a', async () => {
    throw new Error('boom');
  });
  queue.enqueue('chat-a', async () => {
    order.push('a2');
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(order, ['a2']);
});

test('a rejecting async error observer does not break the queue', async () => {
  const queue = createPerKeyQueue({
    onError: async () => {
      throw new Error('observer-reject');
    },
  });
  const order: string[] = [];

  queue.enqueue('chat-a', async () => {
    throw new Error('boom');
  });
  queue.enqueue('chat-a', async () => {
    order.push('a2');
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(order, ['a2']);
});
