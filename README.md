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

Prefer a non-elevated install first:

```powershell
npm install --ignore-scripts
```

This project does not require install-time scripts to build or run, so `npm install --ignore-scripts` is the default recommendation when you want to avoid elevation or run inside a restricted environment. After installing dependencies this way, you can verify the setup with `npm run build` or `npm test`.

If you are running in Windows PowerShell and `npm` does not resolve correctly, configure PowerShell first so `npm` resolves to `npm.cmd`, then run the same non-elevated install command.

### Windows PowerShell

1. Create or edit `C:\Users\<your-user>\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`.
2. Add:

```powershell
Set-Alias -Name npm -Value npm.cmd -Scope Global
```

3. Allow user-level PowerShell profiles and local scripts:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

4. Reopen PowerShell so the profile is loaded.
5. Install dependencies:

```powershell
npm install --ignore-scripts
```

After reopening PowerShell, `npm` will resolve through `npm.cmd` instead of `npm.ps1`.

If you plan to type non-ASCII prompts such as Chinese directly into the agent on Windows PowerShell, also switch the console to UTF-8 before starting the REPL:

```powershell
chcp 65001
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
```

Without UTF-8 console encoding, PowerShell can turn non-ASCII input into `?` before it reaches Node. This is especially visible with `search_arxiv`, where a mangled query can trigger an arXiv HTTP 500 instead of a normal search.

### Other environments

```powershell
npm install --ignore-scripts
```

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
