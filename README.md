# pi-agent-minimal-ts

Minimal TypeScript research agent built on [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai) and [`@mariozechner/pi-agent-core`](https://www.npmjs.com/package/@mariozechner/pi-agent-core).

This repository is a practical agent harness for literature ingestion, local wiki growth, Feishu chat operation, and manuscript/design workflows. It is intentionally small at the runtime layer, but the tool boundaries are explicit so another agent can reuse it without guessing which component owns each capability.

## What It Does

- runs a multi-turn terminal chat / REPL agent
- runs the same agent as a JSONL RPC process for bridges
- exposes a Feishu long-connection bridge with streaming replies and per-chat memory
- searches, downloads, parses, summarizes, and indexes papers into a local knowledge base
- builds durable typed wiki pages from fixed evidence rather than one-off answers
- records claim-level provenance, typed page/source/experiment relations, experiment references, and reviewer-risk critique metadata on wiki pages
- maintains source manifests, operation journals, evidence contracts, and wiki governance diagnostics
- plans wiki-agent work with deterministic owner boundaries for acquisition, evidence construction, page writing, and blocked cases
- provides `design-projects/` as the recommended code workspace root for design subagent projects
- manages paper/design/wiki Git repositories through a bridge-side repo manager
- exposes isolated worker tool surfaces for wiki, evidence, download, design, and paper-writing workflows

## Architecture

The important boundary is:

```text
Feishu bridge / CLI / RPC
        |
        v
main chat agent / wiki-agent coordinator
        |
        +--> paper-download-subagent  -> acquisition files, PDFs, webpages, parses
        +--> wiki-evidence-worker     -> sources/*/summary.md and fixed-evidence page drafts
        +--> wiki-agent               -> pages/*.md and aliases
        +--> design-subagent          -> knowledge-base/design-records/*.md
        +--> paper-writing-worker     -> manuscript project files
        |
        +--> bridge repo manager      -> git status/diff/log/commit/push
```

### Feishu Bridge Boundary

The Feishu bridge is the chat transport and workflow trigger. It lives under `src/feishu-bridge/` and owns:

- receiving Feishu messages and applying private-chat / group-mention rules
- keeping per-chat memory under `.memory/`
- starting this agent in RPC mode, unless `PI_COMMAND` points at another compatible agent
- streaming or sending final replies back to Feishu
- sending downloaded or compiled PDFs back to chat when configured
- intercepting bridge commands such as `repo status paper` before the prompt reaches the agent

The bridge should not contain domain reasoning. It should route messages, collect tool progress, and call bridge-side services.

### Router Layer

The local chat/RPC runtime has a lightweight router layer before the default main-agent turn. It detects high-confidence worker intents and runs the requested turn in a clean worker context with the corresponding boundary tools:

- manuscript editing, writing-quality review, or LaTeX requests -> `paper-writing-worker`
- paper search, paper download, acquisition fallback, and citation-metadata repair requests -> `paper-download-subagent`
- evidence construction, paper summarization, and source-summary relation requests -> `wiki-evidence-worker`
- chip-design records, verification records, or design-failure cases -> `design-subagent`

Explicit prefixes are still supported when precision matters: `paper write ...`, `paper download ...`, `download paper ...`, `wiki evidence ...`, `evidence ...`, `design ...`, `/paper-writing-worker ...`, `/paper-download-subagent ...`, `/wiki-evidence-worker ...`, and `/design-subagent ...`. If no worker route matches, the prompt goes to the main wiki-agent coordinator.

Worker turns do not share the main agent's full context. The router runs each worker in a clean context, streams the worker's normal reply to the user, then injects a compact structured handoff back into the main context. The handoff records the worker role, instruction, route reason, status, changed files, produced artifacts, source/page/design-record paths, tools used, failed tools, final worker response, and the next suggested owner. This keeps the main chat history continuous without copying the worker's full tool transcript into the prompt.

### Repo Manager Boundary

The repo manager is a bridge-side service, not an LLM tool and not a worker. It owns controlled Git operations for configured workspaces:

- `repo status paper`
- `repo diff design`
- `repo log paper`
- `repo commit design 更新说明`
- `repo push design`

Configured repositories are `paper`, `design`, and optional `wiki`. The paper repository is configured with `BRIDGE_PAPER_WORKSPACE_DIR`; design and wiki use `BRIDGE_DESIGN_WORKSPACE_DIR` and `BRIDGE_WIKI_WORKSPACE_DIR`.

The recommended design workspace root is `design-projects/`. For the first chip-design workspace, point `BRIDGE_DESIGN_WORKSPACE_DIR` at `design-projects/superconducting-qubit-chip`. Keep executable design code there, and keep durable conclusions or failure records in `knowledge-base/design-records/`.

Automatic commit/push is still supported. When `BRIDGE_PAPER_GIT_AUTO_COMMIT=true`, the bridge snapshots the paper repo before an agent turn. If the repo was clean and the agent leaves changes, the bridge runs `git add -A` and commits with an `Auto paper update: ...` message. If `BRIDGE_PAPER_GIT_AUTO_PUSH=true`, it also pushes. If the repo was already dirty before the turn, automatic commit is skipped to avoid mixing user edits with agent edits.

Agents and workers should produce files. The repo manager decides when those files become Git commits.

### Wiki Agent Boundary

The wiki agent is the durable knowledge coordinator. It decides what concepts need pages, inspects gaps, requests evidence expansion, and maintains structure. In boundary mode it reads local wiki and local paper metadata, writes synthesis pages through `build_wiki_page`, and uses `wiki_lint` plus `wiki_structure_plan` plus `wiki_apply_structure_plan` for structural cleanup. Existing duplicate pages, including simple plural or compact spelling variants, should be merged and deleted rather than preserved as alias pages.

The current wiki core is schema-first:

- `workspace-contract.ts` defines the authoritative `knowledge-base/` lifecycle roots for raw inputs, source records, parse artifacts, summaries, pages, manifests, assets, runtime state, index, and human log.
- `page-schema.ts` and `typed-store.ts` parse, validate, list, and write human-editable Markdown pages with typed frontmatter. Supported page types include `paper-source`, `synthesis`, `concept`, `method`, `finding`, `dataset`, `question`, `design-record`, and `alias`.
- `page-schema.ts` also owns the wiki evidence-audit contract. Pages can carry `claims`, `typed_relations`, `experiment_refs`, and `reviewer_critique` metadata. Quantitative claims must point at concrete provenance such as a page, figure, table, parser element, chunk, or code-output path.
- `manifest-store.ts` and `retrieval-contract.ts` make source provenance and read-only downstream consumption explicit. Downstream agents can search/read wiki evidence without depending on the physical directory layout.
- `retrieval-search.ts` returns structured evidence matches, match reasons, preferred evidence-kind ordering, and insufficient-evidence status.
- `journal.ts` records multi-file wiki operations so interrupted writes can be reported by health checks.
- `coordinator.ts` plans wiki-agent work with explicit owner assignments such as `paper-download-subagent`, `wiki-evidence-worker`, `wiki-synthesis-worker`, and `wiki-agent`.
- `domain-bindings.ts` provides a metadata-only registry for validated executable helper bindings. Bindings are described in typed page metadata; arbitrary page content is not executed.

The wiki agent should not directly download papers, run web search, or author raw source summaries in benchmark/boundary mode. Those are assigned to subagents/workers so page construction can be benchmarked under fixed evidence. Clean-context paper-summary and wiki-page-draft passes are treated as `wiki-evidence-worker` responsibilities, not separate durable worker roles.

### Evidence Flow

The intended workflow is:

```text
paper-download-subagent -> wiki-evidence-worker -> wiki-agent -> design-subagent -> wiki-agent -> paper-writing-worker
acquisition/raw/parses  -> sources/*/summary.md + page drafts -> pages/*.md -> design records  -> curated wiki -> manuscript files
```

For model benchmarks, give workers fixed `sources` fixtures and evaluate page synthesis without allowing autonomous evidence acquisition.

## Usage Modes

### Feishu Bridge Mode

Use this for real chat operation, per-chat memory, PDF delivery, and repo manager commands.

```sh
cp docs/feishu-bridge.env.example .env
npm run feishu-bridge
```

The bridge starts `node dist/src/pi-agent.js --mode rpc` by default. Set `PI_COMMAND` only when the bridge should target another compatible RPC agent.

Common Feishu-side commands:

```text
repo status paper
repo diff paper
repo commit paper 更新论文草稿
repo push paper
repo status design
repo commit design 添加频率规划 demo
```

### Chat / REPL Mode

Use this for local interactive work:

```sh
export OPENAI_API_KEY="your-key"
export PI_PROVIDER="openai"
export PI_MODEL="gpt-5.4"
npm run agent
```

PowerShell equivalent:

```powershell
$env:OPENAI_API_KEY="your-key"
$env:PI_PROVIDER="openai"
$env:PI_MODEL="gpt-5.4"
npm run agent
```

You can also pass model settings as CLI arguments:

```sh
npm run agent -- --provider openai --model gpt-5.4
```

The REPL prints the selected model and waits for one prompt per line:

```text
model> openai/gpt-5.4
> search papers about retrieval augmented generation
[tool:start] search_papers
[tool:end] search_papers ok
assistant> I found several relevant papers...
> exit
```

The router automatically sends high-confidence worker requests to the matching isolated worker. For manuscript edits or writing-quality review, either ask naturally or prefix the request with `paper write` when you want an explicit route:

```text
> 同意，请你修改论文
[tool:start] load_paper_writing_skill
[tool:end] load_paper_writing_skill ok
...
[tool:start] compile_latex texPath=paper-projects/million-superconducting-qubits/manuscript/main.tex
[tool:end] compile_latex ok

> paper write 修改 paper-projects/million-superconducting-qubits/manuscript/main.tex，先加载 sciwrite 写作技能，润色摘要并重新编译
[tool:start] load_paper_writing_skill
[tool:end] load_paper_writing_skill ok
...
[tool:start] compile_latex texPath=paper-projects/million-superconducting-qubits/manuscript/main.tex
[tool:end] compile_latex ok
```

The paper-writing worker receives only the `paper-writing-worker` boundary tools: project-local writing skills, manuscript file edits, LaTeX compilation, local wiki retrieval, and wiki linting. It cannot download papers, run web search, build wiki pages, or create raw source summaries.

Other explicit worker routes:

```text
> paper download latest superconducting qubit chip design papers
> wiki evidence 总结 arxiv-2406.06015 并维护 related_papers
> design 为 transmon frequency allocation 写一个 failure record
```

Use `exit` or `quit` to stop. Conversation history is kept in memory for the current process only.

### Non-Interactive Chat

The agent accepts stdin input. Each non-empty line is one prompt:

```sh
printf '%s\n' \
  "hello" \
  "read README.md and summarize it" \
  "exit" | npm run agent -- --provider openai --model gpt-5.4
```

Blank lines are ignored. EOF ends the process cleanly.

### RPC Mode

Use this when another local bridge or harness wants to drive the same agent process:

```sh
npm run agent:rpc -- --provider openai --model gpt-5.4 --session-dir .memory/pi-sessions/example
```

RPC mode reads one JSON command per stdin line and writes JSON events to stdout:

```json
{"type":"prompt","id":"cmd-1","message":"hello","streamingBehavior":"followUp"}
```

It responds with `response`, streams `message_update` deltas, and ends each prompt with `agent_end`.

### Local Wiki Web Viewer

Use this to browse the local wiki and concept graph:

```sh
npm run wiki:web
```

Then open:

```text
http://localhost:4177/
http://localhost:4177/graph
```

The viewer reads `knowledge-base` by default. Set `PI_WIKI_DIR` or `WIKI_PORT` to change the wiki directory or port. Operational details are in [docs/wiki-web-graph.md](docs/wiki-web-graph.md).

The graph endpoint prefers typed page metadata from `typed_relations` when present. Edge types include `supports`, `contradicts`, `extends`, `uses`, `baseline_of`, `open_problem_for`, and `implementation_of`; legacy `related_pages` remains readable as a fallback.

## Built-In Tools

The default chat agent exposes a compact tool profile. Development and benchmarks can use `createTools(workspaceDir, { toolProfile: "full" })` for the full profile, or `createToolsForBoundary(workspaceDir, role)` for role-isolated worker surfaces.

### Workspace Tools

- `list_files`: lists files and directories under the workspace
- `read_file`: reads bounded UTF-8 text-file segments inside the workspace; use `offsetBytes` / `maxBytes` and the returned `nextOffsetBytes` to page through large files
- `write_file`: writes workspace text files, but refuses `knowledge-base/pages/`; use `build_wiki_page` for durable wiki pages
- `replace_file_text`: replaces a unique exact text block, useful for precise edits to existing files and wiki pages
- `delete_file`: deletes a workspace text, script, or LaTeX-related file after path-safety checks
- `compile_latex`: compiles a LaTeX project file and reports the output PDF or build errors

These tools reject paths that resolve outside the workspace, including escaping symlinks.

### Web Tools

- `web_search`: searches the configured search provider
- `fetch_url`: fetches a URL and extracts useful page text

These are general web tools. In strict wiki-agent benchmark mode they are not exposed, because evidence acquisition should be fixed or delegated.

### Paper Search And Download Tools

- `search_papers`: searches arXiv, APS/Physical Review metadata, and configured web results; merges duplicates and classifies supported publisher versus external sources
- `download_paper`: downloads or queues a paper and owns the reading-source pipeline
- `block_paper_download`: records a known blocked or unavailable paper so health checks can downgrade repeated download failures
- `register_manual_paper_download`: full-mode tool for registering a manually downloaded external PDF
- `open_paper_page_for_login`: full-mode tool for opening a publisher page in the managed browser session for manual login or verification
- `fetch_paper_webpage`: full-mode tool for fetching and storing webpage reading artifacts

`download_paper` handles:

- arXiv IDs or URLs: direct download / arXiv HTML parsing path
- supported publishers: `science.org`, `nature.com`, `journals.aps.org`, `aps.org`
- unsupported external URLs: extension bridge when configured, otherwise explicit manual registration

Publisher and external URLs use the browser extension bridge by default when configured. arXiv direct downloads do not require the extension.

### Paper Reading Tools

- `inspect_paper`: inspects parsed artifacts, parse quality, and section previews
- `read_paper_section`: reads bounded text by section id or page range
- `search_paper_text`: searches inside a parsed paper and returns snippets with page, section, and element metadata
- `parse_paper`: full-mode tool for parsing a downloaded PDF or webpage artifact
- `list_local_papers`: full-mode listing of local paper acquisition files and parsed artifacts
- `search_local_papers`: searches local acquisition files, parsed Markdown, and wiki summaries

### Wiki And Research Tools

- `answer_paper_wiki_question`: local-wiki-only Q&A over wiki source summaries and synthesis pages
- `answer_research_question`: evidence-first research workflow; checks local wiki first, then acquires external evidence only when needed. Tool details include `evidenceStatus`, local/new evidence items, limitations, and a coordination plan explaining which worker owns each step.
- `bootstrap_wiki_page_evidence`: prepares source evidence for a new topic page before a page exists, reports missing summaries, and returns coordination metadata for fixed-evidence page construction.
- `build_wiki_page`: writes durable synthesis pages under `knowledge-base/pages/` from local source-summary evidence. It supports explicit evidence contracts, minimum source counts, required source keys, external-evidence blocking, optional write-after lint verification, page-worker draft generation, and coordination metadata.
- `merge_wiki_aliases`: creates deliberate alias pages for acronyms or synonyms that are not existing duplicate pages. Existing duplicate pages, including simple plural or compact spelling variants, should instead go through `wiki_lint`, `wiki_structure_plan`, and `wiki_apply_structure_plan` so the redundant page is merged and deleted.
- `clarify_research_topic`: turns an ambiguous research request into concrete subtopics and evidence needs
- `research_topic_bootstrap`: creates an initial evidence plan for a research topic
- `expand_research_topic`: expands a topic through discovered gaps and related references
- `search_paper_wiki`: full-mode direct retrieval over source summaries and synthesis pages. Search uses structured wiki evidence scoring before falling back to legacy body search for weak matches.
- `write_paper_wiki_source`: full-mode source-summary writer
- `generate_paper_wiki_summary`: full-mode clean-context source summary generation
- `paper_wiki_relations`: full-mode relation discovery and `related_papers` maintenance

The key distinction is that `sources/*/summary.md` are evidence summaries for individual papers, while `pages/*.md` are durable typed cross-paper knowledge pages. Source manifests under `manifests/` tie wiki-facing summaries back to acquisition records, parser artifacts, quality reports, hashes, tags, and status.

Wiki pages may also include evidence-audit metadata:

- `claims`: per-claim provenance records. Quantitative claims require concrete original-location or code-output evidence.
- `typed_relations`: typed graph edges to pages, sources, experiments, or code, with candidate/confirmed/rejected status.
- `experiment_refs`: workspace-relative local scripts, commands, logs, result files, and artifacts that support or test a page.
- `reviewer_critique`: structured critique items for likely reviewer objections and the suggested fix.

This v0 is deterministic schema and lint support. It does not run background freshness checks, poll arXiv/publishers/GitHub on a schedule, or execute third-party paper repositories automatically.

### Wiki Maintenance Tools

- `wiki_health`: reports acquisition state, downloads, authorization state, parse quality, incomplete `source.json` citation metadata, missing summaries, missing artifacts, missing source manifests, unsafe or missing manifest artifact paths, malformed typed wiki pages, weak evidence contracts, and interrupted wiki operations.
- `wiki_health_fix`: orchestrates supported repairs. Download and citation-metadata repairs go through the paper-download-subagent boundary; citation refresh first reuses local parse artifacts, then uses arXiv/Crossref metadata when an identifier is available. Parsing stays in the ingestion path; missing summaries go through the `wiki-evidence-worker` summary pass; missing source manifests can be backfilled from existing source summaries.
- `wiki_lint`: checks wiki structure, source-to-page coverage, repeated concept gaps, evidence-contract gaps, typed `source_refs`, semantic alias candidates, low-risk singular/plural or compact-spelling duplicate page merge candidates, existing simple alias pages that should be deleted, medium-risk source-backed contained-concept duplicate candidates, scope drift, stale index entries, broken links, missing citations, orphan pages, duplicate titles, repeated sections, weak uncited pages, rendered wiki-link failures, ready source summaries not covered by synthesis pages, missing quantitative claim provenance, unresolved contradiction candidates, legacy `related_pages` without typed relations, broken experiment references, and code-backed pages without experiment refs. Goal/focus options can prioritize concept gaps for a current research direction. Default issue display is capped per issue kind before applying the final response-size cap, so many concept gaps cannot hide duplicate-page cleanup candidates.
- `wiki_structure_plan`: turns `wiki_lint` findings into a reviewable, budgeted, goal-aware maintenance plan with owner, risk, recommended tool args, and verification actions. It suggests low-risk actions by default, including deterministic duplicate concept-page merges such as singular/plural page pairs and compact spellings like `su2`/`su-2`, and does not rewrite wiki content. Its `maxItems` cap limits primary maintenance actions; verification actions are appended separately so they do not displace cleanup work.
- `wiki_apply_structure_plan`: applies approved low-risk `wiki_structure_plan` actions with dry-run, preflight, journal, and verification safeguards. Supported writes are deterministic duplicate-section cleanup, safe duplicate-page merge and deletion with inbound-link rewrites, cleanup of existing simple alias pages, safe deliberate alias creation, deterministic index rebuild, and constrained `## Scope Note` updates.

### Wiki Evidence Tools

- `generate_paper_wiki_summary`: builds a bounded evidence package from parsed paper Markdown and sends it through the `wiki-evidence-worker` summary pass
- `write_paper_wiki_source`: writes grounded per-paper source summaries under `sources/*/summary.md`
- `paper_wiki_relations`: proposes or applies related-paper links among local source summaries

`paper-summary-worker` and `wiki-page-worker` are not separate runtime roles. Their clean-context behavior is implemented as `wiki-evidence-worker` subtasks: one summary pass for per-paper evidence and one fixed-evidence page-draft pass used by the wiki agent before final page promotion.

### Design And Paper-Writing Tools

- `write_design_artifact`: full-mode / design-subagent tool that writes structured design records, verification reports, failure records, and benchmark cases under `knowledge-base/design-records/`
- `load_paper_writing_skill`: full-mode / paper-writing-worker tool that loads worker-scoped writing prompt modules such as `skills/paper-writing-worker/sciwrite/prompt.md`
- paper-writing-worker tools: project-local writing skill loading, manuscript file reading/writing, LaTeX compilation, local wiki retrieval, and wiki-grounded Q&A
- `get_time`: full-mode diagnostic tool for checking the current local time

The design subagent records design reasoning and verification artifacts. The wiki agent later curates stable lessons from those artifacts into durable wiki pages.

Design code should live under `design-projects/`, usually in a project-specific directory such as `design-projects/superconducting-qubit-chip/`. The current design-subagent boundary only exposes `write_design_artifact`; adding direct code-writing tools for design projects should be a deliberate follow-up change.

### Tool Profiles And Worker Boundaries

| Surface | Purpose | Exposes | Does not expose |
| --- | --- | --- | --- |
| `default` | normal chat agent | compact file, web, paper, wiki, health tools | full diagnostics and raw source writers |
| `full` | development and diagnostics | all default tools plus raw paper/wiki/design utilities | no extra filesystem escape permissions |
| `wiki-agent` | durable knowledge coordinator | local wiki search, page construction, aliases, wiki health/lint, local paper search | web search, paper download, source-summary generation |
| `paper-download-subagent` | literature acquisition | search/download, browser/manual fallback, webpage capture, local-parse/arXiv/Crossref citation metadata refresh, parsing, health repair | wiki page writes, source-summary authoring |
| `wiki-evidence-worker` | evidence construction | source summaries, relation maintenance, fixed-evidence page draft output | paper download, external search, autonomous acquisition |
| `design-subagent` | minimal chip-design reasoning | local wiki/paper retrieval, `write_design_artifact` | web search, paper download, wiki page writes, arbitrary file writes |
| `paper-writing-worker` | manuscript writing | project-local writing skills, manuscript read/write, LaTeX compile, wiki retrieval/Q&A | paper download, source-summary generation, wiki page construction, web search |

Use the boundary APIs in benchmarks so each model is evaluated under the same tool surface.

The main wiki/research tools also return compact coordination metadata. This is meant for agents and bridge logs: it records the detected intent, the decision path, ordered steps, worker owners, blocked/insufficient-evidence reasons, and the suggested next owner. `wiki-synthesis-worker` is a logical owner label for synthesis/page-writing steps, not a separate router prefix or durable runtime role. Coordination metadata is not a replacement for the worker boundary; it is an audit trail for why the boundary was chosen.

## Knowledge Base Layout

By default the local knowledge base lives in `knowledge-base/`, which is gitignored. Set `PI_KNOWLEDGE_BASE_DIR=/absolute/path/to/knowledge-base` to move it into a private knowledge repository or large data volume.

```text
knowledge-base/
  raw/pdfs/                         # original PDFs
  design-records/
    design-records/
    verification-reports/
    failures/
    benchmark-cases/
  index.md                          # knowledge-entry catalog over pages/
  log.md                            # page operation log
  sources/<paper-key>/
    summary.md                      # LLM-authored paper source summary
    source.json                     # identity and citation metadata
    acquisition.json                # download, access, parse, and reading state
    parses/                         # parsed markdown, JSON, and quality reports
    chunks/                         # searchable reading chunks
  pages/                            # durable cross-paper topic pages
  manifests/                        # wiki-facing source provenance manifests
  assets/
  state/
    wiki-operations.jsonl           # operation journal for multi-file wiki writes
```

Typed wiki pages remain normal Markdown files with frontmatter, so humans can edit them directly. The typed store validates the metadata and reports malformed or weak-evidence pages through `wiki_health` / `wiki_lint` instead of making every read fail.

Evidence-audit metadata is stored in the same page frontmatter. Use workspace-relative paths in `experiment_refs`; absolute paths and `..` escapes are rejected by the schema validator. Use `typed_relations` for graph semantics and keep `related_pages` only as legacy compatibility.

## Design Project Layout

Design code workspaces live outside the knowledge base:

```text
design-projects/
  README.md
  superconducting-qubit-chip/
    README.md
    pyproject.toml
    src/pi_chip_design/
```

Use `design-projects/` for executable design code, Python package modules, simulations, generated-layout scripts, and project-local tests. Use `knowledge-base/design-records/` for structured design evidence that should feed the data flywheel back into the wiki.

The initial design workspace is the `pi_chip_design` Python package under `design-projects/superconducting-qubit-chip/`. It should hold reusable layout-generation and verification code, with layout families added under `src/pi_chip_design/layouts/`. Its local development setup is:

```sh
cd design-projects/superconducting-qubit-chip
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e ".[dev]"
```

Recommended paper-to-wiki path:

```text
download_paper -> parse/read artifacts -> generate/write_paper_wiki_source -> source manifest -> build_wiki_page -> wiki_lint/wiki_health
```

## Paper Downloader Extension

Detailed setup and troubleshooting live in [docs/paper-downloader-extension.md](docs/paper-downloader-extension.md).

1. Run `npm run build`.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable Developer Mode.
4. Load unpacked extension from `browser-extension/paper-downloader`.
5. Copy the extension id.
6. Register the native host using the PowerShell or WSL instructions in [docs/paper-downloader-extension.md](docs/paper-downloader-extension.md).
7. Restart the browser.

The extension-first path is used for supported publisher and external `download_paper` URLs. The managed Playwright/browser session remains available for `open_paper_page_for_login` and explicit fallback paths. The shared profile is `.browser-profile/paper-access/`, and manager metadata is `.browser-profile/paper-access-manager.json`.

If Playwright install scripts were skipped, set `PI_PAPER_CHROME_EXECUTABLE` to an existing Chrome/Chromium executable or run `npx playwright install chromium`.

## Configuration

### Model And Endpoint

```sh
export OPENAI_API_KEY="your-key"
export PI_PROVIDER="openai"
export PI_MODEL="gpt-5.4"
```

OpenAI-compatible proxy / relay:

```sh
export OPENAI_API_KEY="your-proxy-key"
export PI_BASE_URL="https://your-proxy.example.com/v1"
npm run agent -- --provider openai --model gpt-5.4
```

You can also pass `--base-url` on the CLI.

### Search And Fetch

- `PI_SEARCH_API_URL`: HTTP endpoint used by `web_search`
- `PI_SEARCH_API_KEY`: optional bearer token for the search provider
- `PI_FETCH_USER_AGENT`: optional `User-Agent` header
- `PI_FETCH_TIMEOUT_MS`: timeout in milliseconds
- `PI_PAPER_CLOUDFLARE_COOLDOWN_MS`: APS/Cloudflare cooldown window for internal APS fallback handling

Search provider contract:

```json
{
  "query": "latest pi-ai release notes",
  "maxResults": 5
}
```

Response:

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

### Feishu And Repo Manager

Start from [docs/feishu-bridge.env.example](docs/feishu-bridge.env.example). Core variables:

- `FEISHU_APP_ID`, `FEISHU_APP_SECRET`: required Feishu credentials
- `BRIDGE_PAPER_WORKSPACE_DIR`: paper repository path
- `BRIDGE_DESIGN_WORKSPACE_DIR`: design repository path
- `BRIDGE_WIKI_WORKSPACE_DIR`: optional wiki repository path
- `BRIDGE_PAPER_GIT_AUTO_COMMIT`: enable paper auto commit after clean agent turns
- `BRIDGE_PAPER_GIT_AUTO_PUSH`: push after automatic paper commits
- `BRIDGE_INCLUDE_AGENT_MESSAGES_IN_HISTORY`: include prior assistant replies in prompt history; default is false

## Install

Choose the setup guide for your shell:

- Windows PowerShell or Codex Desktop on Windows: [docs/windows-powershell-codex-quickstart.md](docs/windows-powershell-codex-quickstart.md)
- Windows WSL Ubuntu or Codex in WSL: [docs/wsl-ubuntu-codex-quickstart.md](docs/wsl-ubuntu-codex-quickstart.md)

Normal install:

```sh
npm install
```

If you run `npm install --ignore-scripts`, build/test still work, but browser tools need an existing Chrome/Chromium path or a separate Playwright browser install.

## Scripts

- `npm run build`: compile TypeScript to `dist/`
- `npm test`: run the automated test suite, including compiled TypeScript tests and script-level `.mjs` tests
- `npm run agent`: build and start the terminal chat / REPL agent
- `npm run agent:rpc`: build and start the JSONL RPC agent
- `npm run feishu-bridge`: build and start the Feishu bridge
- `npm run wiki:web`: serve the local wiki and graph viewer

## Test

```sh
npm test
```

## Supporting Docs

- [docs/code-architecture.md](docs/code-architecture.md)
- [docs/paper-downloader-extension.md](docs/paper-downloader-extension.md)
- [docs/wiki-web-graph.md](docs/wiki-web-graph.md)
- [docs/opendataloader-pdf-install.md](docs/opendataloader-pdf-install.md)
- [docs/docling-pdf-install.md](docs/docling-pdf-install.md)
- [docs/pandoc-latexml-install.md](docs/pandoc-latexml-install.md)

## Notes

- conversation history is kept in memory only for local REPL sessions
- failed assistant turns are not persisted into the ongoing context
- `read_file` uses bounded paged reads by default and reports truncation metadata so agents can recognize when a file needs another page or a search-oriented workflow
