import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  backupPathFor,
  loadJsonStore,
  readJsonFile,
  writeJsonFileAtomic,
  type JsonStoreOptions,
} from '../../src/feishu-bridge/memory/atomic-json.js';
import { ChatMemoryStore } from '../../src/feishu-bridge/memory/chat-memory.js';
import { LongTermMemoryStore } from '../../src/feishu-bridge/memory/long-term-memory.js';
import { KeyMemoryStore } from '../../src/feishu-bridge/memory/key-memory.js';

interface SimpleChatFile {
  chats: Record<string, Array<{ role: string; text: string; timestamp: string }>>;
}

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-atomic-json-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function isSimpleChatFile(value: unknown): value is SimpleChatFile {
  if (typeof value !== 'object' || value === null || typeof (value as SimpleChatFile).chats !== 'object' || (value as SimpleChatFile).chats === null || Array.isArray((value as SimpleChatFile).chats)) {
    return false;
  }
  return Object.values((value as SimpleChatFile).chats).every((turns) => Array.isArray(turns));
}

const simpleChatOptions: JsonStoreOptions<SimpleChatFile> = {
  defaultValue: () => ({ chats: {} }),
  isValid: isSimpleChatFile,
  label: 'chat memory',
};

function captureConsoleError<T>(run: () => T): { result: T; logs: string[] } {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    return { result: run(), logs };
  } finally {
    console.error = original;
  }
}

function findQuarantine(dir: string, baseName: string): string | null {
  const match = fs.readdirSync(dir).find((entry) => entry.startsWith(`${baseName}.corrupt-`));
  return match === undefined ? null : path.join(dir, match);
}

/** Simulates a crash halfway through the old in-place writeFileSync. */
function truncateInHalf(content: string): string {
  return content.slice(0, Math.max(1, Math.floor(content.length / 2)));
}

test('atomic write persists readable JSON with the legacy formatting and leaves no temporary files', () => {
  const dir = makeTempDir();
  const target = path.join(dir, 'chats.json');
  const value: SimpleChatFile = { chats: { 'chat-1': [{ role: 'user', text: 'hello', timestamp: '2026-04-14T00:00:00Z' }] } };

  writeJsonFileAtomic(target, value);

  assert.equal(fs.readFileSync(target, 'utf-8'), JSON.stringify(value, null, 2));
  assert.deepEqual(fs.readdirSync(dir), ['chats.json']);
  const read = readJsonFile<SimpleChatFile>(target);
  assert.equal(read.status, 'ok');
  assert.deepEqual(read.value, value);
});

test('each atomic write rotates the previous good content into a last-good backup', () => {
  const dir = makeTempDir();
  const target = path.join(dir, 'long-term.json');
  const first = { users: { 'user-1': [] }, groups: {} };
  const second = { users: { 'user-1': ['fact'] }, groups: {} };

  writeJsonFileAtomic(target, first);
  writeJsonFileAtomic(target, second);

  assert.equal(fs.readFileSync(target, 'utf-8'), JSON.stringify(second, null, 2));
  assert.equal(fs.readFileSync(backupPathFor(target), 'utf-8'), JSON.stringify(first, null, 2));
});

test('failed backup replacement preserves the current store and removes owned temporary files', () => {
  const dir = makeTempDir();
  const target = path.join(dir, 'chats.json');
  writeJsonFileAtomic(target, { chats: { first: [] } });
  fs.mkdirSync(backupPathFor(target));
  assert.throws(() => writeJsonFileAtomic(target, { chats: {} }));
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { chats: { first: [] } });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['chats.json', 'chats.json.bak']);
});

test('a save refuses to overwrite corruption introduced after the store was loaded', () => {
  const dir = makeTempDir();
  const store = new ChatMemoryStore(dir, 10);
  const target = path.join(dir, 'chats.json');
  fs.writeFileSync(target, '{damaged');
  assert.throws(() => store.appendTurn('chat', { role: 'user', text: 'new', timestamp: 'now' }));
  assert.equal(fs.readFileSync(target, 'utf8'), '{damaged');
  assert.deepEqual(fs.readdirSync(dir), ['chats.json']);
});

test('invalid memory shape introduced after load cannot replace the last good backup', () => {
  const dir = makeTempDir();
  const store = new ChatMemoryStore(dir, 10);
  store.appendTurn('chat', { role: 'user', text: 'one', timestamp: 'now' });
  store.appendTurn('chat', { role: 'user', text: 'two', timestamp: 'now' });
  const target = path.join(dir, 'chats.json');
  const goodBackup = fs.readFileSync(backupPathFor(target), 'utf8');
  fs.writeFileSync(target, '{"chats":42}');
  assert.throws(() => store.appendTurn('chat', { role: 'user', text: 'three', timestamp: 'now' }), /invalid memory/);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"chats":42}');
  assert.equal(fs.readFileSync(backupPathFor(target), 'utf8'), goodBackup);
});

test('readJsonFile distinguishes a missing file from corruption and read failures', () => {
  const dir = makeTempDir();

  const missing = readJsonFile(path.join(dir, 'missing.json'));
  assert.equal(missing.status, 'missing');
  assert.equal(missing.value, undefined);

  const corruptPath = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corruptPath, '{ "chats": { "chat-1": [ { "role": "user"', 'utf-8');
  const corrupt = readJsonFile<SimpleChatFile>(corruptPath);
  assert.equal(corrupt.status, 'corrupt');
  assert.ok(corrupt.error instanceof Error);

  // a read failure that is not ENOENT (parent path is a file) must not look like "missing"
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory', 'utf-8');
  assert.throws(() => readJsonFile(path.join(blocker, 'nested.json')), { code: 'ENOTDIR' });
  assert.throws(() => loadJsonStore(path.join(blocker, 'nested.json'), simpleChatOptions), { code: 'ENOTDIR' });
});

test('a failed atomic write rethrows and cleans up its temporary file', () => {
  const dir = makeTempDir();
  const target = path.join(dir, 'key-memory.json');
  writeJsonFileAtomic(target, { chats: {} });

  fs.rmSync(target);
  fs.mkdirSync(target); // the destination can no longer be replaced by a file rename

  assert.throws(() => writeJsonFileAtomic(target, { chats: { 'chat-1': [] } }));
  assert.ok(fs.statSync(target).isDirectory());
  assert.deepEqual(fs.readdirSync(dir), ['key-memory.json']);
});

test('loads ignore interrupted temporary files without deleting another writer temporary file', () => {
  const dir = makeTempDir();
  const target = path.join(dir, 'chats.json');
  const good: SimpleChatFile = { chats: { 'chat-1': [{ role: 'user', text: 'keep', timestamp: '2026-04-14T00:00:00Z' }] } };
  writeJsonFileAtomic(target, good);

  fs.writeFileSync(`${target}.tmp-1234-deadbeef`, '{"partial": tru', 'utf-8');
  fs.writeFileSync(`${target}.bak.tmp-1234-deadbeef`, '{"partial"', 'utf-8');

  const result = loadJsonStore(target, simpleChatOptions);

  assert.deepEqual(result.value, good);
  assert.equal(fs.existsSync(`${target}.tmp-1234-deadbeef`), true);
  assert.equal(fs.existsSync(`${target}.bak.tmp-1234-deadbeef`), true);
});

test('a corrupt file is quarantined, not overwritten, and the backup keeps serving loads', () => {
  const dir = makeTempDir();
  const target = path.join(dir, 'chats.json');
  const first: SimpleChatFile = { chats: { 'chat-1': [{ role: 'user', text: 'one', timestamp: '2026-04-14T00:00:01Z' }] } };
  const second: SimpleChatFile = { chats: { 'chat-1': [...first.chats['chat-1'], { role: 'user', text: 'two', timestamp: '2026-04-14T00:00:02Z' }] } };
  writeJsonFileAtomic(target, first);
  writeJsonFileAtomic(target, second);

  const truncated = truncateInHalf(fs.readFileSync(target, 'utf-8'));
  fs.writeFileSync(target, truncated, 'utf-8'); // crash mid-write of the old non-atomic writer

  const { result, logs } = captureConsoleError(() => loadJsonStore(target, simpleChatOptions));

  assert.equal(result.recoveredFromBackup, true);
  assert.deepEqual(result.value, first);
  assert.ok(logs.some((line) => line.includes('chats.json') && line.includes('corrupt')), 'corruption must be reported loudly');
  const quarantine = findQuarantine(dir, 'chats.json');
  assert.ok(quarantine, 'the corrupt original must be preserved');
  assert.equal(fs.readFileSync(quarantine, 'utf-8'), truncated);
  assert.equal(fs.existsSync(target), false, 'the corrupt file must not be replaced in place');

  const again = loadJsonStore(target, simpleChatOptions);
  assert.deepEqual(again.value, first);
  assert.equal(again.recoveredFromBackup, true);
});

test('a missing file quietly starts from the default value without any side effects', () => {
  const dir = makeTempDir();

  const { result, logs } = captureConsoleError(() => loadJsonStore(path.join(dir, 'chats.json'), simpleChatOptions));

  assert.deepEqual(result.value, { chats: {} });
  assert.equal(result.recoveredFromBackup, false);
  assert.deepEqual(logs, []);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('ChatMemoryStore recovers chat history from the last-good backup after a truncated write', () => {
  const dir = makeTempDir();
  const seed = new ChatMemoryStore(dir, 10);
  seed.appendTurn('chat-1', { role: 'user', text: '第一条', timestamp: '2026-04-14T00:00:01Z' });
  seed.appendTurn('chat-1', { role: 'user', text: '第二条', timestamp: '2026-04-14T00:00:02Z' });

  const filePath = path.join(dir, 'chats.json');
  const truncated = truncateInHalf(fs.readFileSync(filePath, 'utf-8'));
  fs.writeFileSync(filePath, truncated, 'utf-8');

  const { result, logs } = captureConsoleError(() => new ChatMemoryStore(dir, 10));
  assert.deepEqual(result.getTurns('chat-1').map((turn) => turn.text), ['第一条']);
  assert.ok(logs.some((line) => line.includes('chats.json') && line.includes('corrupt')));

  const quarantine = findQuarantine(dir, 'chats.json');
  assert.ok(quarantine, 'the truncated original must be preserved for manual recovery');
  assert.equal(fs.readFileSync(quarantine, 'utf-8'), truncated);

  result.appendTurn('chat-1', { role: 'user', text: '恢复后', timestamp: '2026-04-14T00:00:03Z' });
  assert.ok(fs.existsSync(quarantine), 'later saves must not destroy the quarantined original');
  const reloaded = new ChatMemoryStore(dir, 10);
  assert.deepEqual(reloaded.getTurns('chat-1').map((turn) => turn.text), ['第一条', '恢复后']);
});

test('LongTermMemoryStore refuses to silently wipe a corrupt long-term.json', () => {
  const dir = makeTempDir();
  const seed = new LongTermMemoryStore(dir);
  seed.upsertUserFact('user-1', '喜欢中文回答', 'preference');
  seed.upsertUserFact('user-1', '偏好简洁回答', 'preference');

  const filePath = path.join(dir, 'long-term.json');
  const truncated = truncateInHalf(fs.readFileSync(filePath, 'utf-8'));
  fs.writeFileSync(filePath, truncated, 'utf-8');

  const { result, logs } = captureConsoleError(() => new LongTermMemoryStore(dir));
  assert.deepEqual(result.getUserEntries('user-1').map((entry) => entry.text), ['喜欢中文回答']);
  assert.ok(logs.some((line) => line.includes('long-term.json') && line.includes('corrupt')));

  const quarantine = findQuarantine(dir, 'long-term.json');
  assert.ok(quarantine);
  assert.equal(fs.readFileSync(quarantine, 'utf-8'), truncated);
});

test('KeyMemoryStore starts empty on corruption without destroying the original file', () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, 'key-memory.json');
  const corruptBytes = '{ "chats": { "chat-1": [ { "text": "项目代号是 Polaris"';
  fs.writeFileSync(filePath, corruptBytes, 'utf-8');

  const { result, logs } = captureConsoleError(() => new KeyMemoryStore(dir, 10));
  assert.deepEqual(result.getEntries('chat-1'), []);
  assert.ok(logs.some((line) => line.includes('key-memory.json') && line.includes('corrupt')));

  const quarantine = findQuarantine(dir, 'key-memory.json');
  assert.ok(quarantine);
  assert.equal(fs.readFileSync(quarantine, 'utf-8'), corruptBytes);
  assert.equal(fs.existsSync(filePath), false, 'the corrupt file must not be replaced with an empty cache');

  result.upsert('chat-1', { text: '恢复后的记录', category: 'fact', priority: 50, updatedAt: '2026-04-14T00:00:00Z' });
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf-8')).chats['chat-1'].length, 1);
  assert.equal(fs.readFileSync(quarantine, 'utf-8'), corruptBytes);
});
