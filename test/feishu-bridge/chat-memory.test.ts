import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatMemoryStore } from '../../src/feishu-bridge/memory/chat-memory.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-memory-'));
}

test('chat memory persists turns and trims to max history', () => {
  const dir = makeTempDir();
  const store = new ChatMemoryStore(dir, 3);

  store.appendTurn('chat-1', { role: 'user', text: '1', timestamp: '2026-04-14T00:00:01Z' });
  store.appendTurn('chat-1', { role: 'assistant', text: '2', timestamp: '2026-04-14T00:00:02Z' });
  store.appendTurn('chat-1', { role: 'user', text: '3', timestamp: '2026-04-14T00:00:03Z' });
  store.appendTurn('chat-1', { role: 'assistant', text: '4', timestamp: '2026-04-14T00:00:04Z' });

  const turns = store.getTurns('chat-1');
  assert.deepEqual(turns.map((turn) => turn.text), ['2', '3', '4']);
});

test('chat memory isolates chats', () => {
  const dir = makeTempDir();
  const store = new ChatMemoryStore(dir, 5);

  store.appendTurn('chat-a', { role: 'user', text: 'hello a', timestamp: '2026-04-14T00:00:01Z' });
  store.appendTurn('chat-b', { role: 'user', text: 'hello b', timestamp: '2026-04-14T00:00:02Z' });

  assert.equal(store.getTurns('chat-a').length, 1);
  assert.equal(store.getTurns('chat-b').length, 1);
  assert.equal(store.getTurns('chat-a')[0].text, 'hello a');
});

test('chat memory renders only user messages by default for prompt injection', () => {
  const dir = makeTempDir();
  const store = new ChatMemoryStore(dir, 5);

  store.appendTurn('chat-1', {
    role: 'user',
    text: '第一问',
    timestamp: '2026-04-14T00:00:01Z',
    senderId: 'ou_alice',
    senderName: 'Alice',
  });
  store.appendTurn('chat-1', { role: 'assistant', text: '第一答', timestamp: '2026-04-14T00:00:02Z' });

  const summary = store.renderHistory('chat-1');
  assert.match(summary, /Alice: 第一问/);
  assert.doesNotMatch(summary, /助手: 第一答/);
});

test('chat memory can render assistant messages when explicitly enabled', () => {
  const dir = makeTempDir();
  const store = new ChatMemoryStore(dir, 5);

  store.appendTurn('chat-1', {
    role: 'user',
    text: '第一问',
    timestamp: '2026-04-14T00:00:01Z',
    senderId: 'ou_alice',
    senderName: 'Alice',
  });
  store.appendTurn('chat-1', { role: 'assistant', text: '第一答', timestamp: '2026-04-14T00:00:02Z' });

  const summary = store.renderHistory('chat-1', { includeAgentMessages: true });
  assert.match(summary, /Alice: 第一问/);
  assert.match(summary, /助手: 第一答/);
});

test('chat memory falls back to empty store when persisted file shape is invalid', () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'chats.json'), JSON.stringify({ chats: [] }), 'utf-8');

  const store = new ChatMemoryStore(dir, 5);
  assert.deepEqual(store.getTurns('chat-1'), []);
  assert.equal(store.renderHistory('chat-1'), '(无历史上下文)');
});
