import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const execFileAsync = promisify(execFile);

export function shouldUseWebSearch(question: string): boolean {
  const normalized = question.toLowerCase();
  const keywords = [
    '今天',
    '明天',
    '后天',
    '最新',
    '刚刚',
    '现在',
    '天气',
    '气温',
    '温度',
    '降雨',
    '降雪',
    '股价',
    '新闻',
    'release',
    'update',
    '官网',
    '官方',
  ];
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

export function buildSearchQuery(question: string): string {
  return question
    .replace(/^(?:\s*@[^\s]+[\s:：,，-]*)+/, '')
    .replace(/[？?！!。]+$/g, '')
    .trim();
}

export function normalizeSearchCacheKey(question: string): string {
  return buildSearchQuery(question)
    .toLowerCase()
    .replace(/[的了呢吗吧呀啊]/g, ' ')
    .replace(/\b(today|latest|newest|official)\b/g, ' ')
    .replace(/今天天气|今日天气/g, '天气')
    .replace(/怎么样|如何|是什么|是多少/g, ' ')
    .replace(/\s+/g, '')
    .trim();
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '')
    .trim();
}

export function parseDuckDuckGoHtml(html: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const regex = /<div class="result">[\s\S]*?<a class="result__a" href="([^"]+)">([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet">([\s\S]*?)<\/a>[\s\S]*?<\/div>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) && results.length < limit) {
    results.push({
      url: decodeHtml(match[1]),
      title: decodeHtml(match[2]),
      snippet: decodeHtml(match[3]),
    });
  }
  return results;
}

function decodeDuckDuckGoRedirect(url: string): string {
  try {
    const parsed = new URL(url);
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) {
      return decodeURIComponent(uddg);
    }
  } catch {
    // fall through and return original url
  }

  return url;
}

export function parseJinaSearchMarkdown(markdown: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const regex = /^## \[(.+?)\]\((.+?)\)\n([\s\S]*?)(?=\n## \[|$)/gm;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdown)) && results.length < limit) {
    const title = decodeHtml(match[1]);
    const url = decodeDuckDuckGoRedirect(match[2].trim());
    const snippet = decodeHtml(
      match[3]
        .replace(/\n+/g, ' ')
        .trim(),
    );

    if (!title || !url) {
      continue;
    }

    results.push({ title, url, snippet });
  }

  return results;
}

export function shouldTreatSearchPageAsError(page: string): boolean {
  const markers = [
    'Unfortunately, bots use DuckDuckGo too.',
    'anomaly-modal__title',
    'Too Many Requests',
    'Error 429',
    'Error 451',
    'SecurityCompromiseError',
    'CAPTCHA',
    'blocked temporarily',
  ];
  return markers.some((marker) => page.includes(marker));
}

async function fetchPage(url: string): Promise<string> {
  const { stdout } = await execFileAsync('curl', ['-sSL', '--fail-with-body', '--max-time', '20', url], {
    maxBuffer: 2 * 1024 * 1024,
  });

  return stdout;
}

function cleanMarkdownLine(line: string): string {
  return line
    .replace(/^#+\s*/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/\*+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUsefulSummary(summary: string): boolean {
  if (!summary) {
    return false;
  }

  const junkMarkers = ['Loading...', '数据加载中', 'JavaScript', 'Enable JavaScript'];
  if (junkMarkers.some((marker) => summary.includes(marker))) {
    return false;
  }

  return summary.length >= 24;
}

export function parseJinaPageContent(page: string, maxLength = 320): string {
  const markdownIndex = page.indexOf('Markdown Content:');
  const content = markdownIndex >= 0 ? page.slice(markdownIndex + 'Markdown Content:'.length) : page;
  const lines = content
    .split(/\r?\n/)
    .map(cleanMarkdownLine)
    .filter(Boolean)
    .filter((line) => !/^Title:|^URL Source:|^Published Time:/.test(line))
    .filter((line) => !/^Image \d+$/.test(line))
    .filter((line) => line !== '进入官网' && line !== '首页' && line !== '新闻');

  const picked: string[] = [];
  for (const line of lines) {
    const looksInformative = /\d{4}[\/-]\d{1,2}[\/-]\d{1,2}|\d{1,2}:\d{2}|预计|维护|开启|上线|公告|版本|更新|时间|发布时间|预下载/.test(line);
    if (looksInformative || picked.length < 2) {
      picked.push(line);
    }
    if (picked.join(' ').length >= maxLength) {
      break;
    }
  }

  const summary = picked.join(' ').slice(0, maxLength).trim();
  return summary;
}

async function fetchJinaPageSummary(url: string, maxLength = 320): Promise<string> {
  const stripped = url.replace(/^https?:\/\//, '');
  const candidates = [
    `https://r.jina.ai/http://${stripped}`,
  ];

  for (const candidate of candidates) {
    try {
      const page = await fetchPage(candidate);
      if (shouldTreatSearchPageAsError(page)) {
        continue;
      }
      const summary = parseJinaPageContent(page, maxLength);
      if (isUsefulSummary(summary)) {
        return summary;
      }
    } catch {
      // try next candidate
    }
  }

  return '';
}

export async function enrichWebResults(
  results: WebSearchResult[],
  fetchPageSummary: (url: string) => Promise<string> = fetchJinaPageSummary,
): Promise<WebSearchResult[]> {
  const enriched: WebSearchResult[] = [];

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.snippet && result.snippet.length >= 24) {
      enriched.push(result);
      continue;
    }

    if (index >= 3) {
      enriched.push(result);
      continue;
    }

    try {
      const pageSummary = await fetchPageSummary(result.url);
      enriched.push({
        ...result,
        snippet: pageSummary || result.snippet,
      });
    } catch {
      enriched.push(result);
    }
  }

  return enriched;
}

export async function searchWeb(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const target = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const url = `https://r.jina.ai/http://${target.replace(/^https?:\/\//, '')}`;
  const page = await fetchPage(url);

  if (!page.trim()) {
    throw new Error('web search failed: empty response');
  }

  if (shouldTreatSearchPageAsError(page)) {
    throw new Error('web search failed: upstream error page');
  }

  const markdownResults = parseJinaSearchMarkdown(page, maxResults);
  if (markdownResults.length > 0) {
    return enrichWebResults(markdownResults);
  }

  const htmlResults = parseDuckDuckGoHtml(page, maxResults);
  if (htmlResults.length > 0) {
    return enrichWebResults(htmlResults);
  }

  throw new Error('web search failed: no parsable results');
}

export function formatWebResults(results: WebSearchResult[]): string {
  if (results.length === 0) {
    return '(无联网结果)';
  }
  return results
    .map((item, index) => `${index + 1}. ${item.title}\n链接: ${item.url}\n摘要: ${item.snippet || '(无摘要，建议打开链接查看正文)'}`)
    .join('\n\n');
}
