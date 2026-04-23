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

The manual-browser fallback is separate: it can launch an installed local Chrome or Edge directly for manual continuation when automatic download fails.

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

## Browser-Session Paper Downloads

The paper download tool uses the shared browser profile at `.browser-profile/paper-access/` inside the workspace.

Supported publishers:

- `science.org`
- `nature.com`
- `journals.aps.org` / `aps.org`

If the automatic browser session cannot be launched with the default Playwright/Chrome setup on your machine, set `PI_PAPER_CHROME_EXECUTABLE` to the Chrome executable path before starting the agent. The manual fallback can instead launch an installed local Chrome or Edge directly.

`download_paper_pdf` downloads the PDF automatically when possible. If automatic `download_paper_pdf` cannot complete and the tool can launch the local Chrome or Edge browser with that shared profile, it opens the original paper page and returns a structured `manual_fallback_opened` result for manual continuation. If that local browser launch also fails, the tool can still surface a hard error.

That fallback does not import the browser-downloaded file back into the workspace automatically. It is only a recovery path for manual continuation.

Example prompt:

```text
Download this paper with download_paper_pdf: https://www.science.org/doi/10.1126/science.adz8659
```

For manual verification, put your own test URLs into a local scratch file such as `paper_url.txt` or keep them in your notes. This repository does not ship a tracked `paper_url.txt`. Check that each URL belongs to one of the supported hosts above, then run the download against each URL and confirm the automatic path writes the PDF to `downloads/papers/downloaded-paper.pdf`. Repeated successful automatic runs overwrite that file unless you move or rename it between runs.

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
- `open_paper_page_for_login`: opens the paper page in the local Chrome or Edge browser with the shared paper-access profile for manual login review without downloading anything
- `download_paper_pdf`: downloads a PDF automatically from a supported browser-session publisher URL when possible, or opens the same paper in the local browser for manual continuation when automatic download fails and the local browser launch succeeds

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
