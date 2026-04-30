import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LongTermMemoryStore } from '../../src/feishu-bridge/memory/long-term-memory.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-long-memory-'));
}

test('long-term memory stores user and group entries separately', () => {
  const dir = makeTempDir();
  const store = new LongTermMemoryStore(dir);

  store.upsertUserFact('user-1', '喜欢中文回答', 'preference');
  store.upsertGroupFact('chat-1', '这个群主要讨论芯片设计', 'fact');

  const userSummary = store.renderUserMemory('user-1');
  const groupSummary = store.renderGroupMemory('chat-1');

  assert.match(userSummary, /喜欢中文回答/);
  assert.match(groupSummary, /芯片设计/);
  assert.doesNotMatch(userSummary, /芯片设计/);
});

test('long-term memory deduplicates identical entries', () => {
  const dir = makeTempDir();
  const store = new LongTermMemoryStore(dir);

  store.upsertUserFact('user-1', '偏好简洁回答', 'preference');
  store.upsertUserFact('user-1', '偏好简洁回答', 'preference');

  const entries = store.getUserEntries('user-1');
  assert.equal(entries.length, 1);
});

test('long-term memory persists to disk', () => {
  const dir = makeTempDir();
  const store = new LongTermMemoryStore(dir);
  store.upsertGroupFact('chat-2', '项目代号是 Polaris', 'fact');

  const reloaded = new LongTermMemoryStore(dir);
  assert.match(reloaded.renderGroupMemory('chat-2'), /Polaris/);
});

test('long-term memory falls back to empty store when persisted file shape is invalid', () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'long-term.json'), JSON.stringify({ users: [], groups: null }), 'utf-8');

  const store = new LongTermMemoryStore(dir);
  assert.equal(store.renderUserMemory('user-1'), '(无)');
  assert.equal(store.renderGroupMemory('chat-1'), '(无)');
});
