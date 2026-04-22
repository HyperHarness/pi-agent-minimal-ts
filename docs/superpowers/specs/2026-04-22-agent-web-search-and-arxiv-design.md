# Agent Web Search And arXiv Design

**Date:** 2026-04-22

## Goal

Add real-time retrieval capabilities to the standalone terminal agent without coupling the feature to the REPL shell.

The change must:
- keep `npm run agent` as a standalone local agent entrypoint
- preserve the current REPL flow and CLI argument surface
- add tool-level support for current web information
- add first-party arXiv search and paper access using arXiv's official interfaces
- let the model discover and use the new tools on its own

## Chosen Approach

Add four focused tools behind `createTools(workspaceDir)`:
- `web_search(query, maxResults)`
- `fetch_url(url)`
- `search_arxiv(query, maxResults)`
- `download_arxiv_pdf(id)`

The REPL runtime stays unchanged apart from receiving the expanded toolset.

Tool execution is backed by two small HTTP clients:
- a configurable external search client for general web search
- an arXiv client that talks to arXiv's public metadata API and canonical article URLs

This keeps networking behavior in the tool layer instead of mixing it into the session loop.

## Architecture

### Tool Layer

`src/agent/tools.ts` remains the single place where the agent's tool list is assembled.

Existing tools:
- `get_time`
- `read_file`

New tools:
- `web_search`
- `fetch_url`
- `search_arxiv`
- `download_arxiv_pdf`

Each tool will delegate to a small helper instead of embedding request logic directly inside the tool definition. This keeps tool schemas, execution, and formatting readable and makes the network clients testable in isolation.

### Web Search Client

The web search client calls a user-provided HTTP endpoint with this contract:

Request:

```json
{
  "query": "nasdaq composite index now",
  "maxResults": 5
}
```

Response:

```json
{
  "results": [
    {
      "title": "NASDAQ Composite Index",
      "url": "https://example.com/nasdaq",
      "snippet": "Latest market summary..."
    }
  ]
}
```

Configuration is read from environment variables:
- `PI_SEARCH_API_URL`: full `POST /search` endpoint
- `PI_SEARCH_API_KEY`: optional bearer token for the search service
- `PI_FETCH_USER_AGENT`: optional user agent string for webpage fetches
- `PI_FETCH_TIMEOUT_MS`: optional shared timeout in milliseconds for outbound HTTP requests

### Web Fetch Client

`fetch_url` performs a direct `http` or `https` request to a public URL and returns cleaned page text.

Behavior:
- reject non-HTTP(S) URLs
- send a configurable `User-Agent`
- treat timeout and transport failures as tool errors
- reject clearly non-HTML responses
- remove `script`, `style`, and `noscript` blocks from HTML before text extraction
- collapse repeated whitespace
- truncate output to a bounded size so one page cannot consume the whole context window

This tool is intentionally simple. It is meant for spot verification of search results, not full web crawling.

### arXiv Client

arXiv support uses official arXiv interfaces rather than the external web search provider.

`search_arxiv`:
- queries arXiv's public metadata API
- extracts a compact result list containing:
  - `id`
  - `title`
  - `authors`
  - `summary`
  - `absUrl`
  - `pdfUrl`

`download_arxiv_pdf`:
- accepts a canonical arXiv identifier such as `2501.01234`
- produces the official PDF URL in the form `https://arxiv.org/pdf/<id>.pdf`

The initial version does not need to save the PDF into the workspace. Returning the official URL is the smallest useful unit because it enables citation, follow-up retrieval, and user inspection without introducing file download side effects.

## Data Flow

### Current-Information Questions

For questions such as current index levels, recent concerts, or fresh announcements:
1. the model may choose `web_search`
2. the model may inspect one or more candidate sources via `fetch_url`
3. the model answers using the tool outputs

No special REPL behavior is required. The loop already streams tool execution events.

### arXiv Questions

For paper-discovery questions:
1. the model uses `search_arxiv`
2. the model can cite the returned metadata directly
3. if the user requests the paper PDF, the model uses `download_arxiv_pdf`

This path avoids wasting general web-search calls on a source with a stable official API.

## Error Handling

### Search Configuration Errors

If `PI_SEARCH_API_URL` is missing, `web_search` fails with a clear configuration error that tells the model the web search service is not configured.

If `PI_SEARCH_API_KEY` is set, the client sends `Authorization: Bearer <key>`. If the search service rejects the key, the tool surfaces the upstream HTTP status in a compact error message.

### Fetch Errors

`fetch_url` returns clear tool errors for:
- unsupported URL schemes
- timeout
- network failure
- non-success HTTP status
- obviously unsupported content types

### arXiv Errors

`search_arxiv` returns an empty result set for no matches and a tool error for transport or parse failures.

`download_arxiv_pdf` validates the requested identifier shape before constructing the PDF URL. Invalid IDs fail early with a readable error.

## Testing Strategy

The feature will be implemented test-first.

### Search Client Tests

Add unit tests for:
- request method, JSON body, and authorization header
- successful response mapping into tool output
- timeout and non-200 failure handling
- missing `PI_SEARCH_API_URL`

### Fetch Client Tests

Add unit tests for:
- rejecting non-HTTP(S) URLs
- cleaning simple HTML into text
- rejecting non-HTML responses
- truncation and timeout behavior

### arXiv Client Tests

Add unit tests for:
- parsing a representative arXiv feed response into result items
- generating canonical `abs` and `pdf` URLs
- validating malformed arXiv IDs for `download_arxiv_pdf`

### Tool Registration Tests

Extend tool tests to verify:
- the new tool names are exposed by `createTools()`
- tool parameter validation is stable
- success payloads include useful `details`
- failures surface readable error text

### Regression Tests

Existing REPL and session tests remain in place. This change must not alter:
- interactive prompt handling
- non-interactive stdin handling
- `exit` / `quit` behavior
- current `read_file` and `get_time` behavior

## Non-Goals

- no change to the current system prompt
- no attempt to force the model to use search for every time-sensitive question
- no persistent caching layer
- no multi-page crawling or recursive browsing
- no PDF download-to-disk behavior in the first iteration
- no provider-specific OpenAI built-in `web_search` integration in this task
