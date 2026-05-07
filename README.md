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

Choose the setup guide for the shell where you will run the agent:

- Windows PowerShell or Codex Desktop on Windows: [docs/windows-powershell-codex-quickstart.md](docs/windows-powershell-codex-quickstart.md)
- Windows WSL Ubuntu or Codex in WSL: [docs/wsl-ubuntu-codex-quickstart.md](docs/wsl-ubuntu-codex-quickstart.md)

Use the normal install path if you want managed-browser paper tools to work without extra setup:

```sh
npm install
```

This lets Playwright install its managed browser during dependency setup. If you skip install scripts with `npm install --ignore-scripts`, normal build/test workflows still work, but `open_paper_page_for_login` and explicit Playwright paper fallback paths will require one of these before they can launch a browser session:

- set `PI_PAPER_CHROME_EXECUTABLE` to an existing local Chrome/Chromium executable
- install a Playwright browser separately, for example `npx playwright install chromium`

For supported publisher and other external `download_paper` URLs, set up the paper downloader extension below. arXiv direct downloads do not require the extension or Playwright.

## Run

Use environment variables in PowerShell:

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

Use environment variables in WSL/bash:

```sh
export OPENAI_API_KEY="your-key"
export PI_PROVIDER="openai"
export PI_MODEL="gpt-5.4"
export PI_SEARCH_API_URL="https://search.example.com/query"
export PI_SEARCH_API_KEY="your-search-key"
export PI_FETCH_USER_AGENT="pi-agent-minimal-ts/1.0"
export PI_FETCH_TIMEOUT_MS="10000"
npm run agent
```

Use CLI arguments:

```sh
npm run agent -- --provider openai --model gpt-5.4
```

Use an OpenAI-compatible proxy or relay:

```powershell
$env:OPENAI_API_KEY="your-proxy-key"
npm run agent -- --provider openai --model gpt-5.4 --base-url https://your-proxy.example.com/v1
```

```sh
export OPENAI_API_KEY="your-proxy-key"
npm run agent -- --provider openai --model gpt-5.4 --base-url https://your-proxy.example.com/v1
```

You can also set `PI_BASE_URL` instead of passing `--base-url`.

Exit the REPL with `exit` or `quit`.

## Paper Tools

Publisher and external `download_paper` URLs use the browser extension bridge by default when it is configured. The managed Playwright/browser session remains available for `open_paper_page_for_login` and explicit fallback paths. The manager owns the shared profile at `.browser-profile/paper-access/` and stores its localhost metadata at `.browser-profile/paper-access-manager.json`.

Supported publishers:

- `science.org`
- `nature.com`
- `journals.aps.org` / `aps.org`

### Extension-first paper downloads

Detailed setup and troubleshooting live in [docs/paper-downloader-extension.md](docs/paper-downloader-extension.md).

1. Run `npm run build`.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable Developer Mode.
4. Load unpacked extension from `browser-extension/paper-downloader`.
5. Copy the extension id.
6. Register the native host using the PowerShell or WSL instructions in [docs/paper-downloader-extension.md](docs/paper-downloader-extension.md).
7. Restart the browser.

Use the normal install path if you want `open_paper_page_for_login` or explicit Playwright fallback paths to start their browser automatically:

- keep Playwright's install scripts enabled during `npm install`
- or install a browser separately, for example `npx playwright install chromium`
- or set `PI_PAPER_CHROME_EXECUTABLE` to an existing local Chrome/Chromium executable before starting the agent

`open_paper_page_for_login` tries to reuse that same managed browser session. Stale manager metadata is recovered automatically: if the saved metadata points to a dead process or an unreachable localhost endpoint, the client clears it and starts a fresh manager. This is best-effort coordination rather than a hard lock against concurrent cold starts.

`open_paper_page_for_login` opens the article page in the managed browser session for manual login or verification and stops there.

`download_paper` handles three cases:

- arXiv IDs or arXiv URLs download directly into `knowledge-base/raw/pdfs/`
- supported publisher URLs on `science.org`, `nature.com`, and `journals.aps.org` / `aps.org` use the extension bridge when configured; without the bridge they return `extension_unavailable` unless an internal Playwright fallback is explicitly enabled
- unsupported external URLs also use the extension bridge when configured; without the bridge they return `extension_unavailable`

Before any arXiv, supported-publisher, or external URL action, the paper manager checks `knowledge-base/records/` for an existing `downloaded` record with a PDF file that still exists under `knowledge-base/raw/pdfs/`. When it finds one, it returns `already_downloaded` with the existing file path and skips the network or browser action. Manual fallback and plain `external_opened` records do not count as completed downloads.

For unsupported external URLs, use `register_manual_paper_download` after downloading the PDF manually. Give it the original external URL and a relative workspace path to the PDF, for example `downloads/inbox/paper.pdf`. The tool verifies the file is a PDF, copies it into `knowledge-base/raw/pdfs/`, records a SHA-256 hash, and updates the external index record to `downloaded` so future attempts for that URL return `already_downloaded`.

`search_papers` includes APS/Physical Review metadata from Crossref's `10.1103` DOI prefix alongside arXiv and web results. Use `download_paper` on one selected result's arXiv ID or article URL. This keeps discovery and download as separate steps, so APS browser verification or extension handoff affects only the paper you choose to download.

Successful downloads now use formatted filenames when possible, for example `science-10.1126-science.adz8659.pdf`, instead of always overwriting `downloaded-paper.pdf`. The tool still falls back to the source filename or `downloaded-paper.pdf` when it cannot derive a better name.

If you want to confirm that the managed session is already logged in before attempting a download, open the paper page first:

```text
Open this paper page with open_paper_page_for_login: https://www.science.org/doi/10.1126/science.adz8659
```

Example automatic download prompt:

```text
Download this paper with download_paper: https://www.science.org/doi/10.1126/science.adz8659
```

Example latest-paper workflow:

```text
Search papers about the latest superconducting quantum computing results with search_papers, then download the most relevant result with download_paper.
```

For manual verification, keep your own publisher test URLs in a local scratch file such as `paper_url.txt` or in your notes. This repository does not ship a tracked `paper_url.txt`. Check that each URL belongs to one of the supported hosts above, then set up the extension bridge, run the download, and confirm the automatic path writes the PDF under `knowledge-base/raw/pdfs/` with a publisher/article-derived filename when available.

### Paper LLM wiki

The reader now uses a compact three-layer literature wiki. By default it lives in local `knowledge-base/`, which is gitignored so the open-source code repository stays light. Set `PI_KNOWLEDGE_BASE_DIR=/absolute/path/to/knowledge-base` to move the library outside the code checkout, for example into a separate private knowledge repository or a large data volume.

```text
knowledge-base/
  raw/pdfs/                    # original PDFs for new downloads
  records/                     # download records
  wiki/
    index.md                   # knowledge-entry catalog over pages/
    log.md                     # knowledge-page operation log
    sources/<paper-key>.md     # LLM-authored retrieval source summary
    sources/<paper-key>/       # parsed PDF markdown, JSON, quality, chunks
    pages/                     # durable cross-paper topic synthesis pages
    manifests/                 # future machine-readable source manifests
    assets/
    state/
```

Use `download_paper` first to close the download loop and generate the preferred Markdown source under `wiki/sources/<paper-key>/parses/<engine>/document.md`. After reading and grounding the summary against the parsed text, use `write_paper_wiki_source` to save the final LLM-authored source page as `wiki/sources/<paper-key>.md`. Full mode also exposes `generate_paper_wiki_summary`, which builds a bounded evidence package from parsed Markdown, includes local related-paper candidates by default, and sends it to a clean-context summary worker before optionally writing the source page. `paper_wiki_relations` suggests related local papers and can write confirmed `related_papers` links into a source summary. Use `answer_research_question` for professional paper or topic Q&A; it checks local wiki evidence first, then searches/downloads/parses/summarizes external papers only when the local wiki is insufficient. Use `bootstrap_wiki_page_evidence` when a page does not exist yet: it generates seed queries, searches source summaries, expands through tags and related papers, searches parsed fallback text, and can generate missing source summaries. Use `build_wiki_page` when a question should become durable knowledge: it bootstraps source-summary evidence first, falls back to evidence-first research acquisition when needed, asks a clean-context page worker to synthesize the supplied wiki evidence, then writes `wiki/pages/<page-key>.md` with citations back to source summaries. Use `merge_wiki_aliases` for acronyms, plural forms, and duplicate concept names that should point to an existing canonical page instead of using generic file-write tools. Use `answer_paper_wiki_question` for local-wiki-only evidence checks, and `search_paper_wiki` in full mode for direct retrieval over both source summaries and synthesis pages. Use `wiki_lint` to check the markdown wiki structure: stale `index.md` entries, broken wiki links, missing source citations, orphan synthesis pages, and repeated source tags that should become durable topic pages.

### Local wiki web viewer

Use this command from the repository root to browse the local wiki and concept graph in a browser:

```sh
npm run wiki:web
```

Then open:

```text
http://localhost:4177/
http://localhost:4177/graph
```

The viewer reads `knowledge-base/wiki` by default. To serve another wiki directory or port, set `PI_WIKI_DIR` or `WIKI_PORT` before running the command. Operational details for another agent are in [docs/wiki-web-graph.md](docs/wiki-web-graph.md).

## Search And Fetch Configuration

Optional environment variables for web search and page fetch tools:

- `PI_SEARCH_API_URL`: HTTP endpoint used by `web_search`
- `PI_SEARCH_API_KEY`: optional bearer token sent to the search provider
- `PI_FETCH_USER_AGENT`: optional `User-Agent` header for `fetch_url`
- `PI_FETCH_TIMEOUT_MS`: optional timeout in milliseconds for both search and fetch requests
- `PI_PAPER_CLOUDFLARE_COOLDOWN_MS`: optional APS/Cloudflare cooldown window for internal APS fallback handling; defaults to 30 minutes

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
- `[tool:progress] ...`: long-running tool progress, including summary generation stages

Example interactive session:

```text
model> openai/gpt-5.4
> search papers about retrieval augmented generation
[tool:start] search_papers
[tool:end] search_papers ok
assistant> I found several relevant papers...
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

```sh
printf '%s\n' \
  "hello" \
  "read README.md and summarize it" \
  "exit" | npm run agent -- --provider openai --model gpt-5.4
```

In non-interactive mode:

- blank lines are ignored
- `exit` or `quit` stops the session cleanly
- stdin EOF ends the process without the old `ERR_USE_AFTER_CLOSE` readline failure

### RPC mode

The same agent can run as a JSONL RPC process for local bridges:

```sh
npm run agent:rpc -- --provider openai --model gpt-5.4 --session-dir .memory/pi-sessions/example
```

RPC mode reads one JSON command per stdin line and writes JSON events to stdout. It supports the prompt command used by the built-in Feishu bridge:

```json
{"type":"prompt","id":"cmd-1","message":"hello","streamingBehavior":"followUp"}
```

The process responds with `response`, streams `message_update` text deltas, and ends each prompt with `agent_end`.

## Feishu Bridge

This repository includes a Feishu long-connection bridge under `src/feishu-bridge/`. It receives Feishu messages, applies private-chat/group-mention rules, keeps per-chat memory under `.memory/`, forwards prompts into this agent's RPC mode, and sends streaming or final replies back to Feishu. Prompt history excludes the agent's previous replies by default so long answers are not fed back into the next turn; set `BRIDGE_INCLUDE_AGENT_MESSAGES_IN_HISTORY=true` to include them again.

Start it after configuring Feishu credentials and model env vars:

```sh
cp docs/feishu-bridge.env.example .env
npm run feishu-bridge
```

By default the bridge starts this repository's compiled agent with `node dist/src/pi-agent.js --mode rpc`. Set `PI_COMMAND` only if you want to target another compatible agent process.

Bridge-side repository management is handled as a shared managed-repo service rather than by individual agents. Use commands such as `repo status paper`, `repo commit design 更新说明`, and `repo push design`. Configure paper, design, and optional wiki repositories with `BRIDGE_PAPER_WORKSPACE_DIR`, `BRIDGE_DESIGN_WORKSPACE_DIR`, and `BRIDGE_WIKI_WORKSPACE_DIR`. Agents should produce code or artifacts in their workspaces, while the bridge repo manager handles status, commit, and push operations.

## Built-in Tools

The default chat agent exposes a compact paper-focused tool set:

- `list_files`: lists files and directories under a workspace path, including private local writing folders such as `paper-projects/`
- `read_file`: reads a UTF-8 text file inside the workspace; relative paths and workspace-absolute paths are accepted
- `write_file`: creates or overwrites workspace text files, but refuses `knowledge-base/wiki/pages/` synthesis pages; use `build_wiki_page` for evidence-grounded wiki page writes and `replace_file_text` for precise page edits
- `replace_file_text`: replaces a unique exact text block in a workspace file, including targeted edits to existing wiki pages
- `web_search`: searches the configured provider and returns JSON text for matching results
- `fetch_url`: fetches an HTML page and returns JSON text for the extracted content
- `search_papers`: searches arXiv, APS/Physical Review metadata, and configured web results, merges overlapping results, and classifies supported publishers versus external sources
- `download_paper`: downloads or queues a paper and owns the full reading-source pipeline; arXiv uses HTML webpage Markdown first with TeX source and PDF fallbacks, supported publishers use extension-captured webpage Markdown, and other PDFs are parsed after download
- `inspect_paper`: inspects parsed paper artifacts, parse quality, and section previews without returning the full paper body
- `read_paper_section`: reads bounded text from a parsed paper by section id or page range, with source element metadata
- `search_paper_text`: searches inside a parsed paper and returns snippets with page, section, and element metadata
- `answer_paper_wiki_question`: builds a citeable evidence package from local paper wiki source summaries and synthesis pages for scientific Q&A, or reports that the wiki lacks supporting wiki evidence
- `answer_research_question`: answers research-style questions through an evidence-first workflow: local wiki retrieval, local fallback inspection, external paper search, bounded download/parse/summary ingestion, then refreshed wiki evidence
- `bootstrap_wiki_page_evidence`: prepares evidence for a new topic page before pages exist, using multi-query source-summary search, related source expansion, parsed fallback matches, and optional missing-summary generation
- `build_wiki_page`: turns evidence-first research results into a durable topic synthesis page under `knowledge-base/wiki/pages/`
- `merge_wiki_aliases`: creates lightweight alias pages for acronyms, plurals, and duplicate concepts that should redirect to an existing canonical wiki page; refuses to overwrite existing synthesis pages unless explicitly requested
- `search_local_papers`: searches local paper records, parsed Markdown, and wiki summaries
- `wiki_health`: reports knowledge-base health across records, downloads, authorization state, parse quality, missing summaries, and missing artifacts
- `wiki_lint`: reports markdown wiki structure issues across `index.md`, source summaries, and synthesis pages
- `wiki_health_fix`: attempts health repairs such as retrying downloads, parsing downloaded records, and generating missing summaries through a clean-context summary worker when configured; reports issues that still need login or queued browser work

Development and diagnostics can use `createTools(workspaceDir, { toolProfile: "full" })` to expose the complete tool set. Full mode adds `get_time`, `write_paper_wiki_source`, `generate_paper_wiki_summary`, `paper_wiki_relations`, `search_paper_wiki`, `write_design_artifact`, `list_local_papers`, `fetch_paper_webpage`, `parse_paper`, `register_manual_paper_download`, and `open_paper_page_for_login`.

Agent or benchmark harnesses that need stricter separation can use `createToolsForBoundary(workspaceDir, role)`. It keeps the public `default` / `full` profiles unchanged while exposing role-specific tool surfaces:

- `wiki-agent`: local wiki search, page construction, alias management, wiki health/lint, and local paper search; it does not expose web search, paper download, or summary generation, and disables external evidence acquisition inside `build_wiki_page`
- `paper-download-subagent`: paper search/download, browser/manual fallback, webpage capture, parsing, and health repair; it does not expose wiki page or source-summary writers
- `wiki-evidence-worker`: builds and maintains the wiki evidence layer through `generate_paper_wiki_summary`, `write_paper_wiki_source`, and relation maintenance; it does not expose paper download or synthesis page tools
- `design-subagent`: minimal chip-design reasoning surface; it reads local wiki evidence and local paper metadata, then writes structured design artifacts under `knowledge-base/design-records/`; it does not expose web search, paper download, wiki page writes, source-summary generation, or arbitrary file writes
- `paper-writing-worker`: manuscript file reading/writing, LaTeX compilation, local wiki retrieval, and wiki-grounded Q&A for drafting scientific papers from the wiki evidence layer; it does not expose web search, paper download, source-summary generation, or wiki page writes

Recommended division of labor:

| Role | Responsibility | Reads | Writes | Must not do |
| --- | --- | --- | --- | --- |
| `wiki-agent` | Main coordinator for durable knowledge growth: decide needed pages, inspect wiki gaps, request evidence expansion, and maintain wiki structure | `wiki/sources`, `wiki/pages`, local paper metadata | `wiki/pages` through `build_wiki_page` and alias pages through `merge_wiki_aliases` | Direct web search, paper download, source-summary generation in benchmark/boundary mode |
| `paper-download-subagent` | Literature ingestion: search papers, download or queue publisher/browser work, register manual PDFs, capture webpages, parse downloaded records, and repair acquisition health | paper search results, records, raw PDFs/webpages, parse artifacts | `knowledge-base/records`, `knowledge-base/raw`, parse artifacts, extension job state | `wiki/pages` writes or source-summary authoring |
| `wiki-evidence-worker` | Build and maintain wiki evidence artifacts. Source-summary mode converts parsed papers into `wiki/sources`; page-synthesis mode turns fixed source evidence into a page draft for benchmarkable construction | parsed paper artifacts, local paper metadata, existing source summaries, or a fixed evidence package from the harness | `wiki/sources/<paper-key>.md`, `related_papers` fields, or page draft output returned to the caller | paper download, external search, or autonomous evidence acquisition |
| `design-subagent` | Minimal design slice for the paper: convert a chip-design request plus wiki evidence into a design record, verification report, failure record, or benchmark candidate | `wiki/sources`, `wiki/pages`, local paper metadata through retrieval tools | `knowledge-base/design-records/{design-records,verification-reports,failures,benchmark-cases}/*.md` through `write_design_artifact` | paper download, web search, wiki page construction, source-summary generation, arbitrary file writes |
| `paper-writing-worker` | Draft and revise scientific manuscripts using the wiki as the reference/evidence layer | manuscript files, `wiki/sources`, `wiki/pages`, wiki-grounded Q&A results | manuscript project files, compiled LaTeX outputs | paper download, source-summary generation, wiki page construction, or web search |

The intended workflow boundary is:

```text
paper-download-subagent -> wiki-evidence-worker -> wiki-agent -> design-subagent -> wiki-agent -> paper-writing-worker
records/raw/parses      -> wiki/sources/*.md     -> wiki/pages/*.md -> design records  -> curated wiki -> manuscript files
```

For model benchmarks, run the wiki evidence page-synthesis mode as a tool-free worker over fixed `wiki/sources` fixtures. Use `design-subagent` for the narrow reference-implementation slice where wiki evidence becomes a design proposal, verification/failure report, or benchmark candidate. Use `paper-writing-worker` when the goal is a manuscript draft or revision, so paper writing consumes the wiki and design artifacts instead of mutating the wiki knowledge layer.

For `search_papers`, concise English keyword queries still work best because the search stages include arXiv, APS/Crossref metadata, and the configured web provider.

OpenDataLoader PDF installation and verification notes are in [docs/opendataloader-pdf-install.md](docs/opendataloader-pdf-install.md). Docling fallback installation notes are in [docs/docling-pdf-install.md](docs/docling-pdf-install.md). Pandoc and LaTeXML installation notes are in [docs/pandoc-latexml-install.md](docs/pandoc-latexml-install.md).

`list_files` and `read_file` reject paths that resolve outside the workspace, including symlinks that escape the workspace.

Example prompts:

- `Search the web for the latest OpenAI API pricing updates and summarize the top 3 results.`
- `Fetch https://openai.com/api and extract the main text.`
- `Search papers about retrieval-augmented generation from the last few years and highlight which results are arXiv, supported publisher papers, or external sources.`
- `Download arXiv paper 2401.01234 with download_paper.`
- `Download this paper with download_paper: https://www.science.org/doi/10.1126/science.adz8659`
- `Search papers about the latest superconducting quantum computing results, then download the best open result with download_paper.`
- `Run wiki_health and tell me which papers need login, parsing, or summaries.`
- `Run wiki_lint and tell me which wiki pages or concepts need maintenance.`
- `Run wiki_health_fix in dry-run mode, then repair parse_missing and needs_download issues.`
- `Build a wiki page about qLDPC implementation challenges on superconducting chips.`
- Full mode: `Register the manually downloaded PDF for https://example.com/paper with register_manual_paper_download using downloads/inbox/paper.pdf.`

## Scripts

- `npm run build`: compile TypeScript to `dist/`
- `npm test`: run the automated test suite
- `npm run agent`: build and start the agent
- `npm run agent:rpc`: build and start the JSONL RPC agent
- `npm run feishu-bridge`: build and start the Feishu bridge
- `npm run doctor:approval`: diagnose Windows PowerShell Codex approval rules for routine Git commands
- `npm run doctor:approval -- --apply`: append missing safe approval rules without allowing broad `git` prefixes

## Test

```sh
npm test
```

## Notes

- conversation history is kept in memory only
- failed assistant turns are not persisted into the ongoing context
- full-mode `read_file` does not size-limit very large files yet, so it can still create memory pressure if misused
