# pi-agent-minimal-ts

Minimal TypeScript agent built on [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai) and [`@mariozechner/pi-agent-core`](https://www.npmjs.com/package/@mariozechner/pi-agent-core).

It provides:

- multi-turn terminal chat
- tool calling with a minimal local toolset
- model selection by provider and model ID
- optional `baseUrl` override for OpenAI-compatible or proxied endpoints

## Requirements

- Node.js
- npm
- an API key for the provider you want to use

## Install

If you are on Windows, especially Windows PowerShell or Codex Desktop on Windows, read [docs/windows-powershell-codex-quickstart.md](docs/windows-powershell-codex-quickstart.md) before installing dependencies.

If you are not on Windows, continue with the normal install steps below.

Use the normal install path if you want browser-session paper downloads to work without extra setup:

```powershell
npm install
```

This lets Playwright install its managed browser during dependency setup. If you skip install scripts with `npm install --ignore-scripts`, normal build/test workflows still work, but the automatic `download_paper_pdf` path will require one of these before it can launch its browser session:

- set `PI_PAPER_CHROME_EXECUTABLE` to an existing local Chrome/Chromium executable
- install a Playwright browser separately, for example `npx playwright install chromium`

The paper-browser manager is the primary model for both manual review and automatic downloads; it reuses one managed browser session instead of treating direct local browser launch as the default path.

## Run

Use environment variables:

```powershell
$env:OPENAI_API_KEY="your-key"
$env:PI_PROVIDER="openai"
$env:PI_MODEL="gpt-5.4"
$env:PI_SEARCH_API_URL="https://search.example.com/query"
$env:PI_SEARCH_API_KEY="your-search-key"
$env:PI_FETCH_USER_AGENT="pi-agent-minimal-ts/1.0"
$env:PI_FETCH_TIMEOUT_MS="10000"
npm run agent
```

Use CLI arguments:

```powershell
npm run agent -- --provider openai --model gpt-5.4
```

Use an OpenAI-compatible proxy or relay:

```powershell
$env:OPENAI_API_KEY="your-proxy-key"
npm run agent -- --provider openai --model gpt-5.4 --base-url https://your-proxy.example.com/v1
```

You can also set `PI_BASE_URL` instead of passing `--base-url`.

Exit the REPL with `exit` or `quit`.

## Paper Browser Manager

The paper tools share one managed browser session per workspace. The manager owns the shared profile at `.browser-profile/paper-access/` and stores its localhost metadata at `.browser-profile/paper-access-manager.json`.

Supported publishers:

- `science.org`
- `nature.com`
- `journals.aps.org` / `aps.org`

Use the normal install path if you want the manager-backed paper tools to start their browser automatically:

- keep Playwright's install scripts enabled during `npm install`
- or install a browser separately, for example `npx playwright install chromium`
- or set `PI_PAPER_CHROME_EXECUTABLE` to an existing local Chrome/Chromium executable before starting the agent

`open_paper_page_for_login` and `download_paper_pdf` both reuse that same managed browser session. If the saved manager metadata points to a dead process or an unreachable localhost endpoint, the client clears the stale metadata automatically and starts a fresh manager.

`open_paper_page_for_login` opens the article page in the managed browser session for manual login or verification and stops there.

`download_paper_pdf` tries the automatic download path first. If the download cannot complete or the downloaded file is not a valid PDF, the tool opens the same article in that same managed browser session and returns a structured `manual_fallback_opened` result for manual continuation.

Successful downloads now use formatted filenames when possible, for example `science-10.1126-science.adz8659.pdf`, instead of always overwriting `downloaded-paper.pdf`. The tool still falls back to the source filename or `downloaded-paper.pdf` when it cannot derive a better name.

If you want to confirm that the managed session is already logged in before attempting a download, open the paper page first:

```text
Open this paper page with open_paper_page_for_login: https://www.science.org/doi/10.1126/science.adz8659
```

Example automatic download prompt:

```text
Download this paper with download_paper_pdf: https://www.science.org/doi/10.1126/science.adz8659
```

For manual verification, keep your own publisher test URLs in a local scratch file such as `paper_url.txt` or in your notes. This repository does not ship a tracked `paper_url.txt`. Check that each URL belongs to one of the supported hosts above, then run the download and confirm the automatic path writes the PDF under `downloads/papers/` with a publisher/article-derived filename when available.

## Search And Fetch Configuration

Optional environment variables for web search and page fetch tools:

- `PI_SEARCH_API_URL`: HTTP endpoint used by `web_search`
- `PI_SEARCH_API_KEY`: optional bearer token sent to the search provider
- `PI_FETCH_USER_AGENT`: optional `User-Agent` header for `fetch_url`
- `PI_FETCH_TIMEOUT_MS`: optional timeout in milliseconds for both search and fetch requests

The search provider contract is JSON over HTTP `POST`:

Request body:

```json
{
  "query": "latest pi-ai release notes",
  "maxResults": 5
}
```

Response body:

```json
{
  "results": [
    {
      "title": "Release notes",
      "url": "https://example.com/release-notes",
      "snippet": "Summary text for the matching page."
    }
  ]
}
```

## REPL Usage

When the agent starts, it prints the selected model and waits for one prompt per line:

```text
model> openai/gpt-5.4
> 
```

- `model> ...`: the provider/model selected for the current session
- `> `: the REPL input prompt
- `assistant> ...`: streamed or final assistant text
- `[tool:start] ...` / `[tool:end] ...`: tool execution lifecycle messages

Example interactive session:

```text
model> openai/gpt-5.4
> what time is it in UTC?
[tool:start] get_time
[tool:end] get_time ok
assistant> Wednesday, April 22, 2026 at 1:23:45 PM UTC
> exit
```

The REPL keeps conversation history in memory for the current process, so later prompts in the same session can refer to earlier turns.

### Non-interactive input

The agent also accepts non-interactive stdin input. Each non-empty input line is treated as one prompt, which makes piping and scripting easier.

```powershell
@(
  "hello",
  "read README.md and summarize it",
  "exit"
) | npm run agent -- --provider openai --model gpt-5.4
```

In non-interactive mode:

- blank lines are ignored
- `exit` or `quit` stops the session cleanly
- stdin EOF ends the process without the old `ERR_USE_AFTER_CLOSE` readline failure

## Built-in Tools

- `get_time`: returns the current time, optionally for a given timezone
- `read_file`: reads a UTF-8 text file from inside the current workspace
- `web_search`: searches the configured provider and returns JSON text for matching results
- `fetch_url`: fetches an HTML page and returns JSON text for the extracted content
- `search_arxiv`: searches arXiv and returns JSON text for matching paper metadata
- `download_arxiv_pdf`: returns the canonical arXiv PDF URL for a paper ID
- `open_paper_page_for_login`: opens the paper page in the managed browser session for manual login review without downloading anything
- `download_paper_pdf`: downloads a PDF automatically from a supported publisher URL when possible, or opens the same paper in the managed browser session for manual continuation when automatic download fails

For `search_arxiv`, prefer concise English keyword queries. arXiv's API is much more reliable with English search terms than with natural-language Chinese prompts.

`read_file` rejects absolute paths and paths that resolve outside the workspace.

Example prompts:

- `Search the web for the latest OpenAI API pricing updates and summarize the top 3 results.`
- `Fetch https://openai.com/api and extract the main text.`
- `Find arXiv papers about retrieval-augmented generation from the last few years.`
- `Give me the PDF link for arXiv paper 2401.01234.`

## Scripts

- `npm run build`: compile TypeScript to `dist/`
- `npm test`: run the automated test suite
- `npm run agent`: build and start the agent

## Test

```powershell
npm test
```

## Notes

- conversation history is kept in memory only
- failed assistant turns are not persisted into the ongoing context
- very large files are not size-limited yet, so `read_file` can still create memory pressure if misused
