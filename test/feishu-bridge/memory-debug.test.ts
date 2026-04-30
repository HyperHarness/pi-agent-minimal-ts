import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemoryDebugLines } from '../../src/feishu-bridge/memory/debug.js';
import type { ChatTurn, ParsedIncomingMessage } from '../../src/feishu-bridge/types.js';

const message: ParsedIncomingMessage = {
  chatId: 'oc_debug_chat',
  chatType: 'group',
  isDirectMessage: false,
  mentionsBot: true,
  messageId: 'om_debug_1',
  senderId: 'ou_debug_1',
  senderName: 'Newton',
  text: '你还记得我吗',
};

test('buildMemoryDebugLines shows session dir and memory hit summaries', () => {
  const history: ChatTurn[] = [
    { role: 'user', text: '我叫牛顿', timestamp: '2026-04-15T00:00:00Z' },
    { role: 'assistant', text: '收到', timestamp: '2026-04-15T00:00:01Z' },
  ];

  const lines = buildMemoryDebugLines({
    message,
    sessionDir: '.memory/pi-sessions/oc_debug_chat',
    history,
    userMemoryText: '用户长期记忆：\n- 我叫牛顿\n- 请叫我物理之神',
    groupMemoryText: '群长期记忆：\n- 这个群主要讨论物理创业',
    keyMemoryText: '- 项目代号北极星\n- 默认使用 TypeScript',
    webContext: '1. 搜索结果A\n2. 搜索结果B',
  });

  assert.match(lines.join('\n'), /session_dir=.memory\/pi-sessions\/oc_debug_chat/);
  assert.match(lines.join('\n'), /history_turns=2/);
  assert.match(lines.join('\n'), /user_memory_hits=2/);
  assert.match(lines.join('\n'), /group_memory_hits=1/);
  assert.match(lines.join('\n'), /key_memory_hits=2/);
  assert.match(lines.join('\n'), /web_hits=2/);
  assert.match(lines.join('\n'), /我叫牛顿/);
  assert.match(lines.join('\n'), /项目代号北极星/);
});

test('buildMemoryDebugLines handles empty memory sources', () => {
  const lines = buildMemoryDebugLines({
    message,
    sessionDir: undefined,
    history: [],
    userMemoryText: '(无)',
    groupMemoryText: '(无)',
    keyMemoryText: '(无)',
    webContext: '(无联网结果)',
  });

  assert.match(lines.join('\n'), /session_dir=stateless/);
  assert.match(lines.join('\n'), /history_turns=0/);
  assert.match(lines.join('\n'), /user_memory_hits=0/);
  assert.match(lines.join('\n'), /group_memory_hits=0/);
  assert.match(lines.join('\n'), /key_memory_hits=0/);
  assert.match(lines.join('\n'), /web_hits=0/);
});
