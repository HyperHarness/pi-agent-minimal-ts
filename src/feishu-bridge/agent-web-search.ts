import { normalizeSearchCacheKey } from './web/search.js';

export { normalizeSearchCacheKey } from './web/search.js';

export interface RunAgentWithWebSearchOptions {
  initialWebContext: string;
  maxSearchSteps: number;
  buildPrompt: (webContext: string) => string;
  promptAgent: (prompt: string) => Promise<string>;
  search: (query: string) => Promise<string>;
  onSearchRequest?: (query: string, step: number) => Promise<void> | void;
}

export interface RunAgentWithWebSearchResult {
  finalResponse: string;
  webContext: string;
  searchQueries: string[];
}

interface CachedSearchEntry {
  contextLabel: string;
  searchResults: string;
}

const WEB_SEARCH_REQUEST_REGEX = /^\s*\[\[WEB_SEARCH:\s*(.+?)\s*\]\]\s*$/s;

export function extractAgentWebSearchQuery(response: string): string | null {
  const match = response.match(WEB_SEARCH_REQUEST_REGEX);
  if (!match) {
    return null;
  }

  const query = match[1]?.trim();
  return query ? query : null;
}

export function appendAgentWebSearchInstruction(basePrompt: string): string {
  return [
    basePrompt,
    '',
    '你可以使用桥接层提供的联网搜索能力。',
    '如果你判断现有信息不足、且需要更多实时信息才能更好回答，请不要直接猜测。',
    '此时请仅输出一行，严格使用这个格式：[[WEB_SEARCH: 你的搜索词]]',
    '不要输出解释、不要输出前后缀、不要和最终答案混在一起。',
    '如果当前信息已经足够，请直接正常回答用户。',
  ].join('\n');
}

function mergeWebContext(previousWebContext: string, contextLabel: string, searchResults: string): string {
  const sections = previousWebContext && previousWebContext !== '(无联网结果)' ? [previousWebContext] : [];
  sections.push(`${contextLabel}\n${searchResults}`);
  return sections.join('\n\n');
}

export async function runAgentWithWebSearch(
  options: RunAgentWithWebSearchOptions,
): Promise<RunAgentWithWebSearchResult> {
  let webContext = options.initialWebContext;
  const searchQueries: string[] = [];
  const cachedSearches = new Map<string, CachedSearchEntry>();

  for (let step = 0; step <= options.maxSearchSteps; step += 1) {
    const prompt = appendAgentWebSearchInstruction(options.buildPrompt(webContext));
    const response = (await options.promptAgent(prompt)).trim();
    const query = extractAgentWebSearchQuery(response);

    if (!query) {
      return {
        finalResponse: response || '已处理，但没有返回文本结果。',
        webContext,
        searchQueries,
      };
    }

    if (step >= options.maxSearchSteps) {
      return {
        finalResponse: `我已经连续补充联网搜索了${options.maxSearchSteps}次，还是没能把答案收敛到足够可靠的程度。你可以把问题再具体一点，或者给我一个更明确的方向，我继续查。`,
        webContext,
        searchQueries,
      };
    }

    const normalizedQuery = query.trim();
    const cacheKey = normalizeSearchCacheKey(normalizedQuery);
    const cached = cachedSearches.get(cacheKey);
    if (cached) {
      webContext = mergeWebContext(webContext, cached.contextLabel, cached.searchResults);
      continue;
    }

    searchQueries.push(normalizedQuery);
    await options.onSearchRequest?.(normalizedQuery, step);
    const searchResults = await options.search(normalizedQuery);
    const contextLabel = `补充联网搜索结果#${step + 1}（查询：${normalizedQuery}）`;
    cachedSearches.set(cacheKey, {
      contextLabel: `沿用已有联网搜索结果#${step + 1}（查询：${normalizedQuery}）`,
      searchResults,
    });
    webContext = mergeWebContext(webContext, contextLabel, searchResults);
  }

  return {
    finalResponse: '已处理，但没有返回文本结果。',
    webContext,
    searchQueries,
  };
}
