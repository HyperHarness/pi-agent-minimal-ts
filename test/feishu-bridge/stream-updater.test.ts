import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { StreamUpdater } from '../../src/feishu-bridge/feishu/stream-updater.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('stream updates written during a pending patch are sent on the next flush', { timeout: 1000 }, async () => {
  const started = deferred();
  const release = deferred();
  const latestSent = deferred();
  const sent: string[] = [];
  const updater = new StreamUpdater({ enabled: true, intervalMs: 1, maxMessageLength: 100, patchMessage: async (text) => {
    sent.push(text);
    if (sent.length === 1) { started.resolve(); await release.promise; }
    else latestSent.resolve();
  } });
  updater.push('old');
  await started.promise;
  updater.push('new');
  release.resolve();
  await latestSent.promise;
  await updater.complete('new');
  assert.deepEqual(sent.slice(0, 2), ['old', 'new']);
});

test('complete waits for the old patch and sends the final text last', { timeout: 1000 }, async () => {
  const started = deferred();
  const release = deferred();
  const sent: string[] = [];
  let active = 0;
  const updater = new StreamUpdater({ enabled: true, intervalMs: 1, maxMessageLength: 100, patchMessage: async (text) => {
    assert.equal(++active, 1);
    sent.push(text);
    if (text === 'old') { started.resolve(); await release.promise; }
    active--;
  } });
  updater.push('old');
  await started.promise;
  let completed = false;
  const completion = updater.complete('final').then(() => { completed = true; });
  await setImmediate();
  assert.equal(completed, false);
  release.resolve();
  await completion;
  updater.push('late stale delta');
  await setImmediate();
  assert.deepEqual(sent, ['old', 'final']);
});

test('a timer patch rejection is handled and completion retries the unsent text', { timeout: 1000 }, async () => {
  const attempted = deferred();
  let attempts = 0;
  const updater = new StreamUpdater({ enabled: true, intervalMs: 1, maxMessageLength: 100, patchMessage: async () => {
    attempts++;
    if (attempts === 1) { attempted.resolve(); throw new Error('temporary patch failure'); }
  } });
  updater.push('answer');
  await attempted.promise;
  await updater.complete('answer');
  assert.equal(attempts, 2);
});

test('completion reports a final patch failure and disabled streaming still sends the final answer', async () => {
  const sent: string[] = [];
  const updater = new StreamUpdater({ enabled: false, intervalMs: 1, maxMessageLength: 100, patchMessage: async (text) => {
    sent.push(text);
    throw new Error('final patch failed');
  } });
  updater.push('intermediate');
  await assert.rejects(updater.complete('final'), /final patch failed/);
  assert.deepEqual(sent, ['final']);
});
