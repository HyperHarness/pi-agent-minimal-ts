import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSenderName } from '../../src/feishu-bridge/feishu/sender-name.js';

test('resolveSenderName prefers sender_name from event payload', async () => {
  const result = await resolveSenderName(
    {
      sender: {
        sender_name: '张三',
        sender_id: { open_id: 'ou_1' },
      },
    },
    async () => '不会被调用',
  );

  assert.equal(result, '张三');
});

test('resolveSenderName falls back to contact lookup when event name is missing', async () => {
  const result = await resolveSenderName(
    {
      sender: {
        sender_id: { open_id: 'ou_2' },
      },
    },
    async (openId: string) => {
      assert.equal(openId, 'ou_2');
      return '李四';
    },
  );

  assert.equal(result, '李四');
});

test('resolveSenderName falls back to open_id when lookup fails', async () => {
  const result = await resolveSenderName(
    {
      sender: {
        sender_id: { open_id: 'ou_3' },
      },
    },
    async () => undefined,
  );

  assert.equal(result, 'ou_3');
});
