import test from 'node:test';
import assert from 'node:assert/strict';
import { splitLongTextForFeishu } from '../../src/feishu-bridge/feishu/long-message.js';

function stripChunkLabels(chunks: string[]): string {
  return chunks.map((chunk) => chunk.replace(/^\(\d+\/\d+\)\n/, '')).join('\n');
}

test('splitLongTextForFeishu returns short text unchanged', () => {
  assert.deepEqual(splitLongTextForFeishu(' hello ', 20), ['hello']);
});

test('splitLongTextForFeishu splits long text and labels each chunk', () => {
  const text = ['alpha', 'beta', 'gamma', 'delta'].join('\n');
  const chunks = splitLongTextForFeishu(text, 18);

  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks, ['(1/2)\nalpha\nbeta', '(2/2)\ngamma\ndelta']);
  assert.equal(stripChunkLabels(chunks), text);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 18);
  }
});

test('splitLongTextForFeishu splits a single oversized line', () => {
  const text = 'abcdefghijklmnop';
  const chunks = splitLongTextForFeishu(text, 12);

  assert.deepEqual(chunks, ['(1/3)\nabcdef', '(2/3)\nghijkl', '(3/3)\nmnop']);
  assert.equal(chunks.map((chunk) => chunk.replace(/^\(\d+\/\d+\)\n/, '')).join(''), text);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 12);
  }
});
