import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildErrorCardContent,
  buildStreamingCardContent,
  buildThinkingCardContent,
  buildStatusCardContent,
} from '../../src/feishu-bridge/feishu/card-builder.js';

test('buildThinkingCardContent puts phase detail into title and removes asker/status lines', () => {
  const raw = buildThinkingCardContent('Alice', '已收到，正在思考…');
  const card = JSON.parse(raw);
  const serialized = JSON.stringify(card);

  assert.equal(card.config.update_multi, true);
  assert.equal(card.header.title.content, '正在理解问题并整理上下文');
  assert.doesNotMatch(serialized, /提问者：/);
  assert.doesNotMatch(serialized, /Alice/);
  assert.doesNotMatch(serialized, /\*\*状态\*\*/);
  assert.doesNotMatch(serialized, /思考中/);
  assert.match(serialized, /已收到，正在思考/);
});

test('buildStreamingCardContent embeds markdown body and removes asker/status lines', () => {
  const raw = buildStreamingCardContent({
    senderName: 'Bob',
    answer: '第一行\n第二行',
    isFinal: true,
  });
  const card = JSON.parse(raw);
  const serialized = JSON.stringify(card);

  assert.equal(card.config.update_multi, true);
  assert.equal(card.header.title.content, '回答生成完成');
  assert.doesNotMatch(serialized, /提问者：/);
  assert.doesNotMatch(serialized, /Bob/);
  assert.doesNotMatch(serialized, /\*\*状态\*\*/);
  assert.doesNotMatch(serialized, /已完成/);
  assert.match(serialized, /第一行/);
  assert.match(serialized, /第二行/);
});

test('buildStatusCardContent puts status detail into title and removes asker/status lines', () => {
  const raw = buildStatusCardContent({
    senderName: '王五',
    status: '联网搜索中',
    detail: '正在检索最新网页信息…',
    statusColor: 'blue',
  });
  const card = JSON.parse(raw);
  const serialized = JSON.stringify(card);

  assert.equal(card.header.title.content, '正在检索最新网页信息…');
  assert.match(serialized, /正在检索最新网页信息/);
  assert.doesNotMatch(serialized, /提问者：/);
  assert.doesNotMatch(serialized, /王五/);
  assert.doesNotMatch(serialized, /\*\*状态\*\*/);
  assert.doesNotMatch(serialized, /联网搜索中/);
});

test('buildErrorCardContent shows failure title and message without status line', () => {
  const raw = buildErrorCardContent('网络错误');
  const card = JSON.parse(raw);
  const serialized = JSON.stringify(card);

  assert.equal(card.config.update_multi, true);
  assert.equal(card.header.title.content, '处理请求时发生异常');
  assert.doesNotMatch(serialized, /\*\*状态\*\*/);
  assert.doesNotMatch(serialized, /出错/);
  assert.match(serialized, /网络错误/);
});
