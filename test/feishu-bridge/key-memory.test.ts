import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractKeyMemoryCandidates, KeyMemoryStore } from '../../src/feishu-bridge/memory/key-memory.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-key-memory-'));
}

test('extractKeyMemoryCandidates keeps project conventions and decisions', () => {
  const items = extractKeyMemoryCandidates('我们项目默认使用 Python，数据库统一走 Postgres，截止日期是下周五。');
  const texts = items.map((item: { text: string }) => item.text).join('\n');

  assert.match(texts, /默认使用 Python/);
  assert.match(texts, /数据库统一走 Postgres/);
  assert.match(texts, /截止日期是下周五/);
});

test('key memory store deduplicates and renders highest-priority memories first', () => {
  const dir = makeTempDir();
  const store = new KeyMemoryStore(dir, 10);

  store.upsert('chat-1', { text: '项目代号是 Polaris', category: 'project', priority: 80, updatedAt: '2026-04-14T00:00:00Z' });
  store.upsert('chat-1', { text: '项目代号是 Polaris', category: 'project', priority: 80, updatedAt: '2026-04-14T00:00:01Z' });
  store.upsert('chat-1', { text: '截止日期是下周五', category: 'deadline', priority: 95, updatedAt: '2026-04-14T00:00:02Z' });

  const rendered = store.render('chat-1');
  const entries = store.getEntries('chat-1');

  assert.equal(entries.length, 2);
  assert.match(rendered, /截止日期是下周五/);
  assert.match(rendered, /项目代号是 Polaris/);
  assert.ok(rendered.indexOf('截止日期是下周五') < rendered.indexOf('项目代号是 Polaris'));
});

test('key memory store falls back to empty store when persisted file shape is invalid', () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'key-memory.json'), JSON.stringify({ chats: null }), 'utf-8');

  const store = new KeyMemoryStore(dir, 10);
  assert.deepEqual(store.getEntries('chat-1'), []);
  assert.equal(store.render('chat-1'), '(无)');
});
