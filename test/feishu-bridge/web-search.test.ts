import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchQuery,
  enrichWebResults,
  normalizeSearchCacheKey,
  parseDuckDuckGoHtml,
  parseJinaPageContent,
  parseJinaSearchMarkdown,
  shouldUseWebSearch,
  shouldTreatSearchPageAsError,
} from '../../src/feishu-bridge/web/search.js';

test('shouldUseWebSearch detects time-sensitive, live-info, and weather questions', () => {
  assert.equal(shouldUseWebSearch('今天英伟达股价是多少？'), true);
  assert.equal(shouldUseWebSearch('最新的 OpenAI 模型是什么？'), true);
  assert.equal(shouldUseWebSearch('上海明天天气怎么样？'), true);
  assert.equal(shouldUseWebSearch('帮我总结这段群聊'), false);
});

test('buildSearchQuery keeps the user question concise and strips leading mentions', () => {
  assert.equal(buildSearchQuery('今天英伟达股价是多少？').includes('英伟达'), true);
  assert.equal(buildSearchQuery('@_user_1 上海明天天气怎么样？'), '上海明天天气怎么样');
  assert.equal(buildSearchQuery('@机器人 现在上海天气如何？'), '现在上海天气如何');
});

test('normalizeSearchCacheKey collapses near-duplicate weather queries', () => {
  assert.equal(normalizeSearchCacheKey('上海天气'), normalizeSearchCacheKey('上海 今天天气'));
  assert.equal(normalizeSearchCacheKey('上海天气'), normalizeSearchCacheKey('上海天气怎么样'));
  assert.equal(normalizeSearchCacheKey('OpenAI 最新模型'), normalizeSearchCacheKey('OpenAI 的最新模型是什么'));
});

test('parseDuckDuckGoHtml extracts title, url, and snippet', () => {
  const html = `
    <html><body>
      <div class="result">
        <a class="result__a" href="https://example.com/a">结果A</a>
        <a class="result__snippet">摘要A</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://example.com/b">结果B</a>
        <a class="result__snippet">摘要B</a>
      </div>
    </body></html>
  `;

  const results = parseDuckDuckGoHtml(html, 5);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, '结果A');
  assert.equal(results[0].url, 'https://example.com/a');
  assert.equal(results[0].snippet, '摘要A');
});

test('parseJinaSearchMarkdown extracts title, url, and snippet from jina-wrapped search results', () => {
  const markdown = `
Title: 上海 明天 天气 at DuckDuckGo

## [上海天气预报,上海7天天气预报](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.weather.com.cn%2Fweather%2F101020100.shtml)
上海明天多云，14~22℃，东南风。

## [上海天气 - 墨迹天气](https://duckduckgo.com/l/?uddg=https%3A%2F%2Ftianqi.moji.com%2Fweather%2Fchina%2Fshanghai%2Fshanghai)
未来两天上海以多云为主。
`;

  const results = parseJinaSearchMarkdown(markdown, 5);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, '上海天气预报,上海7天天气预报');
  assert.match(results[0].url, /weather\.com\.cn/);
  assert.match(results[0].snippet, /上海明天多云/);
});

test('shouldTreatSearchPageAsError detects rate limits and error pages', () => {
  assert.equal(shouldTreatSearchPageAsError('Error 451: blocked temporarily'), true);
  assert.equal(shouldTreatSearchPageAsError('Too Many Requests\nCAPTCHA required'), true);
  assert.equal(shouldTreatSearchPageAsError('Unfortunately, bots use DuckDuckGo too.'), true);
  assert.equal(shouldTreatSearchPageAsError('## [正常结果](https://example.com)\n摘要内容'), false);
});

test('parseJinaPageContent extracts useful正文信息 from page markdown', () => {
  const page = `
Title: 4.1版本预下载&更新预告-崩坏：星穹铁道社区-米游社

URL Source: https://www.miyoushe.com/bh3/article/74119476

Published Time: Wed, 11 Feb 2026 06:45:56 GMT

Markdown Content:
# 4.1版本预下载&更新预告-崩坏：星穹铁道社区-米游社

亲爱的开拓者：

4.1版本预下载将于 2026/03/23 14:00 开启，届时开拓者可提前下载部分资源，在版本更新维护结束后可更快进入游戏。

此外，列车组预计于 2026/03/25 06:00 进行版本更新维护，维护完成后将更新至4.1版本「献给破晓的失控」。

▌更新时间

2026/03/25 06:00 开始，预计需要5个小时。
`;

  const summary = parseJinaPageContent(page, 280);
  assert.match(summary, /2026\/03\/23 14:00/);
  assert.match(summary, /2026\/03\/25 06:00/);
  assert.doesNotMatch(summary, /Title:/);
});

test('enrichWebResults fills empty snippets with fetched page正文摘要', async () => {
  const enriched = await enrichWebResults(
    [
      {
        title: '4.1版本预下载&更新预告-崩坏：星穹铁道社区-米游社',
        url: 'https://www.miyoushe.com/bh3/article/74119476',
        snippet: '',
      },
    ],
    async () => `
Title: page

Markdown Content:
亲爱的开拓者：4.1版本预下载将于 2026/03/23 14:00 开启。列车组预计于 2026/03/25 06:00 进行版本更新维护。
`,
  );

  assert.match(enriched[0].snippet, /2026\/03\/23 14:00/);
  assert.match(enriched[0].snippet, /2026\/03\/25 06:00/);
});
