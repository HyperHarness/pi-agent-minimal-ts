import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAgentWebSearchQuery,
  normalizeSearchCacheKey,
  runAgentWithWebSearch,
} from '../../src/feishu-bridge/agent-web-search.js';

test('extractAgentWebSearchQuery recognizes exact web search requests', () => {
  assert.equal(extractAgentWebSearchQuery('[[WEB_SEARCH: 上海 明天天气]]'), '上海 明天天气');
  assert.equal(extractAgentWebSearchQuery('  [[WEB_SEARCH: OpenAI 最新模型 ]]  '), 'OpenAI 最新模型');
  assert.equal(extractAgentWebSearchQuery('先搜索一下'), null);
  assert.equal(extractAgentWebSearchQuery('[[WEB_SEARCH: 查询]]\n这是答案'), null);
});

test('normalizeSearchCacheKey collapses near-duplicate searches for cache reuse', () => {
  assert.equal(normalizeSearchCacheKey('上海天气'), normalizeSearchCacheKey('上海 今天天气'));
  assert.equal(normalizeSearchCacheKey('OpenAI 最新模型'), normalizeSearchCacheKey('OpenAI 的最新模型是什么'));
});

test('runAgentWithWebSearch lets the agent request additional search context before final answer', async () => {
  const prompts: string[] = [];
  const searchQueries: string[] = [];
  const agentResponses = ['[[WEB_SEARCH: 上海 明天天气]]', '明天上海多云，14~22℃，东南风3级。'];

  const result = await runAgentWithWebSearch({
    initialWebContext: '(无联网结果)',
    maxSearchSteps: 2,
    buildPrompt: (webContext) => `WEB_CONTEXT\n${webContext}`,
    promptAgent: async (prompt) => {
      prompts.push(prompt);
      const next = agentResponses.shift();
      if (!next) {
        throw new Error('no mock response');
      }
      return next;
    },
    search: async (query) => {
      searchQueries.push(query);
      return `1. weather.example\n摘要: 上海明天多云，14~22℃`;
    },
  });

  assert.equal(result.finalResponse, '明天上海多云，14~22℃，东南风3级。');
  assert.deepEqual(searchQueries, ['上海 明天天气']);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /如果你判断现有信息不足/);
  assert.match(prompts[1], /补充联网搜索结果#1/);
  assert.match(prompts[1], /上海\s*明天天气/);
});

test('runAgentWithWebSearch returns normal answers directly when no extra search is needed', async () => {
  const result = await runAgentWithWebSearch({
    initialWebContext: '(无联网结果)',
    maxSearchSteps: 7,
    buildPrompt: (webContext) => `CTX=${webContext}`,
    promptAgent: async () => '直接回答',
    search: async () => {
      throw new Error('should not search');
    },
  });

  assert.equal(result.finalResponse, '直接回答');
  assert.deepEqual(result.searchQueries, []);
});

test('runAgentWithWebSearch allows up to seven follow-up searches before hitting the limit', async () => {
  let promptCount = 0;
  const searchQueries: string[] = [];

  const result = await runAgentWithWebSearch({
    initialWebContext: '(无联网结果)',
    maxSearchSteps: 7,
    buildPrompt: (webContext) => `CTX=${webContext}`,
    promptAgent: async () => {
      promptCount += 1;
      return `[[WEB_SEARCH: 查询${promptCount}]]`;
    },
    search: async (query) => {
      searchQueries.push(query);
      return `result for ${query}`;
    },
  });

  assert.equal(searchQueries.length, 7);
  assert.equal(searchQueries[0], '查询1');
  assert.equal(searchQueries[6], '查询7');
  assert.match(result.finalResponse, /我已经连续补充联网搜索了7次/);
});

test('runAgentWithWebSearch reuses cached search results for repeated queries', async () => {
  const searchQueries: string[] = [];
  const prompts: string[] = [];
  const agentResponses = [
    '[[WEB_SEARCH: 上海天气]]',
    '[[WEB_SEARCH: 上海 今天天气]]',
    '根据刚才的搜索结果，上海今天多云。',
  ];

  const result = await runAgentWithWebSearch({
    initialWebContext: '(无联网结果)',
    maxSearchSteps: 7,
    buildPrompt: (webContext) => `CTX=${webContext}`,
    promptAgent: async (prompt) => {
      prompts.push(prompt);
      const next = agentResponses.shift();
      if (!next) {
        throw new Error('no mock response');
      }
      return next;
    },
    search: async (query) => {
      searchQueries.push(query);
      return `result for ${query}`;
    },
  });

  assert.equal(result.finalResponse, '根据刚才的搜索结果，上海今天多云。');
  assert.deepEqual(searchQueries, ['上海天气']);
  assert.match(prompts[2], /沿用已有联网搜索结果#1/);
});
