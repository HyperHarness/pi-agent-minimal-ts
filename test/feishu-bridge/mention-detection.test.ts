import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBotMention } from '../../src/feishu-bridge/feishu/mention-detection.js';

test('detectBotMention returns true when mention open_id matches bot open_id', () => {
  assert.equal(
    detectBotMention(
      {
        message: {
          mentions: [{ id: { open_id: 'ou_bot' }, name: '物理之神' }],
        },
      },
      '随便什么文本',
      { botOpenId: 'ou_bot', botAliases: ['物理之神'] },
    ),
    true,
  );
});

test('detectBotMention returns false when only other users are mentioned', () => {
  assert.equal(
    detectBotMention(
      {
        message: {
          mentions: [{ id: { open_id: 'ou_other' }, name: '张三' }],
        },
      },
      '@张三 你看一下这个问题',
      { botOpenId: 'ou_bot', botAliases: ['物理之神'] },
    ),
    false,
  );
});

test('detectBotMention trusts Feishu mentioned_type bot even when open_id differs', () => {
  assert.equal(
    detectBotMention(
      {
        message: {
          mentions: [
            {
              id: { open_id: 'ou_event_bot_open_id' },
              key: '@_user_1',
              mentioned_type: 'bot',
              name: '物理之神',
            },
          ],
        },
      },
      '@物理之神 帮我看一下',
      { botOpenId: 'ou_configured_open_id', botAliases: ['物理之神'] },
    ),
    true,
  );
});

test('detectBotMention can fall back to alias matching when mention ids are unavailable', () => {
  assert.equal(
    detectBotMention(
      {
        message: {
          mentions: [{ name: '物理之神' }],
        },
      },
      '@物理之神 帮我看一下',
      { botAliases: ['物理之神'] },
    ),
    true,
  );
});
