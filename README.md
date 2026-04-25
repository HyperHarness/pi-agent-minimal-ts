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

This lets Playwright install its managed browser during dependency setup. If you skip install scripts with `npm install --ignore-scripts`, normal build/test workflows still work, but the managed-browser paper flow used by `download_paper` and `open_paper_page_for_login` will require one of these before it can launch its browser session:

- set `PI_PAPER_CHROME_EXECUTABLE` to an existing local Chrome/Chromium executable
- install a Playwright browser separately, for example `npx playwright install chromium`

The paper-browser manager is the intended reuse path for supported publisher review and downloads. It aims to reuse a managed browser session instead of treating direct local browser launch as the default path.

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

The paper tools are designed to reuse a managed browser session per workspace when one is available. The manager owns the shared profile at `.browser-profile/paper-access/` and stores its localhost metadata at `.browser-profile/paper-access-manager.json`.

Supported publishers:

- `science.org`
- `nature.com`
- `journals.aps.org` / `aps.org`

Use the normal install path if you want the manager-backed paper tools to start their browser automatically:

- keep Playwright's install scripts enabled during `npm install`
- or install a browser separately, for example `npx playwright install chromium`
- or set `PI_PAPER_CHROME_EXECUTABLE` to an existing local Chrome/Chromium executable before starting the agent

`open_paper_page_for_login` and the supported-publisher path in `download_paper` both try to reuse that same managed browser session. Stale manager metadata is recovered automatically: if the saved metadata points to a dead process or an unreachable localhost endpoint, the client clears it and starts a fresh manager. This is best-effort coordination rather than a hard lock against concurrent cold starts.

`open_paper_page_for_login` opens the article page in the managed browser session for manual login or verification and stops there.

`download_paper` handles three cases:

- arXiv IDs or arXiv URLs download directly into `downloads/papers/`
- supported publisher URLs on `science.org`, `nature.com`, and `journals.aps.org` / `aps.org` reuse the managed browser session for download, with `manual_fallback_opened` if manual continuation is needed
- unsupported external URLs are opened for manual continuation instead of attempting a managed download

Before any arXiv, supported-publisher, or external URL action, the paper manager checks `downloads/papers/index/` for an existing `downloaded` record with a PDF file that still exists under `downloads/papers/`. When it finds one, it returns `already_downloaded` with the existing file path and skips the network or browser action. Manual fallback and plain `external_opened` records do not count as completed downloads.

For unsupported external URLs, use `register_manual_paper_download` after downloading the PDF manually. Give it the original external URL and a relative workspace path to the PDF, for example `downloads/inbox/paper.pdf`. The tool verifies the file is a PDF, copies it into `downloads/papers/`, records a SHA-256 hash, and updates the external index record to `downloaded` so future attempts for that URL return `already_downloaded`.

`download_latest_aps_papers` is the direct batch path for prompts such as "search and download the latest 3 APS papers about superconducting quantum computing." It searches APS/Physical Review metadata through Crossref's `10.1103` DOI prefix, then attempts each APS download through the same managed browser flow. Each result is either a downloaded PDF record or a `manual_fallback_opened` APS page for the user to finish manually.

Successful downloads now use formatted filenames when possible, for example `science-10.1126-science.adz8659.pdf`, instead of always overwriting `downloaded-paper.pdf`. The tool still falls back to the source filename or `downloaded-paper.pdf` when it cannot derive a better name.

If you want to confirm that the managed session is already logged in before attempting a download, open the paper page first:

```text
Open this paper page with open_paper_page_for_login: https://www.science.org/doi/10.1126/science.adz8659
```

Example automatic download prompt:

```text
Download this paper with download_paper: https://www.science.org/doi/10.1126/science.adz8659
```

Example APS batch prompt:

```text
Search and download the latest 3 APS papers about superconducting quantum computing with download_latest_aps_papers.
```

For manual verification, keep your own publisher test URLs in a local scratch file such as `paper_url.txt` or in your notes. This repository does not ship a tracked `paper_url.txt`. Check that each URL belongs to one of the supported hosts above, then run the download and confirm the automatic path writes the PDF under `downloads/papers/` with a publisher/article-derived filename when available.

## Search And Fetch Configuration

Optional environment variables for web search and page fetch tools:

- `PI_SEARCH_API_URL`: HTTP endpoint used by `web_search`
- `PI_SEARCH_API_KEY`: optional bearer token sent to the search provider
- `PI_FETCH_USER_AGENT`: optional `User-Agent` header for `fetch_url`
- `PI_FETCH_TIMEOUT_MS`: optional timeout in milliseconds for both search and fetch requests
- `PI_PAPER_CLOUDFLARE_COOLDOWN_MS`: optional APS/Cloudflare cooldown window for batch paper downloads; defaults to 30 minutes

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
- `search_papers`: searches arXiv first, then expands discovery with `web_search`, merges overlapping results, and classifies supported publishers versus external sources
- `download_paper`: downloads arXiv papers into `downloads/papers/`, uses the managed browser flow for supported publishers, returns `already_downloaded` for existing indexed PDFs, and opens unsupported external URLs for manual continuation
- `download_latest_aps_papers`: searches APS/Physical Review metadata for the latest matching papers and attempts each APS download, returning downloaded PDFs or opened APS pages for manual download
- `register_manual_paper_download`: registers a manually downloaded external PDF into `downloads/papers/` and updates the local index so repeated requests for the same URL are skipped
- `open_paper_page_for_login`: opens the paper page in the managed browser session for manual login review without downloading anything

For `search_papers`, concise English keyword queries still work best because the first search stage uses arXiv before expanding through `web_search`.

For APS batch downloads, the agent records recent Cloudflare blocks in `.browser-profile/paper-access-state.json`. If APS was blocked recently, `download_latest_aps_papers` skips automatic PDF attempts and opens the article pages directly. The default cooldown is 30 minutes, matching Cloudflare's default Challenge Passage lifetime; override it with `PI_PAPER_CLOUDFLARE_COOLDOWN_MS` when needed.

`read_file` rejects absolute paths and paths that resolve outside the workspace.

Example prompts:

- `Search the web for the latest OpenAI API pricing updates and summarize the top 3 results.`
- `Fetch https://openai.com/api and extract the main text.`
- `Search papers about retrieval-augmented generation from the last few years and highlight which results are arXiv, supported publisher papers, or external sources.`
- `Download arXiv paper 2401.01234 with download_paper.`
- `Download this paper with download_paper: https://www.science.org/doi/10.1126/science.adz8659`
- `Search and download the latest 3 APS papers about superconducting quantum computing with download_latest_aps_papers.`
- `Register the manually downloaded PDF for https://example.com/paper with register_manual_paper_download using downloads/inbox/paper.pdf.`

## Scripts

- `npm run build`: compile TypeScript to `dist/`
- `npm test`: run the automated test suite
- `npm run agent`: build and start the agent
- `npm run doctor:approval`: diagnose Windows PowerShell Codex approval rules for routine Git commands
- `npm run doctor:approval -- --apply`: append missing safe approval rules without allowing broad `git` prefixes

## Test

```powershell
npm test
```

## Notes

- conversation history is kept in memory only
- failed assistant turns are not persisted into the ongoing context
- very large files are not size-limited yet, so `read_file` can still create memory pressure if misused
