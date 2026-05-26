# Code Architecture

This document is for maintainers preparing refactors. It focuses on production code under `src/**`, and adds entrypoint, test-map, browser-extension, script, and knowledge-base integration notes. It does not explain `dist/**`, `node_modules/**`, downloaded artifacts, historical reports, or paper-project content file by file.

## System Architecture

The runtime layer is intentionally thin. The real boundaries are between the two public agent entrypoints, the agent runtime, tool assembly, paper, wiki, design-code, browser, and Feishu subsystems:

```text
Feishu bridge
        |
        +--> wiki-agent RPC only
                  |
                  +--> paper acquisition, parsing, local library
                  +--> schema-first wiki pages and evidence governance
                  +--> paper-writing-worker for manuscript files
                  +--> read-only curation of design-agent outputs

Local CLI / local harness
        |
        +--> wiki-agent CLI/RPC      -> wiki and paper knowledge boundary
        +--> design-agent CLI/RPC    -> design code, uv deps, layout scripts, records
        +--> tool registry           -> boundary-filtered tool profiles
        +--> bridge repo manager     -> configured Git workspaces only
```

Core principles:

- `src/wiki-agent.ts` and `src/design-agent.ts` are the public CLI/RPC wrappers. They fix the wiki/paper and design/code work boundaries respectively. `src/agent/agent-cli.ts` owns the local CLI/RPC process shape, and `src/agent/agent-runtime.ts` owns a single agent turn.
- `src/agent/agent-routing.ts` keeps internal routed-agent compatibility and detects `paper-download-subagent`, `wiki-evidence-worker`, or `paper-writing-worker` inside the wiki/paper flow. Public design/code/dependency/layout/verification work should enter through `design-agent`, not through generic entrypoint inference and not through the Feishu default wiki-agent.
- `src/agent/tools.ts` is the tool assembly center. It groups domain tool factories into default/full tool profiles. Worker-visible allowlists live in `src/agent/tool-types.ts`.
- `wiki-agent` can update wiki pages, aliases, paper-backed knowledge records, and read design records, design-artifact manifests, and layout results produced by design-agent. It does not edit `design-repo/design-code/`, install Python packages, or run layout scripts. Design artifacts do not enter `knowledge-base/sources/`; when promoted into the wiki they should be condensed into `knowledge-base/pages/` knowledge entries with citations to `design-repo/` assets.
- `design-agent` can edit `design-repo/design-code/`, declare dependencies, run `uv sync` into the root `.venv`, verify Python imports, run sandboxed layout/verification scripts, and write design records. It can only read wiki/paper evidence; it cannot write wiki pages, download papers, or use web search tools.
- Paper capability has three layers: search/download in `paper-manager.ts` and `paper-download.ts`, durable records in `paper-store.ts`, and parsing/reading in `paper-reader/**`.
- The paper tool adapter layer is `src/agent/paper/tools.ts`, colocated with paper-domain services.
- Wiki capability is concentrated in `src/agent/wiki/**`. `workspace-contract.ts`, `page-schema.ts`, `typed-store.ts`, `manifest-store.ts`, `retrieval-contract.ts`, `retrieval-search.ts`, `page-templates.ts`, `journal.ts`, and `coordinator.ts` are the schema-first core. `content.ts`, `bootstrap.ts`, `lint.ts`, `review.ts`, `summary.ts`, `relations.ts`, and `health.ts` are domain services. `wiki/tools.ts` is the agent tool adapter. `wiki/worker.ts` hosts the clean-context evidence worker. Knowledge state, last-reviewed freshness, claim-level provenance, typed relations, experiment refs, and reviewer critique belong to the typed page contract in `page-schema.ts`; they are not a separate agent.
- The browser extension is not part of the agent runtime. The agent writes jobs through `paper-extension-bridge.ts`. The browser calls the native host in `paper-extension-host.ts`, which registers downloads or webpage snapshots back into the local library.
- The Feishu bridge under `src/feishu-bridge/**` owns transport, queues, memory, PDF delivery, and repo commands. It should not contain scientific reasoning.

## Runtime Entrypoints

`package.json` scripts map to production entrypoints as follows:

| Command | Entrypoint | Notes |
| --- | --- | --- |
| `npm run build` | `tsc -p tsconfig.json` | Compiles all `src/**` and `test/**` TypeScript. |
| `npm test` | `npm run build && node --test ...` | Builds first, then runs `dist/test/**/*.test.js` and `test/scripts/**/*.test.mjs`. |
| `npm run wiki-agent` | `src/wiki-agent.ts` -> `src/agent/agent-cli.ts` | Starts wiki/paper REPL/chat after build; can update wiki pages and paper-backed knowledge records and can read design-agent outputs. |
| `npm run wiki-agent:rpc` | `src/wiki-agent.ts --mode rpc` -> `src/agent/agent-cli.ts` | JSONL RPC wiki-agent; the Feishu bridge connects here by default. |
| `npm run design-agent` | `src/design-agent.ts` -> `src/agent/agent-cli.ts` | Starts design/code/dependency/layout/verification REPL/chat after build; manages `design-repo/design-code/` and the root `.venv`, can retrieve wiki/local paper evidence, and cannot write wiki pages. |
| `npm run design-agent:rpc` | `src/design-agent.ts --mode rpc` -> `src/agent/agent-cli.ts` | JSONL RPC design-agent for local harnesses or future direct integrations; not the Feishu default target. |
| `npm run feishu-bridge` | `src/feishu-bridge/index.ts` | Starts the Feishu long-connection bridge and starts or reuses the configured RPC agent. |
| `npm run wiki:web` | `scripts/wiki-web.mjs` | Local wiki and graph browser. It is outside `src/**`, reads `knowledge-base`, and prefers typed wiki relations for graph data. |
| `npm run paper-extension-host` | `src/paper-extension-host.ts` -> `src/agent/paper/extension/paper-extension-host.ts` | Node entrypoint for the browser native messaging host. |

`npm run agent` and `npm run agent:rpc` are intentionally not public scripts. The old `src/pi-agent.ts` remains only as a compatibility wrapper/export surface. User docs should point to `wiki-agent` or `design-agent`.

Entrypoint capability boundaries:

| Boundary | Main owner | May write | Read-only inputs | Explicitly forbidden |
| --- | --- | --- | --- | --- |
| `wiki-agent` | durable wiki / paper knowledge coordinator | `knowledge-base/pages/`, aliases, paper source/page indexes, wiki operation journal, manuscript files through paper-writing worker | local paper library, source summaries, typed pages, design records/artifact summaries/manifests | design-code edits, Python dependency sync, layout script execution |
| `design-agent` | executable design-code and layout engineering owner | `design-repo/design-code/`, `design-repo/design-records/`, declared design-code outputs | local wiki retrieval, local paper retrieval, root `.venv` interpreter state | wiki page writes, paper downloads, web search, arbitrary workspace file writes |
| Feishu bridge | chat transport and repo command host | `.memory/`, bridge logs/cards, configured repo Git operations | Feishu events, agent RPC events, configured workspace state | domain reasoning, direct design-agent connection by default |

`design-subagent` is only a compatibility alias retained in `src/agent/tool-types.ts`. Public docs and handoff records should use `design-agent`.

Top-level entrypoint files:

- `src/wiki-agent.ts`: public wiki-agent CLI/RPC wrapper that fixes the wiki/paper prompt, tool boundary, and Feishu target behavior.
- `src/design-agent.ts`: public design-agent CLI/RPC wrapper that fixes the design prompt and design-agent tool boundary. It is the entrypoint for package install, layout code, GDS generation, and verification scripts, not the Feishu default target.
- `src/pi-agent.ts`: compatibility direct-run wrapper and export surface. It re-exports prompts, routing, runtime, and CLI helpers, and tests use it for routing and REPL behavior. It is not a public npm script.
- `src/index.ts`: package public export surface for tests, scripts, or external reuse. Decide whether a production module belongs here before exporting it.
- `src/paper-extension-host.ts`: very thin native-host entrypoint that only calls `runPaperExtensionNativeHost` from the paper-domain extension subtree.

## Core Data Flows

### Normal Chat

1. `src/wiki-agent.ts` or `src/design-agent.ts` calls `main()` from `agent-cli.ts`, fixing the wiki/paper or design/code tool profile.
2. `agent-cli.ts` parses provider/model/session options, creates `AgentContext`, and passes user input to `runSessionPrompt()`. RPC mode also enters through those public wrappers.
3. If `agent-runtime.ts` does not hit a worker route, it creates runtime tools with `createTools()`, runs `agentLoop()`, and persists non-failed turns back into context.
4. The REPL emits message/tool events through `createReplEventHandler()` and refreshes paper-download queue stats at the end.

`src/pi-agent.ts` only remains for legacy direct-run integrations and exports. It is not a public chat/RPC entrypoint.

### Worker Routing

1. `agent-runtime.ts` calls `routeChatPromptToWorker()`.
2. If a route matches, `runRoutedWorkerPrompt()` creates an isolated tool surface and clean context with `createToolsForBoundary()`.
3. The worker's normal response streams directly to the user. Then `createWorkerHandoffMessage()` compresses changed paths, artifacts, and tool status back into main context.
4. Failed worker turns are not written into main context, avoiding later reasoning contamination.

### Paper Download

1. The `search_papers` tool enters `paper/tools.ts` and normally calls `searchPapers()` in `paper-manager.ts`, combining arXiv, APS, and generic web search.
2. The `download_paper` tool calls `downloadPaper()` in `paper-manager.ts`. It checks blocklist and local records first, then selects arXiv direct download, supported publisher download, extension job, or manual login by source.
3. Low-level publisher download logic lives in `paper-download.ts`; Science/Nature/APS recognition lives in `publisher-adapters/**`.
4. `paper-store.ts` writes download results into `knowledge-base/raw/pdfs` and acquisition/source metadata under `knowledge-base/sources/<paper-key>/`.
5. When the browser extension is needed, `paper-extension-bridge.ts` writes queue events. Later, `paper-extension-host.ts` registers PDF bytes, download paths, or webpage snapshots.

### Paper Parsing

1. The `parse_paper` tool enters `paper/tools.ts` and normally calls `paper-reader/paper-reader.ts`.
2. `paper-reader-store.ts` locates PDFs, cache directories, and parse artifacts.
3. `paper-reader.ts` selects the engine: OpenDataLoader, Docling, TeX source, webpage, or plain-text baseline.
4. `quality.ts` scores parse quality, and `chunks.ts` generates retrieval chunks.
5. `paper-store.ts` writes the parse manifest, reading failure, or queued reading status back into the paper record.

### Wiki Construction

1. `search_paper_wiki`, `write_paper_wiki_source`, `build_wiki_page`, `answer_research_question`, and related tools live in `src/agent/wiki/tools.ts`.
2. `wiki/workspace-contract.ts` defines authoritative `knowledge-base/` lifecycle roots. `wiki/store.ts` keeps compatibility path helpers and delegates gradually to the workspace contract.
3. `wiki/page-schema.ts` and `wiki/typed-store.ts` parse, validate, list, and write typed Markdown pages. Bad frontmatter should produce diagnostics rather than breaking the whole library. Evidence-audit metadata is also validated here: `knowledge_state`, `last_reviewed_at`, `freshness_audit`, `claims`, `typed_relations`, `experiment_refs`, and `reviewer_critique`. Stable knowledge-state values are `established`, `promising_unverified`, `speculative`, and `disputed`.
4. `wiki/manifest-store.ts` writes/backfills source manifests for source summaries. V2 manifests use `sourceKind` and `sourceKey` for papers plus non-paper evidence such as material databases, software docs, standards, vendor notes, lab notes, code output, webpages, and manual sources. Reads must verify that the manifest filename key matches the internal `sourceKey`. Design artifact source/manifest records belong under `design-repo/`, not as a wiki source kind.
5. `wiki/retrieval-contract.ts` provides the read-only evidence API, merging source summaries, manifests, typed pages, knowledge state, review date, claim provenance, typed relations, experiment refs, and reviewer critique into downstream evidence items. Bad manifests or identity mismatches can only return diagnostics; they must not propagate internal keys as trusted references.
6. `wiki/retrieval-search.ts` performs structured evidence search, scoring title/alias/tag/source_ref/body plus typed claims and relations. It returns match reasons, freshness/knowledge-state warnings, and insufficient-evidence status. `content.ts` uses it first in `searchPaperWiki()` and falls back to old body search when needed. The public `search_paper_wiki` tool passes `sourceKinds`, `pageTypes`, `claimKinds`, `knowledgeStates`, `evidenceContracts`, and `maxEvidenceAgeDays` into this layer.
7. `wiki/page-templates.ts` infers concept/method/finding/dataset/capability-boundary/design-record templates from query and `sourceKind`, then gives required-section guidance to the page worker. `build_wiki_page` validates required sections before writing in write mode and returns `needs_worker` if sections are missing. Page synthesis uses `wiki/evidence-pack.ts` to pass candidate source summaries, selected raw chunks, claim provenance, and contradiction notes as a fixed evidence pack to the clean-context worker.
8. `wiki/summary.ts` reads parsed text and calls `wiki-evidence-worker` to generate grounded source summaries. Key findings in a source summary can bind short quotes to page/section/chunk/element locators through Evidence Anchors. When `content.ts` writes a source summary, it also synchronizes manifest, index, and operation journal.
9. `wiki/bootstrap.ts` assembles page evidence from the retrieval contract, source summaries, and parsed fallback.
10. `wiki/coordinator.ts` creates deterministic coordination plans for research answers, topic page builds, and maintenance sessions, marking owner boundaries for `paper-download-subagent`, `wiki-evidence-worker`, logical `wiki-synthesis-worker`, and `wiki-agent`.
11. `wiki/journal.ts` records begin/complete events for multi-file writes such as source, page, alias, and structure-plan operations. `wiki/health.ts` scans download, parse, summary, V1/V2 manifest artifact, typed page, and interrupted operation status and triggers repairs when requested.
12. `wiki/review.ts` is the single-page adversarial review layer. It does not call an LLM or write files. It reads typed pages or recoverable frontmatter and reports unsupported claims, weak quantitative provenance, stale/speculative/disputed state, missing caveats, low-confidence claims, and similar findings. `wiki_review_page` is its tool entrypoint.
13. `wiki/lint.ts`, `wiki/structure-plan.ts`, and `wiki/structure-apply.ts` form the governance layer: report structure/evidence issues, create a reviewable plan, then apply only low-risk deterministic fixes. Evidence-audit and evidence-backed design checks in `lint.ts` include missing knowledge state, missing last-reviewed date, disputed pages without contradiction evidence, missing quantitative provenance, unconfirmed contradiction candidates, legacy `related_pages` not upgraded, missing experiment paths, code-backed pages without experiment refs, material parameters without units/conditions, missing template sections, design records without uses relations, and software docs without version metadata.
14. `wiki/worker.ts` creates clean-context summary/page workers. `agent-runtime.ts` only injects them. Page-worker `templateGuidance` is a separate input and should not be concatenated into the raw user question.

### Design Code, Dependencies, And Layout

1. `src/design-agent.ts` fixes the design-agent prompt and `design-agent` boundary tool profile. It enters runtime only through `src/agent/agent-cli.ts` and does not implement business special cases at the wrapper layer.
2. `DESIGN_AGENT_TOOL_NAMES` in `src/agent/tool-types.ts` is the design boundary allowlist: `list_files`, `read_file`, wiki/paper local retrieval, `update_design_dependency`, `sync_design_environment`, `verify_design_python_import`, `write_design_code_file`, `replace_design_code_file_text`, `run_design_script`, and `write_design_artifact`.
3. `src/agent/file-tools.ts` implements design-agent write and execution capabilities. `write_design_code_file` and `replace_design_code_file_text` can only write under `design-repo/design-code/`; `write_design_artifact` can only write structured records under `design-repo/design-records/`; the generic `write_file` tool is not part of the design-agent boundary.
4. Python dependencies are declared in `design-repo/design-code/pyproject.toml`. `update_design_dependency` modifies that declaration. `sync_design_environment` may only run `uv sync` for `design-repo/design-code/` and forces `UV_PROJECT_ENVIRONMENT=<repo>/.venv`, so all design projects share the repository root `.venv`. Do not introduce `design-projects/` or per-project `.venv` directories.
5. `verify_design_python_import` uses root `.venv/bin/python` to check whether a package is importable. For packages such as `gdstk`, the correct path is dependency declaration -> `sync_design_environment` -> import verification, not direct `pip install` by the assistant or agent.
6. `run_design_script` only runs `.py` layout/verification scripts or KLayout batch scripts under `design-repo/design-code/`. Python scripts run through root `.venv/bin/python` and require `bwrap` on the system.
7. `run_design_script` copies `design-repo/design-code/` into a temporary workspace, runs the script inside `bwrap` with a read-only root filesystem and writable temporary design-code copy, then copies only caller-declared design-code outputs back into the real `design-repo/design-code/`. This prevents scripts from using absolute paths to mutate the TypeScript repo, wiki pages, sources, or other workspace files.
8. Design results enter the wiki asynchronously: design-agent produces design code, GDS/logs/results, design records, or design-artifact manifests; wiki-agent reads those outputs and uses `build_wiki_page`, `wiki_lint`, and `wiki_review_page` to condense evidence-bound conclusions into durable wiki pages. Do not write design artifacts as `knowledge-base/sources/design-artifact-*`.
9. `design-repo/design-code/` is the parent-managed `pi-chip-design` Python package. The parent repo tracks package source, tests, `pyproject.toml`, and `uv.lock`, while generated outputs, caches, and egg-info metadata stay ignored.

### Feishu Messages

1. `feishu-bridge/index.ts` loads config and initializes the Lark client, memory store, RPC client cache, and per-chat queue.
2. After a Feishu event arrives, `message-utils.ts` extracts text and decides whether to respond, while `mention-detection.ts` handles group mentions.
3. The bridge first recognizes repo commands managed by `paper-git.ts`; otherwise it builds a prompt and passes it to `PiRpcClient`.
4. `pi-client.ts` manages the agent RPC subprocess, and `agent-tool-status.ts` turns tool events into readable status text.
5. `stream-updater.ts` and `card-builder.ts` maintain streaming cards, while `reply-sender.ts` handles final reply retries.
6. `pdf-delivery.ts` parses PDF attachments from agent events or text and sends them back to Feishu.

### Browser Extension Native Host

1. The agent appends job events through `createPaperExtensionJob()`.
2. The browser extension polls the native host, and the native host validates messages with `parseExtensionHostMessage()`.
3. `handleExtensionHostMessage()` returns jobs, records job status, registers downloaded PDFs, or registers webpage snapshots by message type.
4. PDF registration writes paper records through `paper-store.ts`; webpage snapshots save parse artifacts through `paper-webpage-fetch.ts` and `paper-reader/engines/webpage.ts`.
5. `writeNativeHostManifest()` writes the native host manifest. Browser-side configuration is under `extension/paper-downloader/**`, and tests are under `test/browser-extension/**`.

## Production Code Index

### Top-Level Entrypoints

| File | Responsibility | Upstream callers | Downstream dependencies | Refactor notes |
| --- | --- | --- | --- | --- |
| `src/wiki-agent.ts` | wiki-agent CLI/RPC wrapper. | `npm run wiki-agent`, `npm run wiki-agent:rpc`, Feishu bridge default RPC subprocess. | `agent-cli.ts`. | Only fix the profile here; keep REPL/RPC logic out of top-level wrappers. |
| `src/design-agent.ts` | design-agent CLI/RPC wrapper. | `npm run design-agent`, `npm run design-agent:rpc`. | `agent-cli.ts`. | Only fix the profile here; design behavior should come from prompt and boundary, not wrapper special cases. |
| `src/pi-agent.ts` | Legacy direct-run compatibility and agent-runtime-related exports. | Internal/legacy direct runs and tests. | runtime, routing, prompt, and CLI helper modules. | Keep direct-run compatibility simple; public chat/RPC docs should not treat it as a public script. |
| `src/index.ts` | Package-level public export surface. | External importers, `test/index.test.ts`. | Multiple `src/agent/**` modules. | New exports expand the public API; search tests and scripts before deleting exports. |
| `src/paper-extension-host.ts` | Direct-run wrapper for the native messaging host. | `npm run paper-extension-host`, native host manifest. | `agent/paper/extension/paper-extension-host.ts`. | Keep only entrypoint logic here; protocol, registration, and manifest logic belong in the paper-domain module. |

### Agent Runtime And Tool Boundary

| File | Responsibility | Upstream callers | Downstream dependencies | Refactor notes |
| --- | --- | --- | --- | --- |
| `src/agent/agent-cli.ts` | CLI/RPC process, model resolution, REPL event formatting, session statistics. | Public wrappers `src/wiki-agent.ts`, `src/design-agent.ts`, and legacy direct-run wrapper. | `agent-runtime.ts`, `model-resolver.ts`, `env-proxy.ts`, `paper-download-jobs.ts`, RPC helpers. | Large entry layer; split first by CLI args, REPL formatting, RPC mode, and session stats while preserving current event-text tests. |
| `src/agent/agent-runtime.ts` | Single-turn `agentLoop`, worker-route execution, tool lifecycle, failed-turn handling, transient model-error retry. | `agent-cli.ts`, top-level export tests. | `tools.ts`, `agent-routing.ts`, `paper-extension-bridge.ts`, `wiki/worker.ts`. | High-coupling points are routed-worker execution and runtime tool injection; inspect worker handoff, tool cleanup, and failed-message persistence together. |
| `src/agent/agent-routing.ts` | Natural-language/explicit-prefix routing to worker roles, worker handoff path extraction. | `agent-runtime.ts`, `src/pi-agent.ts` exports. | `agent-prompts.ts`, Pi message types. | Route regex changes affect request ownership; when adding tool artifacts, update `extractWorkerHandoffPaths()`. |
| `src/agent/agent-prompts.ts` | System prompt constants for the main agent and workers. | `agent-routing.ts`, `agent-runtime.ts`, `pi-agent.ts`. | None. | Prompt changes are behavior changes; update README worker-boundary docs and related routing tests. |
| `src/agent/tools.ts` | Aggregates file/web/paper/wiki/design/health tools, and provides full/default profiles plus boundary tool filtering. | `agent-runtime.ts`, tests, public exports. | `file-tools.ts`, `web-tools.ts`, `paper/tools.ts`, `wiki/tools.ts`, `library-health-tools.ts`, `tool-types.ts`. | New tools must consider default order, full profile, cleanup, boundary allowlists, and tests. Default ordering should come from named domain factories, not array `slice()` inference. |
| `src/agent/tool-types.ts` | Tool dependency injection interfaces, tool collection metadata types, `ToolProfile`, worker roles, and boundary-visible tool names. | All `*-tools.ts`, `tools.ts`, README/docs. | Paper, wiki, browser, and web-related types. | This owns the tool contract and safety boundary. Do not expose a new tool only in `tools.ts`; confirm which workers may see it. Test doubles also enter here, so keep dependencies optional where practical. |
| `src/agent/model-resolver.ts` | Chooses the initial provider/model from CLI/env/auth state. | `agent-cli.ts`, tests. | `@mariozechner/pi-ai` types. | Startup diagnostics depend on this; changing errors affects troubleshooting and tests. |
| `src/agent/env-proxy.ts` | Configures the undici global proxy from environment variables. | `agent-cli.ts`, tests. | `undici`. | WSL/proxy issues often land here; keep environment reads centralized. |

### Agent Tool Wrappers

| File | Responsibility | Upstream callers | Downstream dependencies | Refactor notes |
| --- | --- | --- | --- | --- |
| `src/agent/file-tools.ts` | Workspace-limited file read/write/list/delete/replace, time, writing-skill loading, LaTeX compilation, design-record writing, design-code file tools, uv environment sync, import verification, and sandboxed design script execution. | `tools.ts`, worker boundaries. | Node fs/path/child_process, filename sanitizer from `wiki/store.ts`. | Path safety is central. Every write must pass workspace validation, and CLI trace text depends on tool parameter fields. Design-agent code writes must use dedicated `design-repo/design-code/` tools, dependency sync must use root `.venv`, and script execution must use `bwrap` temporary copy plus declared-output copyback. |
| `src/agent/web-tools.ts` | Tool wrappers for `web_search`, `fetch_url`, and `fetch_paper_webpage`. | `tools.ts`. | `web-search.ts`, `web-fetch.ts`, `paper-webpage-fetch.ts`. | Keep generic webpage fetch separate from paper webpage fetch; do not move publisher parsing into generic fetch. |
| `src/agent/library-health-tools.ts` | Tool schemas for local paper list/search, wiki health, and wiki health fix. | `tools.ts`. | `local-paper-library.ts`, `wiki/health.ts`, `paper-manager.ts`, `wiki/summary.ts`. | `wiki_health_fix` may trigger downloads, parsing, and summaries; tests should isolate real network through dependency injection. |

### Paper Search, Download, And Records

| File | Responsibility | Upstream callers | Downstream dependencies | Refactor notes |
| --- | --- | --- | --- | --- |
| `src/agent/paper/index.ts` | Paper-domain facade exporting acquisition, parsing, storage, browser, and extension APIs. | `src/index.ts`, external/test importers. | `paper/**` submodules and `knowledge-base.ts` path helpers. | External tools should prefer this facade or explicit subdomain entrypoints, not old flat paths. |
| `src/agent/paper/tools.ts` | Tool schemas and executors for paper search/download/blocklist/manual/login/parse/inspect/read/search. | `tools.ts`, some reuse in `wiki/tools.ts`. | `paper-manager.ts`, `paper-download.ts`, `paper-reader/**`, `paper-store.ts`, browser manager, extension bridge. | Large file; split by search/download/extension/reader tools while preserving tool names, details shape, and boundary tests. |
| `src/agent/paper/acquisition/arxiv.ts` | arXiv ID parsing, HTML URL construction, search, and PDF download. | `paper-manager.ts`, tests. | Node/fetch. | Canonical arXiv IDs enter paper keys; normalization changes require migration or legacy compatibility. |
| `src/agent/paper/acquisition/aps-search.ts` | APS search result parsing and search. | `paper-manager.ts`, tests. | fetch/HTML parsing logic. | APS site structure changes often; keep parser unit tests against real sample HTML. |
| `src/agent/network.ts` | Low-level network response/error helpers. | Download and web-related modules. | fetch/Response types. | Keep this layer business-neutral; avoid scattering publisher special cases here. |
| `src/agent/web-search.ts` | Agent-side web search provider calls and result normalization. | `web-tools.ts`, `paper-manager.ts`. | child_process or external search command. | This is separate from Feishu bridge `web/search.ts`; confirm cache and format differences before merging. |
| `src/agent/web-fetch.ts` | Generic webpage content fetch. | `web-tools.ts`, tests. | fetch. | Does not handle structured paper webpage parsing; papers use `paper-webpage-fetch.ts`. |
| `src/agent/paper/acquisition/paper-download.ts` | Low-level PDF download, publisher canonical IDs, supported publisher download. | `paper-manager.ts`, `paper/tools.ts`, `paper-extension-host.ts`. | publisher adapters, fetch, browser/session fallback. | License/access/Cloudflare classification affects fallback and blocklist; keep high-level policy out of this layer. |
| `src/agent/paper/acquisition/paper-manager.ts` | High-level paper search/download policy: dedupe, blocklist, arXiv fallback, publisher/manual/extension flow, APS batch. | `paper/tools.ts`, `wiki/health.ts`, tests. | `arxiv.ts`, `aps-search.ts`, `paper-download.ts`, `paper-store.ts`, `paper-blocklist.ts`, `publisher-access-state.ts`, browser/extension. | Largest business file; split toward search aggregation, candidate ranking, download strategy, publisher fallback, and manual registration while preserving result shape. |
| `src/agent/paper/storage/paper-store.ts` | Paper record/source metadata paths, read/write, dedupe, parse/reading status updates. | `paper-manager.ts`, `paper-reader-store.ts`, `paper-extension-host.ts`, `wiki/health.ts`. | `knowledge-base.ts`, `paper-types.ts`, Node fs/path/crypto. | Owns the data format; field changes must read existing JSON, preferably through migrations or tolerant parsing. |
| `src/agent/paper/types.ts` | Shared types for paper sources, records, download/search/results, and related contracts. | Paper, reader, wiki, and extension modules. | None. | Cross-subsystem contract; renaming status values affects tests and persisted JSON. |
| `src/agent/knowledge-base.ts` | Resolves knowledge-base/raw/wiki paths under the workspace. | Stores, local library, wiki store. | Node path. | Owns path layout; do not hardcode new paths in individual modules. |
| `src/agent/paper/storage/knowledge-paths.ts` | Paper-domain facade over knowledge-base path helpers. | `paper/index.ts`, boundary tests. | `knowledge-base.ts`. | Currently re-exports path APIs; if wiki/paper paths split later, this is the compatibility layer. |
| `src/agent/paper/storage/local-paper-library.ts` | Scans local paper records, parse manifests, and source summaries; provides list/search. | `library-health-tools.ts`, `wiki/health.ts`, `wiki/bootstrap.ts`, `wiki/tools.ts`. | `knowledge-base.ts`, `paper-download.ts`, reader types. | Local index layer for wiki/health; search-score changes affect evidence bootstrap. |
| `src/agent/paper/acquisition/paper-blocklist.ts` | Reads/writes download blocklist, matching, and paper-key derivation. | `paper-manager.ts`, `paper/tools.ts`, `wiki/health.ts`. | `paper-types.ts`, Node fs/path. | Reason codes are operational semantics; `download-blocked` health downgrade depends on these matches. |
| `src/agent/paper/acquisition/publisher-access-state.ts` | Persistent publisher access state and Cloudflare cooldowns. | `paper-manager.ts`. | Node fs/path. | Throttling/block decisions affect live publisher access; keep now/read/write injectable in tests. |
| `src/agent/paper/extension/paper-download-jobs.ts` | Extension job event-log path, append/read/summarize. | `paper-manager.ts`, `paper-extension-bridge.ts`, `paper-extension-host.ts`, `agent-cli.ts`. | `paper-types.ts`, extension protocol types. | Queue event source; new statuses/purposes must sync extension protocol and browser-extension tests. |
| `src/agent/paper/extension/paper-extension-bridge.ts` | Agent-side extension job creation and queued bridge implementation. | `agent-runtime.ts`, `paper-manager.ts`, `paper/tools.ts`. | `paper-download-jobs.ts`. | It only writes the queue; do not add direct browser communication or native-messaging process dependencies. |

### Publisher Adapters

| File | Responsibility | Upstream callers | Downstream dependencies | Refactor notes |
| --- | --- | --- | --- | --- |
| `src/agent/paper/acquisition/publisher-adapters/types.ts` | Publisher adapter interface. | `publisher-adapters/index.ts`. | None. | Interface changes must update every adapter. |
| `src/agent/paper/acquisition/publisher-adapters/index.ts` | Selects Science/Nature/APS adapters and parses PDF paths from HTML. | `paper-download.ts`, tests. | `science.ts`, `nature.ts`, `aps.ts`. | Central registration point for new publishers. |
| `src/agent/paper/acquisition/publisher-adapters/science.ts` | Science URL/HTML/PDF recognition rules. | adapter index. | adapter types. | Site rules drift; add fixture tests before changing. |
| `src/agent/paper/acquisition/publisher-adapters/nature.ts` | Nature URL/HTML/PDF recognition rules. | adapter index. | adapter types. | Related to Nature download/webpage flow; run Nature-related unit tests after changes. |
| `src/agent/paper/acquisition/publisher-adapters/aps.ts` | APS URL/HTML/PDF recognition rules. | adapter index. | adapter types. | APS DOI normalization also exists in `paper-download.ts`; keep both consistent. |

### Browser And Extension

| File | Responsibility | Upstream callers | Downstream dependencies | Refactor notes |
| --- | --- | --- | --- | --- |
| `src/agent/paper/browser/browser-session.ts` | Playwright/CDP/system Chrome launch, manual login, authorization-state classification. | `paper-manager.ts`, `paper/tools.ts`, tests. | Playwright, Node child_process/fs. | Browser path and profile logic spans WSL/Windows; run browser-session tests after changes. |
| `src/agent/paper/browser/paper-browser-manager-types.ts` | Browser manager HTTP API types. | client/server/discovery. | None. | Keep API types in sync with client/server. |
| `src/agent/paper/browser/paper-browser-manager-discovery.ts` | Browser manager metadata read/write, stale detection, discovery. | `paper-browser-manager-client.ts`, tests. | Node fs/path. | Metadata stale rules decide whether a browser manager is reused. |
| `src/agent/paper/browser/paper-browser-manager-client.ts` | Discovers or starts browser manager and calls open/download APIs. | `paper/tools.ts`, tests. | discovery, HTTP fetch, child_process. | Process startup and HTTP calls are interleaved; preserve spawn result compatibility when splitting. |
| `src/agent/paper/browser/paper-browser-manager-server.ts` | Browser manager HTTP server. | browser manager process, tests. | HTTP, manager types. | Port binding may fail in sandboxes; tests should distinguish environment limits from logic failures. |
| `src/agent/paper/extension/paper-extension-protocol.ts` | Native-host message/response types and runtime parser. | `paper-extension-host.ts`, browser-extension tests. | `paper-types.ts`. | Protocol contract owner; new fields should keep parser strict but backward-compatible through optional fields. |
| `src/agent/paper/extension/paper-extension-host.ts` | Native messaging framing, job polling, PDF/bytes/download-path registration, webpage snapshot registration, manifest writing. | `src/paper-extension-host.ts`, browser native host, tests. | protocol, jobs, paper-store, paper-reader, paper-webpage-fetch. | Large file; split toward native framing, message handler, PDF registration, webpage registration, and manifest. Be careful with path candidates and WSL compatibility. |
| `src/agent/paper/acquisition/paper-webpage-fetch.ts` | Paper webpage HTML fetch, diagnostics, Pandoc/LaTeXML markdown cleanup, structured extraction. | `web-tools.ts`, `paper-extension-host.ts`, reader webpage engine. | `paper-reader/latexml-markdown.ts`, child_process, fetch. | Large file; HTML parser changes need publisher fixtures covering access status, metadata, and assets. |

### Paper Reading And Parsing

| File | Responsibility | Upstream callers | Downstream dependencies | Refactor notes |
| --- | --- | --- | --- | --- |
| `src/agent/paper/reading/types.ts` | Reader types for parsed documents, sections, quality, engines, and `PaperReaderError`. | reader engines, `paper/tools.ts`, wiki/health. | None. | Parse artifact contract; new engines/statuses must sync store and tests. |
| `src/agent/paper/reading/paper-reader.ts` | Main orchestration for `parsePaper`, `inspectPaper`, `readPaperSection`, and `searchPaperText`. | `paper/tools.ts`, `wiki/summary.ts`, `wiki/health.ts`. | reader store, engines, quality, chunks. | Engine selection and cache policy are centralized here; changing defaults affects many behaviors. |
| `src/agent/paper/reading/paper-reader-store.ts` | PDF/source location, parse artifact paths, cache read/write, paper-key lookup. | `paper-reader.ts`, `paper-store.ts`, tests. | `paper-store.ts`, Node fs/path/crypto. | Keep repo-managed-path constraints; allowing arbitrary external paths expands the safety surface. |
| `src/agent/paper/reading/quality.ts` | Markdown/section parse quality scoring. | `paper-reader.ts`, `webpage.ts`, `wiki/health.ts`. | reader types. | Health and summary gating depend on thresholds; update tests when scoring changes. |
| `src/agent/paper/reading/chunks.ts` | Generates retrieval chunks from parsed documents. | `paper-reader.ts`. | reader types. | Chunk IDs and locator fields affect `search_paper_text` results. |
| `src/agent/paper/reading/latexml-markdown.ts` | HTML entity decoding and LaTeXML/Pandoc markdown cleanup. | `paper-webpage-fetch.ts`, webpage engine. | None. | Over-aggressive cleanup can damage formulas and citations; use fixtures for regressions. |
| `src/agent/paper/reading/engines/opendataloader.ts` | OpenDataLoader local/hybrid parsing. | `paper-reader.ts`. | child_process, reader types. | External tool dependency may be missing; errors should be diagnostic and allow fallback. |
| `src/agent/paper/reading/engines/docling.ts` | Docling parsing. | `paper-reader.ts`. | child_process, reader types. | External tool boundary; keep failure information specific. |
| `src/agent/paper/reading/engines/tex-source.ts` | Parses arXiv/TeX source into document structure. | `paper-reader.ts`. | Node fs/path, reader types. | TeX parsing heuristics are broad; changes need examples for sections, formulas, and references. |
| `src/agent/paper/reading/engines/plain-text-baseline.ts` | Baseline PDF text parsing. | `paper-reader.ts` fallback. | child_process, reader types. | Fallback engine; prefer stable low-quality diagnostic artifacts over crashes. |
| `src/agent/paper/reading/engines/webpage.ts` | Saves webpage snapshot parse artifacts. | `paper-extension-host.ts`, `paper-reader.ts`. | `paper-webpage-fetch.ts` types, quality, store. | Linked to extension webpage snapshot protocol; keep quality fields compatible. |

### Wiki, Source Summary, And Health

| File | Responsibility | Upstream callers | Downstream dependencies | Refactor notes |
| --- | --- | --- | --- | --- |
| `src/agent/wiki/index.ts` | Wiki-domain facade exporting source/page/bootstrap/lint/summary/relations/health/worker APIs. | `src/index.ts`, boundary tests, external reuse. | `wiki/**` submodules. | External imports should prefer this facade or explicit subdomain entrypoints to avoid scattered paths. |
| `src/agent/wiki/types.ts` | Wiki source/page/search/bootstrap/worker types. | wiki tools, content, bootstrap, worker. | None. | Worker JSON output contract lives here; field changes must sync prompt and parser. |
| `src/agent/wiki/workspace-contract.ts` | `knowledge-base/` lifecycle roots, index/log/journal paths, relative-path helpers. | `store.ts`, tests, external wiki integration. | `knowledge-base.ts`, Node path. | Add new path classes to the contract first, then delegate old helpers to it. Avoid rebuilding directories ad hoc in modules. |
| `src/agent/wiki/page-schema.ts` | Typed wiki page frontmatter types, parse/validate/serialize, including `knowledge_state`, `last_reviewed_at`, `freshness_audit`, `execution_binding`, and evidence-audit metadata validation. | `typed-store.ts`, `health.ts`, `maintenance.ts`, `retrieval-contract.ts`, `review.ts`. | `domain-bindings.ts`. | Schema is the durable Markdown contract. New fields must tolerate old pages and add malformed diagnostics. Knowledge state values are limited to `established`, `promising_unverified`, `speculative`, and `disputed`; quantitative `claims` must bind concrete provenance such as page/figure/table/element/chunk/code-output; `freshness_audit` records latest external search, missing recent papers, stale warnings, and field update cadence; `experiment_refs` paths must be workspace-relative. |
| `src/agent/wiki/typed-store.ts` | Lists, reads, and writes typed wiki pages while preserving Markdown body and reporting bad pages as diagnostics. | `retrieval-contract.ts`, `health.ts`, `lint.ts`, `maintenance.ts`. | `page-schema.ts`, `store.ts`. | Does not download or call LLMs; writes must not bypass source/page boundaries. |
| `src/agent/wiki/domain-bindings.ts` | Metadata registry for validated executable helper bindings. | `page-schema.ts`, domain-binding tests. | None. | Describes binding schema only; it does not execute page content. Return deep copies to prevent callers mutating the registry. |
| `src/agent/wiki/store.ts` | Wiki directories, source/page/assets/manifests/state paths, and scaffold. | `content.ts`, `tools.ts`, design artifact writes in `file-tools.ts`. | `knowledge-base.ts`, `workspace-contract.ts`, Node fs/path. | Compatibility path facade; new paths should come from the workspace contract. Shared docs should avoid hardcoded user-home paths. |
| `src/agent/wiki/manifest-store.ts` | Source manifest read/write, manifest backfill from old `summary.md`, V1-to-V2 normalization, generalized source kind/status types. | `content.ts`, `health.ts`, `retrieval-contract.ts`, `bootstrap.ts`. | `store.ts`, Node fs/path. | Manifest is the wiki-facing provenance index, not a replacement for acquisition/parse records. V2 covers paper and non-paper evidence such as materials/software/standards; reads must verify filename key and internal `sourceKey` identity. |
| `src/agent/wiki/journal.ts` | Multi-file wiki operation WAL: begin/complete events, reads, unfinished-operation detection. | `content.ts`, `structure-apply.ts`, `health.ts`. | `store.ts`, Node fs/path. | Begin before writes and complete after all writes. Repair tools depend on operation ID and planned files. |
| `src/agent/wiki/retrieval-contract.ts` | Read-only evidence contract: reads/lists source evidence and typed page evidence, merging manifest, `sourceKind`/`sourceKey`, diagnostics, knowledge state, review date, claims, typed relations, experiment refs, and reviewer critique. | `retrieval-search.ts`, `bootstrap.ts`, downstream workers. | `manifest-store.ts`, `typed-store.ts`, `store.ts`, `page-schema.ts` types. | Downstream agents should consume this contract instead of physical directories. Bad keys, malformed manifests, and identity mismatches must degrade into diagnostics, not trusted reference keys. |
| `src/agent/wiki/retrieval-search.ts` | Structured evidence search returning score, match reasons, warnings, structured filter results, and insufficient-evidence state. | `content.ts`, tests. | `retrieval-contract.ts`. | Ranking affects answer/build grounding. Strong scores outrank preferred kind. `maxEvidenceAgeDays` should only trigger freshness warnings when supplied by the caller; do not hardcode current time assumptions here. |
| `src/agent/wiki/evidence-pack.ts` | Builds fixed synthesis evidence packs for `build_wiki_page`: summaries for recall/compression, raw chunks and claim provenance for final claims, contradiction notes for disputes. | `wiki/tools.ts`. | retrieval contract, paper reader artifacts, source manifests. | Do not treat summaries as final evidence. Chunk reads must stay bounded; missing chunks should degrade with diagnostics. |
| `src/agent/wiki/page-templates.ts` | Infers concept/method/finding/dataset/capability-boundary/design-record templates from evidence/query, provides required sections and worker guidance, and validates draft sections. | `wiki/tools.ts`, `lint.ts`, tests. | `manifest-store.ts`, `page-schema.ts` types. | Material-parameter, software-doc, capability-boundary, and design-record gates enter here. New templates need synchronized lint and worker-guidance tests. |
| `src/agent/wiki/content.ts` | Writes source summaries, writes synthesis pages, merges aliases, and searches wiki. | `wiki/tools.ts`, `wiki/summary.ts`, tests. | store, manifest-store, journal, typed-store, retrieval-search, paper reader store. | Owns source/page file format. Source/page/alias writes must keep manifest, index, journal, and typed metadata consistent. |
| `src/agent/wiki/bootstrap.ts` | Builds fixed evidence packs and seed queries for new wiki pages. | `wiki/tools.ts`, tests. | `retrieval-contract.ts`, `local-paper-library.ts`, `wiki/content.ts`. | No-page-yet bootstrap entrypoint; prefer structured evidence first, then fall back to the local paper library. |
| `src/agent/wiki/lint.ts` | Wiki structure, citations, typed evidence contract, coverage, evidence-audit, freshness metadata, evidence-backed design, and governance lint. | `wiki/tools.ts`, tests. | wiki store, typed-store, maintenance helpers, wiki types, page templates. | Lint severity affects repair recommendations. Keep issue kinds stable and separate low-risk deterministic fixes from LLM rewrites. Checks for knowledge state, last-reviewed date, disputed contradiction evidence, claim provenance, contradiction candidates, typed relation, experiment ref, material parameter units/conditions, template sections, and software versions should remain deterministic. |
| `src/agent/wiki/review.ts` | Typed wiki page adversarial review producing deterministic findings without writing files. | `wiki/tools.ts`, tests. | `page-schema.ts`, `typed-store.ts`, `store.ts`. | Review gate before publishing research conclusions. Even when frontmatter has partial schema errors, try to recover raw claims and report weak quantitative provenance instead of silently skipping risk. |
| `src/agent/wiki/maintenance.ts` | Reads typed/legacy pages and source summaries; computes coverage, concept gaps, semantic aliases, and scope drift. | `lint.ts`, `structure-plan.ts`, tests. | `typed-store.ts`, `manifest-store.ts`, `store.ts`. | During legacy/typed coexistence, read leniently. Unsafe manifest-only source paths must be skipped. |
| `src/agent/wiki/structure-plan.ts` | Converts lint/governance issues into budgeted, reviewable maintenance actions. | `wiki/tools.ts`, tests. | `maintenance.ts`, lint types. | Plans only, does not write files. The action schema is the `wiki_apply_structure_plan` input contract. |
| `src/agent/wiki/structure-apply.ts` | Applies approved low-risk structure actions with dry-run, preflight, journal, and validation support. | `wiki/tools.ts`, tests. | `content.ts`, `journal.ts`, `lint.ts`, store. | Deterministic fixes only; do not introduce LLM rewrites here. |
| `src/agent/wiki/summary.ts` | Builds summary evidence from parsed papers and calls the worker to generate/write source summaries. | `wiki/tools.ts`, `library-health-tools.ts`, `wiki/health.ts`. | `paper-reader.ts`, `wiki/content.ts`, `local-paper-library.ts`. | Evidence truncation and worker confidence gating are quality-critical; never let the worker expand without evidence. |
| `src/agent/wiki/relations.ts` | Discovers and updates related paper keys for source summaries. | `wiki/tools.ts`, `wiki/summary.ts`. | `local-paper-library.ts`, `wiki/store.ts`. | Relation scoring affects the knowledge graph; preserve append/replace modes. |
| `src/agent/wiki/health.ts` | Checks and repairs wiki, parse, summary, download, V1/V2 manifest artifacts, typed page, and operation journal state. | `library-health-tools.ts`, tests. | `local-paper-library.ts`, `paper-manager.ts`, `paper-reader.ts`, `paper-blocklist.ts`, `manifest-store.ts`, `typed-store.ts`, `journal.ts`, `wiki/lint.ts`. | Large file; download-blocked downgrade, manifest backfill, typed diagnostics, automatic download, and automatic summary live here. Preserve issue kind/status semantics when splitting. |
| `src/agent/wiki/coordinator.ts` | Builds deterministic wiki coordination plans from intent/evidence/blockers. | `wiki/tools.ts`, tests. | None. | Owner boundaries are the audit contract. `wiki-synthesis-worker` is a logical owner label, not a router role. |
| `src/agent/wiki/tools.ts` | Orchestrates wiki source/page/relations/review/health answer/research/bootstrap/build/alias tools and returns `evidenceStatus`/coordination metadata. | `tools.ts`. | `wiki/**` domain services, `local-paper-library.ts`, `paper/tools.ts`. | Highest coupling file; split toward source tools, page tools, research-answer flow, and topic expansion while preserving external-evidence disable switches, structured retrieval filters, template write gate, and coordination details shape. |
| `src/agent/wiki/worker.ts` | Creates clean-context `wiki-evidence-worker` summary/page subtasks and parses worker JSON output. | `agent-runtime.ts`. | `agent-prompts.ts`, `tools.ts` boundary, `agentLoop`. | Recursive tool filtering is critical. The worker must not call `generate_paper_wiki_summary` or `build_wiki_page` recursively. Keep page-worker `question` separate from `templateGuidance`. |

### Support Scripts And Local Viewer

| File | Responsibility | Upstream callers | Downstream dependencies | Refactor notes |
| --- | --- | --- | --- | --- |
| `scripts/wiki-web.mjs` | Local wiki web viewer and `/graph-data.json` generator. | `npm run wiki:web`, `test/scripts/wiki-web-graph.test.mjs`. | Node http/fs/path. | Script layer should not depend back on `dist/src/**`. Graph data should prefer page-frontmatter `typed_relations`, while retaining legacy `related_pages`, Markdown links, and bracket-reference fallback. Script-level tests protect import safety so importing tests does not start a server. |

### Feishu Bridge

| File | Responsibility | Upstream callers | Downstream dependencies | Refactor notes |
| --- | --- | --- | --- | --- |
| `src/feishu-bridge/index.ts` | Feishu long-connection main flow, message queue, RPC client management, streaming replies, repo command/PDF delivery/memory orchestration. | `npm run feishu-bridge`. | Almost every `feishu-bridge/**` helper, Lark SDK. | Largest bridge file; split first by event parsing, agent invocation, reply rendering, and side effects. Do not put domain reasoning here. |
| `src/feishu-bridge/config.ts` | Loads `.env`/environment configuration, including Windows env reads. | `index.ts`, tests. | Node fs/path/child_process. | Config names are deployment contracts; default changes must update env example and README. |
| `src/feishu-bridge/types.ts` | Internal incoming-message types for the bridge. | `index.ts`, session/memory helpers. | None. | Keep `ParsedIncomingMessage` stable to avoid changing per-chat session keys. |
| `src/feishu-bridge/colors.ts` | Console colors and log helpers. | `index.ts`. | None. | Presentation only, no logic. |
| `src/feishu-bridge/chat-queue.ts` | Per-key serial queue. | `index.ts`, tests. | None. | Group/private chat ordering depends on this; avoid global blocking. |
| `src/feishu-bridge/pi-client.ts` | JSONL RPC agent subprocess client, event parsing, command sending. | `index.ts`, tests. | Node child_process/events. | Tightly coupled to the `agent-cli.ts` RPC event protocol; new events need tests on both sides. |
| `src/feishu-bridge/pi-client-retry.ts` | Retry wrapper for starting `PiRpcClient`. | `index.ts`, tests. | `pi-client.ts`. | Only handle startup retries; do not swallow long-running errors. |
| `src/feishu-bridge/pi-session.ts` | Resolves agent session dir, client options, and client key from messages. | `index.ts`, tests. | bridge types. | Session key changes affect context isolation and memory reuse. |
| `src/feishu-bridge/agent-tool-status.ts` | Formats RPC tool events into Feishu progress status. | `index.ts`, tests. | `pi-client.ts` event types. | UI text changes affect observability tests. |
| `src/feishu-bridge/agent-web-search.ts` | Legacy agent web-search follow-up instructions and result wrapper. | `index.ts`. | `web/search.ts`. | Distinct from the agent's own tools; confirm fallback semantics before merging. |
| `src/feishu-bridge/paper-git.ts` | Bridge-side managed repo status/diff/log/commit/push and automatic commit. | `index.ts`, tests. | child_process, fs. | Bridge-side service, not an LLM tool. Keep repo commands configuration-limited. |
| `src/feishu-bridge/web/search.ts` | Feishu bridge standalone web search, cache keys, Jina/DuckDuckGo parsing and formatting. | `agent-web-search.ts`, `index.ts`. | child_process/fetch. | Do not confuse this with agent tool `web-search.ts`; tests are separate. |
| `src/feishu-bridge/feishu/message-utils.ts` | Feishu message text extraction, mention stripping, response decision, prompt construction. | `index.ts`, tests. | None. | Group-chat trigger rules are sensitive; mention metadata is supplemented by `mention-detection.ts`. |
| `src/feishu-bridge/feishu/mention-detection.ts` | Detects bot mentions and trusts Feishu mention metadata. | `index.ts`, tests. | None. | Group mention repairs are common; `mentioned_type:"bot"` should take priority over open_id guessing. |
| `src/feishu-bridge/feishu/sender-name.ts` | Gets/parses Feishu sender display names. | `index.ts`, tests. | Lark client. | Failures should degrade without blocking replies. |
| `src/feishu-bridge/feishu/card-builder.ts` | Builds Feishu thinking/status/stream/error card JSON. | `index.ts`, tests. | None. | Card JSON field changes require card tests. |
| `src/feishu-bridge/feishu/stream-updater.ts` | Streaming card update throttling and state management. | `index.ts`, tests. | None. | Avoid excessive API calls; exceptions should still allow final text reply fallback. |
| `src/feishu-bridge/feishu/reply-sender.ts` | Sends Feishu replies and parses/retries errors. | `index.ts`, tests. | Lark client. | API error classification affects retries and logs. |
| `src/feishu-bridge/feishu/long-message.ts` | Splits long text messages. | `index.ts`, tests. | None. | Chunks should keep markdown and links readable. |
| `src/feishu-bridge/feishu/pdf-delivery.ts` | Parses and returns PDF attachments from agent events/text/config. | `index.ts`, tests. | Node fs/path. | Paths must be restricted by workspace/config to avoid arbitrary file disclosure. |
| `src/feishu-bridge/memory/chat-memory.ts` | Per-chat short-term history storage. | `index.ts`, tests. | Node fs/path. | Keep `prompt_history` distinct from `stored_history` to avoid feeding assistant replies back into prompts. |
| `src/feishu-bridge/memory/long-term-memory.ts` | Long-term fact/preference storage. | `index.ts`, tests. | Node fs/path. | Store only durable facts, not sensitive information. |
| `src/feishu-bridge/memory/key-memory.ts` | Key memory candidate extraction and key-based store. | `index.ts`, tests. | Node fs/path. | Extraction rules affect long-term preference quality; keep them explainable. |
| `src/feishu-bridge/memory/extractors.ts` | Extracts durable user/group facts from text. | `index.ts`, tests. | None. | Rules should be conservative and avoid treating transient chat as long-term fact. |
| `src/feishu-bridge/memory/debug.ts` | Formats memory debug lines. | `index.ts`, tests. | memory types. | Debug output should avoid leaking sensitive paths or secrets. |

## Test Map

Tests to inspect first by production module:

- Runtime/CLI/router/tools: `test/agent/pi-agent.test.ts`, `test/agent/tools.test.ts`, `test/agent/tools-extension.test.ts`, `test/agent/model-resolver.test.ts`, `test/agent/env-proxy.test.ts`, `test/index.test.ts`.
- Design-agent boundary/design-code tooling: `test/agent/tools.test.ts` covers design-agent tool exposure, design-code write constraints, root `.venv` sync/import behavior, and `run_design_script` sandbox/output copyback. The parent-managed Python package has its own checks under `design-repo/design-code/tests` and linting under `design-repo/design-code/src`.
- Paper search/download/store/blocklist/jobs: `test/agent/arxiv.test.ts`, `test/agent/aps-search.test.ts`, `test/agent/paper-download.test.ts`, `test/agent/paper-manager.test.ts`, `test/agent/paper-manager-extension.test.ts`, `test/agent/paper-store.test.ts`, `test/agent/paper-download-jobs.test.ts`, `test/agent/publisher-adapters/index.test.ts`.
- Browser and extension: `test/agent/browser-session.test.ts`, `test/agent/browser-session-runtime.test.ts`, `test/agent/paper-browser-manager-client.test.ts`, `test/agent/paper-browser-manager-discovery.test.ts`, `test/agent/paper-browser-manager-server.test.ts`, `test/agent/paper-extension-host.test.ts`, `test/agent/paper-extension-host-registration.test.ts`, `test/agent/paper-extension-protocol.test.ts`, `test/browser-extension/paper-downloader.test.mjs`.
- Paper parsing/reading/webpage: `test/agent/paper-reader.test.ts`, `test/agent/paper-webpage-fetch.test.ts`, `test/agent/local-paper-library.test.ts`.
- Wiki core/source/relations/health/evidence audit: `test/agent/wiki-domain-boundary.test.ts`, `test/agent/wiki-workspace-contract.test.ts`, `test/agent/wiki-page-schema.test.ts`, `test/agent/wiki-typed-store.test.ts`, `test/agent/wiki-manifest-store.test.ts`, `test/agent/wiki-retrieval-contract.test.ts`, `test/agent/wiki-review.test.ts`, `test/agent/wiki-page-templates.test.ts`, `test/agent/wiki-coordinator.test.ts`, `test/agent/wiki-domain-bindings.test.ts`, `test/agent/paper-summary.test.ts`, `test/agent/paper-relations.test.ts`, `test/agent/wiki-health.test.ts`, `test/agent/wiki-maintenance.test.ts`, `test/agent/local-paper-library.test.ts`, `test/agent/tools.test.ts`.
- Local wiki web graph scripts: `test/scripts/wiki-web-graph.test.mjs`.
- Web tools: `test/agent/web-fetch.test.ts`, `test/agent/web-search.test.ts`.
- Feishu bridge: `test/feishu-bridge/*.test.ts`, mostly one-to-one with `src/feishu-bridge/**`. For main-flow issues inspect `pi-client.test.ts`, `pi-session.test.ts`, `agent-tool-status.test.ts`, `mention-detection.test.ts`, `message-utils.test.ts`, `paper-git.test.ts`, `pdf-delivery.test.ts`, and `config.test.ts` first.

## Refactor Entry Points

- `src/agent/paper/acquisition/paper-manager.ts`: start by extracting pure functions and strategy objects, without changing durable JSON formats. Good split targets are search aggregation, candidate ranking, download orchestration, publisher fallback, and manual registration.
- `src/agent/paper/storage/paper-store.ts`: add data-format fixtures before changing paths or record schema. Any field rename must support old record reads.
- `src/agent/wiki/**` schema-first core: route paths through `workspace-contract.ts`, page fields through `page-schema.ts`, and downstream reads through `retrieval-contract.ts`. Do not let new workflows scan physical directories directly. Evidence-audit fields are also page contracts; do not bypass schema with ad hoc frontmatter parsing. Non-paper evidence must enter page construction through V2 manifest `sourceKind`/`sourceKey` and template gates.
- `src/agent/wiki/tools.ts`: split helpers by tool family while preserving public tool names, details shape, `evidenceStatus`, and coordination metadata. The external-evidence switches in `answer_research_question` and `build_wiki_page` are key boundaries.
- `src/agent/wiki/health.ts` and `src/agent/wiki/maintenance.ts`: split pure functions by issue kind or diagnostic source without renaming issue kinds first. `source_manifest_*`, `wiki_page_*`, and `wiki_operation_interrupted` are external governance semantics.
- `src/agent/paper/extension/paper-extension-host.ts`: split native framing, protocol handling, PDF registration, webpage snapshot registration, and manifest writer. Run extension-host and browser-extension tests at each step.
- `src/feishu-bridge/index.ts`: extract stateless helpers without changing message queue, memory, or RPC client cache lifecycles. The bridge layer should not absorb agent/domain logic.
- `src/agent/agent-cli.ts`: can be split into CLI args, RPC mode, REPL event formatting, and session stats. Inspect `test/agent/pi-agent.test.ts` before changing `[tool:start]` or `[tool:end]` text.

Minimum verification before refactors:

1. Runtime/tools/router changes: run `npm test`.
2. Extension/native-host changes: run `npm test` plus `test/browser-extension/paper-downloader.test.mjs` coverage.
3. Wiki web graph script changes: run `npm run build` and `node --test --experimental-test-isolation=none test/scripts/wiki-web-graph.test.mjs`.
4. Design-agent tool boundary, dependency sync, or script sandbox changes: run `npm test`, then `.venv/bin/python -m pytest design-repo/design-code/tests` and `.venv/bin/python -m ruff check design-repo/design-code/src design-repo/design-code/tests`.
5. Docs-only changes: run `npm run build`, and check path references under `src/**`.
