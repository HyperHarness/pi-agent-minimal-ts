import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentPrompt,
  extractTextContent,
  shouldRespondToMessage,
  shouldStoreAsPassiveMemory,
  stripBotMention,
} from '../../src/feishu-bridge/feishu/message-utils.js';
import type { ChatTurn, ParsedIncomingMessage } from '../../src/feishu-bridge/types.js';

const baseMessage: ParsedIncomingMessage = {
  chatId: 'oc_group_1',
  chatType: 'group',
  isDirectMessage: false,
  mentionsBot: true,
  messageId: 'om_1',
  senderId: 'ou_user_1',
  senderName: 'Alice',
  text: 'hello bridge',
};

test('extractTextContent returns text from Feishu JSON payload', () => {
  assert.equal(extractTextContent('{"text":"你好，飞书"}'), '你好，飞书');
});

test('extractTextContent falls back to raw content when JSON parse fails', () => {
  assert.equal(extractTextContent('plain body'), 'plain body');
});

test('stripBotMention removes configured bot aliases from the beginning', () => {
  assert.equal(stripBotMention('@Hermes 帮我总结一下', ['Hermes']), '帮我总结一下');
  assert.equal(stripBotMention('  @Hermes\n请继续', ['Hermes']), '请继续');
});

test('shouldRespondToMessage requires mentions in groups when enabled', () => {
  assert.equal(
    shouldRespondToMessage(
      { ...baseMessage, mentionsBot: false },
      { allowedChatIds: [], requireMentionInGroups: true },
    ),
    false,
  );
});

test('shouldRespondToMessage allows private chats without mention', () => {
  assert.equal(
    shouldRespondToMessage(
      { ...baseMessage, chatType: 'p2p', isDirectMessage: true, mentionsBot: false },
      { allowedChatIds: [], requireMentionInGroups: true },
    ),
    true,
  );
});

test('shouldRespondToMessage respects allowed chat list', () => {
  assert.equal(
    shouldRespondToMessage(baseMessage, { allowedChatIds: ['oc_other'], requireMentionInGroups: true }),
    false,
  );
});

test('shouldStoreAsPassiveMemory stores non-mention group messages when enabled', () => {
  assert.equal(
    shouldStoreAsPassiveMemory(
      { ...baseMessage, mentionsBot: false },
      { allowedChatIds: [], requireMentionInGroups: true, learnFromAllGroupMessages: true },
    ),
    true,
  );
});

test('shouldStoreAsPassiveMemory ignores direct messages and @ messages', () => {
  assert.equal(
    shouldStoreAsPassiveMemory(
      { ...baseMessage, isDirectMessage: true, chatType: 'p2p', mentionsBot: false },
      { allowedChatIds: [], requireMentionInGroups: true, learnFromAllGroupMessages: true },
    ),
    false,
  );
  assert.equal(
    shouldStoreAsPassiveMemory(baseMessage, {
      allowedChatIds: [],
      requireMentionInGroups: true,
      learnFromAllGroupMessages: true,
    }),
    false,
  );
});

test('buildAgentPrompt includes memory and current question', () => {
  const history: ChatTurn[] = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `消息-${index + 1}`,
    timestamp: `2026-04-14T10:00:${String(index).padStart(2, '0')}.000Z`,
  }));

  const prompt = buildAgentPrompt(baseMessage, history, '请给出简洁回答', {
    userMemory: '用户长期偏好：喜欢中文、简洁输出',
    groupMemory: '群记忆：这是一个芯片设计讨论群',
    keyMemory: '关键信息：项目代号是 Polaris；截止日期是下周五',
    webContext: '联网搜索结果：1. OpenAI 发布了 GPT-5.4；2. 官方文档更新于今天',
    maxRecentTurns: 10,
  });

  assert.match(prompt, /Alice/);
  assert.doesNotMatch(prompt, /用户: 消息-1\n/);
  assert.doesNotMatch(prompt, /助手: 消息-2\n/);
  assert.match(prompt, /用户: 消息-3/);
  assert.match(prompt, /助手: 消息-12/);
  assert.match(prompt, /请给出简洁回答/);
  assert.match(prompt, /用户长期偏好：喜欢中文、简洁输出/);
  assert.match(prompt, /群记忆：这是一个芯片设计讨论群/);
  assert.match(prompt, /关键信息：项目代号是 Polaris；截止日期是下周五/);
  assert.match(prompt, /联网搜索结果：1. OpenAI 发布了 GPT-5.4；2. 官方文档更新于今天/);
  assert.match(prompt, /当前用户消息：hello bridge/);
});
