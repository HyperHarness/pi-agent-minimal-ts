import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeishuApiError, sendReplyWithRetry } from '../../src/feishu-bridge/feishu/reply-sender.js';

test('parseFeishuApiError includes HTTP status and Feishu business code', () => {
  const info = parseFeishuApiError({
    message: 'Request failed with status code 400',
    response: {
      status: 400,
      data: {
        code: 230049,
        msg: 'The message is being sent.',
      },
    },
  });

  assert.equal(info.statusCode, 400);
  assert.equal(info.code, 230049);
  assert.equal(info.msg, 'The message is being sent.');
  assert.match(info.summary, /HTTP 400/);
  assert.match(info.summary, /230049/);
});

test('sendReplyWithRetry retries the same reply request once for transient Feishu 230049 errors', async () => {
  const payloads: Array<{ data: { uuid?: string } }> = [];
  let attempt = 0;

  const result = await sendReplyWithRetry({
    messageId: 'om_source',
    msgType: 'text',
    content: JSON.stringify({ text: 'hello' }),
    reply: async (payload) => {
      payloads.push(payload);
      attempt += 1;
      if (attempt === 1) {
        throw {
          message: 'Request failed with status code 400',
          response: {
            status: 400,
            data: {
              code: 230049,
              msg: 'The message is being sent.',
            },
          },
        };
      }
      return {
        data: {
          message_id: 'om_reply_1',
        },
      };
    },
  });

  assert.equal(result.messageId, 'om_reply_1');
  assert.equal(result.fallbackToCreate, false);
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].data.uuid, payloads[1].data.uuid);
});

test('sendReplyWithRetry asks caller to fallback for permanent parameter errors', async () => {
  const result = await sendReplyWithRetry({
    messageId: 'om_source',
    msgType: 'text',
    content: JSON.stringify({ text: 'hello' }),
    reply: async () => {
      throw {
        message: 'Request failed with status code 400',
        response: {
          status: 400,
          data: {
            code: 230001,
            msg: 'Your request contains an invalid request parameter.',
          },
        },
      };
    },
  });

  assert.equal(result.messageId, undefined);
  assert.equal(result.fallbackToCreate, true);
  assert.match(result.detail || '', /230001/);
});
