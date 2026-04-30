import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDurableGroupFacts, extractDurableUserFacts } from '../../src/feishu-bridge/memory/extractors.js';

test('extractDurableUserFacts captures stable naming and preference phrases', () => {
  const facts = extractDurableUserFacts('我叫牛顿，以后请叫我物理之神，我偏好简洁回答。');

  assert.ok(facts.includes('我叫牛顿'));
  assert.ok(facts.includes('请叫我物理之神'));
  assert.ok(facts.includes('我偏好简洁回答'));
});

test('extractDurableGroupFacts captures project conventions and group facts', () => {
  const facts = extractDurableGroupFacts('这个群主要讨论物理创业，我们项目代号北极星，默认使用 TypeScript，统一走灰度发布。');

  assert.ok(facts.includes('这个群主要讨论物理创业'));
  assert.ok(facts.includes('项目代号北极星'));
  assert.ok(facts.includes('默认使用 TypeScript'));
  assert.ok(facts.includes('统一走灰度发布'));
});
