import test from 'node:test';
import assert from 'node:assert/strict';
import { PiClientPool } from '../../src/feishu-bridge/pi-client-pool.js';
import type { PiRpcClient } from '../../src/feishu-bridge/pi-client.js';
import { getPiClientKey } from '../../src/feishu-bridge/pi-session.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function makeFakeClient(
  id: string,
  onStop: (id: string) => void,
  promptImpl?: (message: string) => Promise<string>,
): PiRpcClient {
  return {
    isProcessReady: () => true,
    start: async () => {},
    stop: () => {
      onStop(id);
    },
    prompt: promptImpl ?? (async () => `reply:${id}`),
  } as unknown as PiRpcClient;
}

test('getOrCreate coalesces concurrent startups for the same key into a single client', async () => {
  let createCount = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const pool = new PiClientPool({ idleTtlMs: 1000, maxClients: 5 });
  const createAndStart = async (): Promise<PiRpcClient> => {
    createCount += 1;
    await gate;
    return makeFakeClient('shared', () => {});
  };

  const first = pool.getOrCreate('stateless', createAndStart);
  const second = pool.getOrCreate('stateless', createAndStart);
  release!();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(createCount, 1);
  assert.equal(a, b);
  assert.equal(pool.get('stateless'), a);
});

test('runPrompt serializes concurrent prompts for the same key without throwing', async () => {
  const order: string[] = [];
  const deferreds: Array<() => void> = [];
  const pool = new PiClientPool({ idleTtlMs: 1000, maxClients: 5 });

  const client = {
    isProcessReady: () => true,
    start: async () => {},
    stop: () => {},
    prompt: async (message: string) => {
      order.push(`start:${message}`);
      await new Promise<void>((resolve) => deferreds.push(resolve));
      order.push(`end:${message}`);
      return `reply:${message}`;
    },
  } as unknown as PiRpcClient;

  await pool.getOrCreate('stateless', async () => client);

  const first = pool.runPrompt('stateless', client, 'one');
  const second = pool.runPrompt('stateless', client, 'two');

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ['start:one']);

  deferreds.shift()!();
  assert.equal(await first, 'reply:one');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ['start:one', 'end:one', 'start:two']);

  deferreds.shift()!();
  assert.equal(await second, 'reply:two');
});

test('evictIdle stops clients idle beyond the TTL but keeps busy clients', async () => {
  let now = 0;
  const stopped: string[] = [];
  const pool = new PiClientPool({ idleTtlMs: 100, maxClients: 10, now: () => now });

  const a = await pool.getOrCreate('a', async () => makeFakeClient('a', (id) => stopped.push(id)));

  let releaseB: (() => void) | undefined;
  const bGate = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  const b = await pool.getOrCreate('b', async () =>
    makeFakeClient('b', (id) => stopped.push(id), async () => {
      await bGate;
      return 'reply:b';
    }),
  );

  const busy = pool.runPrompt('b', b, 'hello');
  now += 150;
  pool.evictIdle();

  assert.equal(pool.get('a'), undefined);
  assert.deepEqual(stopped, ['a']);
  assert.equal(pool.get('b'), b);

  releaseB!();
  assert.equal(await busy, 'reply:b');
});

test('getOrCreate evicts the least-recently-used idle client when at maxClients', async () => {
  let now = 0;
  const stopped: string[] = [];
  const pool = new PiClientPool({ idleTtlMs: 10_000, maxClients: 2, now: () => now });

  const a = await pool.getOrCreate('a', async () => makeFakeClient('a', (id) => stopped.push(id)));
  now += 1;
  const b = await pool.getOrCreate('b', async () => makeFakeClient('b', (id) => stopped.push(id)));
  now += 1;
  const c = await pool.getOrCreate('c', async () => makeFakeClient('c', (id) => stopped.push(id)));

  assert.equal(pool.size, 2);
  assert.equal(pool.get('a'), undefined);
  assert.equal(pool.get('b'), b);
  assert.equal(pool.get('c'), c);
  assert.deepEqual(stopped, ['a']);
});

test('getOrCreate keeps busy clients and evicts only idle clients when at maxClients', async () => {
  let now = 0;
  const stopped: string[] = [];
  const pool = new PiClientPool({ idleTtlMs: 10_000, maxClients: 2, now: () => now });

  let releaseA: (() => void) | undefined;
  const aGate = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const a = await pool.getOrCreate('a', async () =>
    makeFakeClient('a', (id) => stopped.push(id), async () => {
      await aGate;
      return 'reply:a';
    }),
  );
  now += 1;
  const b = await pool.getOrCreate('b', async () => makeFakeClient('b', (id) => stopped.push(id)));
  const busyA = pool.runPrompt('a', a, 'hello');
  now += 1;
  const c = await pool.getOrCreate('c', async () => makeFakeClient('c', (id) => stopped.push(id)));

  assert.equal(pool.size, 2);
  assert.equal(pool.get('a'), a);
  assert.equal(pool.get('b'), undefined);
  assert.equal(pool.get('c'), c);
  assert.deepEqual(stopped, ['b']);

  releaseA!();
  assert.equal(await busyA, 'reply:a');
});

test('shutdown stops registered clients and any client that finishes starting late', async () => {
  const stopped: string[] = [];
  let releaseStart: (() => void) | undefined;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });

  const pool = new PiClientPool({ idleTtlMs: 1000, maxClients: 5 });
  await pool.getOrCreate('ready', async () => makeFakeClient('ready', (id) => stopped.push(id)));

  const pending = pool.getOrCreate('late', async () => {
    await startGate;
    return makeFakeClient('late', (id) => stopped.push(id));
  });

  const shutdownPromise = pool.shutdown();
  releaseStart!();
  await shutdownPromise;

  assert.deepEqual(stopped.sort(), ['late', 'ready']);
  await assert.rejects(pending, /已关闭/);
  await assert.rejects(
    pool.getOrCreate('after', async () => makeFakeClient('after', (id) => stopped.push(id))),
    /已关闭/,
  );
});

test('remove forgets a client so a later getOrCreate starts a fresh one', async () => {
  const stopped: string[] = [];
  const pool = new PiClientPool({ idleTtlMs: 1000, maxClients: 5 });

  const first = await pool.getOrCreate('k', async () => makeFakeClient('k', (id) => stopped.push(id)));
  pool.remove('k');

  assert.equal(pool.get('k'), undefined);
  const second = await pool.getOrCreate('k', async () => makeFakeClient('k2', (id) => stopped.push(id)));
  assert.notEqual(second, first);
});

test('capacity includes concurrent startups and waits while every client is leased', async () => {
  const pool = new PiClientPool({ idleTtlMs: 1000, maxClients: 2 });
  const gates = [deferred<void>(), deferred<void>()];
  const stopped: string[] = [];
  let starts = 0;
  const first = pool.acquire('one', async () => { starts++; await gates[0].promise; return makeFakeClient('one', id => stopped.push(id)); });
  const second = pool.acquire('two', async () => { starts++; await gates[1].promise; return makeFakeClient('two', id => stopped.push(id)); });
  const third = pool.acquire('three', async () => { starts++; return makeFakeClient('three', id => stopped.push(id)); });
  await tick();
  assert.equal(starts, 2);
  gates[0].resolve(); gates[1].resolve();
  const [a, b] = await Promise.all([first, second]);
  await tick();
  assert.equal(starts, 2);
  assert.equal(pool.size, 2);
  a.release();
  const c = await third;
  assert.equal(starts, 3);
  assert.equal(pool.size, 2);
  assert.deepEqual(stopped, ['one']);
  b.release(); c.release();
  await pool.shutdown();
});

test('a lease protects the client before and between prompts until the entire request finishes', async () => {
  let now = 0;
  const stopped: string[] = [];
  const pool = new PiClientPool({ idleTtlMs: 10, maxClients: 1, now: () => now });
  const a = await pool.acquire('a', async () => makeFakeClient('a', id => stopped.push(id)));
  now = 100;
  pool.evictIdle();
  assert.equal(pool.get('a'), a.client);
  assert.equal(await pool.runPrompt('a', a.client, 'first'), 'reply:a');
  let startedB = false;
  const pending = pool.acquire('b', async () => { startedB = true; return makeFakeClient('b', id => stopped.push(id)); });
  await tick();
  assert.equal(startedB, false);
  assert.equal(await pool.runPrompt('a', a.client, 'second'), 'reply:a');
  a.release(); a.release();
  const b = await pending;
  assert.deepEqual(stopped, ['a']);
  now += 100;
  pool.evictIdle();
  assert.equal(pool.get('b'), b.client);
  b.release();
  await pool.shutdown();
});

test('shutdown rejects capacity waiters without starting their factories', async () => {
  const pool = new PiClientPool({ idleTtlMs: 1000, maxClients: 1 });
  const a = await pool.acquire('a', async () => makeFakeClient('a', () => {}));
  let created = false;
  const pending = pool.acquire('b', async () => { created = true; return makeFakeClient('b', () => {}); });
  const rejected = assert.rejects(pending, /已关闭/);
  await pool.shutdown();
  await rejected;
  assert.equal(created, false);
  a.release();
});

test('a synchronously failed factory releases its startup slot for a retry', async () => {
  const pool = new PiClientPool({ idleTtlMs: 1000, maxClients: 1 });
  await assert.rejects(pool.acquire('a', () => { throw new Error('spawn failed'); }), /spawn failed/);
  const lease = await pool.acquire('a', async () => makeFakeClient('a', () => {}));
  lease.release();
  await pool.shutdown();
});

test('stateless chats use distinct clients so one prompt does not block or receive the other chat output', async () => {
  const pool = new PiClientPool({ idleTtlMs: 1000, maxClients: 2 });
  const firstGate = deferred<void>();
  const options = { command: 'pi', useSession: false };
  const aKey = getPiClientKey(options, 'chat-a');
  const bKey = getPiClientKey(options, 'chat-b');
  const a = await pool.acquire(aKey, async () => makeFakeClient('a', () => {}, async () => { await firstGate.promise; return 'a-only'; }));
  const b = await pool.acquire(bKey, async () => makeFakeClient('b', () => {}, async () => 'b-only'));
  const first = pool.runPrompt(aKey, a.client, 'a');
  assert.equal(await pool.runPrompt(bKey, b.client, 'b'), 'b-only');
  firstGate.resolve();
  assert.equal(await first, 'a-only');
  a.release(); b.release();
  await pool.shutdown();
});
