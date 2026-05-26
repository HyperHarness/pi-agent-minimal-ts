# pi-agent-minimal-ts

Minimal TypeScript research agent built on [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai) and [`@mariozechner/pi-agent-core`](https://www.npmjs.com/package/@mariozechner/pi-agent-core).

This repository is a practical agent harness for literature ingestion, local wiki growth, Feishu chat operation, and manuscript/design workflows. It is intentionally small at the runtime layer, but the tool boundaries are explicit so another agent can reuse it without guessing which component owns each capability.

## What It Does

- runs strict wiki-agent and design-agent terminal chat / REPL entrypoints
- runs the wiki-agent as a JSONL RPC process for the Feishu bridge
- exposes a Feishu long-connection bridge with streaming replies and per-chat memory
- searches, downloads, parses, summarizes, and indexes papers into a local knowledge base
- builds durable typed wiki pages from fixed evidence rather than one-off answers
- records claim-level provenance, knowledge-state/freshness metadata, typed page/source/experiment relations, experiment references, and reviewer-risk critique metadata on wiki pages
- maintains source manifests, operation journals, evidence contracts, and wiki governance diagnostics
- plans wiki-agent work with deterministic owner boundaries for acquisition, evidence construction, page writing, and blocked cases
- keeps chip-design code, artifacts, and records under `knowledge-base/` so design work participates in the wiki data flywheel
- manages paper/design/wiki Git repositories through a bridge-side repo manager
- exposes isolated worker tool surfaces for wiki, evidence, download, design, and paper-writing workflows
- supports a PaperOrchestra-inspired controlled manuscript workflow for writing workspace setup, draft gates, refinement decisions, and provenance snapshots

## Architecture

The public system boundary is two strict agents plus the Feishu bridge:

```text
Feishu bridge
        |
        +--> wiki-agent RPC only
                  |
                  +--> paper-download-subagent  -> acquisition files, PDFs, webpages, parses
                  +--> wiki-evidence-worker     -> sources/*/summary.md and fixed-evidence page drafts
                  +--> wiki-agent               -> pages/*.md, aliases, curated knowledge
                  +--> paper-writing-worker     -> manuscript project files
                  +--> reads design outputs      -> design records, summaries, manifests, artifacts

Local terminal / harness
        |
        +--> wiki-agent CLI/RPC          -> wiki and paper knowledge work
        +--> design-agent CLI/RPC        -> design code, dependencies, layout scripts, records
        +--> bridge repo manager         -> git status/diff/log/commit/push for configured repos
```

### Feishu Bridge Boundary

The Feishu bridge is the chat transport and workflow trigger. It lives under `src/feishu-bridge/` and owns:

- receiving Feishu messages and applying private-chat / group-mention rules
- keeping per-chat memory under `.memory/`
- starting the wiki-agent in RPC mode; `PI_COMMAND` should only point at another compatible wiki-agent RPC process
- streaming or sending final replies back to Feishu
- sending downloaded or compiled PDFs back to chat when configured
- intercepting bridge commands such as `repo status paper` before the prompt reaches the agent

The bridge should not contain domain reasoning. It should route messages, collect tool progress, and call bridge-side services.

### Public Agent Boundary

The public entrypoints are intentionally explicit. Do not start a generic agent and expect it to infer the right boundary.

| Entrypoint | Use for | May write | May read | Must not do |
| --- | --- | --- | --- | --- |
| `npm run wiki-agent` | wiki, paper, evidence, synthesis, page governance, manuscript coordination | `knowledge-base/pages/`, aliases, source/page indexes, paper-backed knowledge records, manuscript files through the paper-writing worker | local wiki, local paper library, design records/artifacts/summaries | direct design-code editing, dependency installation, layout-script execution |
| `npm run wiki-agent:rpc` | JSONL RPC wiki-agent for Feishu or another compatible bridge | same as `wiki-agent` | same as `wiki-agent` | same as `wiki-agent` |
| `npm run design-agent` | design/code/dependency/layout/verification work | `design-repo/design-code/`, `design-repo/design-records/`, declared design-code outputs | local wiki and local paper evidence through read-only retrieval tools | wiki page writes, paper downloads, web search, arbitrary workspace writes |
| `npm run design-agent:rpc` | JSONL RPC design-agent for local harnesses or future direct integrations | same as `design-agent` | same as `design-agent` | Feishu bridge default operation |

`npm run agent` and `npm run agent:rpc` are intentionally not public scripts. Use the specific entrypoint that matches the work.

The Feishu bridge is configured to connect to `wiki-agent:rpc` by default. Design work should be started separately with `npm run design-agent`. The design-agent can use wiki/paper retrieval tools for context, but it cannot update wiki pages; the wiki-agent later reads design-agent outputs and promotes durable conclusions into wiki pages and source summaries.

### Router Layer

The lower-level runtime still has a lightweight router layer for internal/routed-agent compatibility. Public users should not rely on a generic entrypoint to infer design work from natural language; start design/code/dependency/layout/verification work with `npm run design-agent`.

Inside the wiki/paper flow, the runtime detects high-confidence worker intents and runs the requested turn in a clean worker context with the corresponding boundary tools:

- manuscript editing, writing-quality review, or LaTeX requests -> `paper-writing-worker`
- PaperOrchestra-style full manuscript generation, outline, draft refinement, or submission-package requests -> `paper-writing-worker`
- paper search, paper download, acquisition fallback, and citation-metadata repair requests -> `paper-download-subagent`
- evidence construction, paper summarization, and source-summary relation requests -> `wiki-evidence-worker`
- chip-design/layout engineering requests, dependency installation, verification records, or design-failure cases -> use the separate `design-agent` entrypoint

Explicit prefixes are still supported when precision matters inside routed/internal contexts: `paper write ...`, `paper download ...`, `download paper ...`, `wiki evidence ...`, `evidence ...`, `/paper-writing-worker ...`, `/paper-download-subagent ...`, and `/wiki-evidence-worker ...`. If no wiki/paper worker route matches, the prompt goes to the wiki-agent coordinator.

Worker turns do not share the main agent's full context. The router runs each worker in a clean context, streams the worker's normal reply to the user, then injects a compact structured handoff back into the main context. The handoff records the worker role, instruction, route reason, status, changed files, produced artifacts, source/page/design-record paths, tools used, failed tools, final worker response, and the next suggested owner. This keeps the main chat history continuous without copying the worker's full tool transcript into the prompt.

### Repo Manager Boundary

The repo manager is a bridge-side service, not an LLM tool and not a worker. It owns controlled Git operations for configured workspaces:

- `repo status paper`
- `repo diff design`
- `repo log paper`
- `repo commit design 更新说明`
- `repo push design`

Configured repositories are `paper`, `design`, and optional `wiki`. The paper repository is configured with `BRIDGE_PAPER_WORKSPACE_DIR`; design and wiki use `BRIDGE_DESIGN_WORKSPACE_DIR` and `BRIDGE_WIKI_WORKSPACE_DIR`.

The recommended design workspace root is `design-repo/design-code/`. Point `BRIDGE_DESIGN_WORKSPACE_DIR` at `design-repo/design-code`. Keep executable design code, generated artifacts, and durable design records inside `design-repo/`; the wiki-agent can read them and publish curated summaries/manifests under `knowledge-base/` when they should become searchable evidence.

Automatic commit/push is still supported. When `BRIDGE_PAPER_GIT_AUTO_COMMIT=true`, the bridge snapshots the paper repo before an agent turn. If the repo was clean and the agent leaves changes, the bridge runs `git add -A` and commits with an `Auto paper update: ...` message. If `BRIDGE_PAPER_GIT_AUTO_PUSH=true`, it also pushes. If the repo was already dirty before the turn, automatic commit is skipped to avoid mixing user edits with agent edits.

Agents and workers should produce files. The repo manager decides when those files become Git commits.

### Wiki Agent Boundary

The wiki agent is the durable knowledge coordinator. It decides what concepts need pages, inspects gaps, requests evidence expansion, and maintains structure. In boundary mode it reads local wiki and local paper metadata, writes synthesis pages through `build_wiki_page`, and uses `wiki_lint` plus `wiki_structure_plan` plus `wiki_apply_structure_plan` for structural cleanup. Existing duplicate pages, including simple plural or compact spelling variants, should be merged and deleted rather than preserved as alias pages.

The current wiki core is schema-first:

- `workspace-contract.ts` defines the authoritative `knowledge-base/` lifecycle roots for raw inputs, source records, parse artifacts, summaries, pages, manifests, assets, runtime state, index, and human log.
- `page-schema.ts` and `typed-store.ts` parse, validate, list, and write human-editable Markdown pages with typed frontmatter. Supported page types include `paper-source`, `synthesis`, `concept`, `method`, `finding`, `dataset`, `question`, `capability-boundary`, `design-record`, and `alias`.
- `page-schema.ts` also owns the wiki evidence-audit contract. Pages can carry `knowledge_state`, `last_reviewed_at`, `freshness_audit`, `claims`, `typed_relations`, `experiment_refs`, and `reviewer_critique` metadata. Quantitative claims must point at concrete provenance such as a page, figure, table, parser element, chunk, or code-output path.
- `manifest-store.ts` and `retrieval-contract.ts` make source provenance and read-only downstream consumption explicit. Downstream agents can search/read wiki evidence without depending on the physical directory layout.
- `retrieval-search.ts` returns structured evidence matches, match reasons, stale/speculative/disputed warnings, preferred evidence-kind ordering, and insufficient-evidence status.
- `journal.ts` records multi-file wiki operations so interrupted writes can be reported by health checks.
- `coordinator.ts` plans wiki-agent work with explicit owner assignments such as `paper-download-subagent`, `wiki-evidence-worker`, `wiki-synthesis-worker`, and `wiki-agent`.
- `domain-bindings.ts` provides a metadata-only registry for validated executable helper bindings. Bindings are described in typed page metadata; arbitrary page content is not executed.

In fixed-evidence benchmark mode, the wiki agent should not directly download papers, run web search, or author raw source summaries. Those are assigned to subagents/workers so page construction can be benchmarked under fixed evidence. Clean-context paper-summary and wiki-page-draft passes are treated as `wiki-evidence-worker` responsibilities, not separate durable worker roles.

### Evidence Flow

The intended workflow keeps production and curation separate:

```text
paper-download-subagent -> wiki-evidence-worker -> wiki-agent -> paper-writing-worker
acquisition/raw/parses  -> sources/*/summary.md + page drafts -> pages/*.md -> manuscript files

design-agent -> design-code/artifacts/records -> wiki-agent -> curated wiki pages
layout code  -> GDS/logs/reports/records    -> evidence-backed synthesis
```

For model benchmarks, give workers fixed `sources` fixtures and evaluate page synthesis without allowing autonomous evidence acquisition.

## Usage Modes

### Feishu Bridge Mode

Use this for real chat operation, per-chat memory, PDF delivery, and repo manager commands.

```sh
cp docs/feishu-bridge.env.example .env
npm run feishu-bridge
```

The bridge starts the repository wiki-agent RPC entrypoint by default (`node dist/src/wiki-agent.js --mode rpc`). Set `PI_COMMAND` only when the bridge should target another compatible wiki-agent RPC process. Design work should be run separately with `npm run design-agent`, outside the Feishu bridge.

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

Use `wiki-agent` for local interactive wiki/paper work:

```sh
export OPENAI_API_KEY="your-key"
export PI_PROVIDER="openai"
export PI_MODEL="gpt-5.4"
npm run wiki-agent
```

PowerShell equivalent:

```powershell
$env:OPENAI_API_KEY="your-key"
$env:PI_PROVIDER="openai"
$env:PI_MODEL="gpt-5.4"
npm run wiki-agent
```

You can also pass model settings as CLI arguments:

```sh
npm run wiki-agent -- --provider openai --model gpt-5.4
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

Use `design-agent` for local interactive design/code/dependency/layout/verification work:

```sh
npm run design-agent -- --provider openai --model gpt-5.4
```

Typical design-agent requests are:

```text
> add gdsfactory as a design-code dependency, sync the shared venv, and verify the import
> create a reusable resonator layout module under design-repo/design-code/src/pi_chip_design/
> run the layout script and verify the declared GDS output
> write a verification report for the failed coupler-spacing attempt
```

The design-agent writes design code only through the design-code file tools, installs declared Python dependencies through `uv sync` into the repository root `.venv`, and runs scripts through the `bwrap`-sandboxed `run_design_script` tool. It can retrieve local wiki/paper evidence, but it cannot call `build_wiki_page`, write `knowledge-base/pages/`, download papers, or use a general shell.

The wiki-agent handles wiki and paper workflows. For manuscript edits or writing-quality review, either ask naturally in the wiki/paper flow or prefix the request with `paper write` when you want an explicit paper-writing worker route:

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

For PaperOrchestra-style workflows, keep the writing workspace under a private paper project, for example `paper-projects/current/paper-orchestra/`. The worker can prepare and validate the controlled layout, run draft gates, apply refinement accept/revert decisions, and write a provenance snapshot, while upstream paper acquisition and wiki evidence construction remain owned by the download and evidence workers.

Other explicit worker routes:

```text
> paper download latest superconducting qubit chip design papers
> wiki evidence 总结 arxiv-2406.06015 并维护 related_papers
```

Start design/code/dependency/layout/verification work with `npm run design-agent`; do not route those tasks through wiki-agent chat examples.

Use `exit` or `quit` to stop. Conversation history is kept in memory for the current process only.

### Non-Interactive Chat

The agent accepts stdin input. Each non-empty line is one prompt:

```sh
printf '%s\n' \
  "hello" \
  "read README.md and summarize it" \
  "exit" | npm run wiki-agent -- --provider openai --model gpt-5.4
```

Blank lines are ignored. EOF ends the process cleanly.

### RPC Mode

Use this when another local bridge or harness wants to drive the same agent process. Feishu should use the wiki-agent RPC entrypoint:

```sh
npm run wiki-agent:rpc -- --provider openai --model gpt-5.4 --session-dir .memory/pi-sessions/example
```

Local design harnesses should use the design-agent RPC entrypoint instead:

```sh
npm run design-agent:rpc -- --provider openai --model gpt-5.4 --session-dir .memory/pi-sessions/design-example
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

The tool registry supports compact/full profiles plus strict boundary profiles. Public CLI entrypoints use boundary profiles, not the generic default surface. Development and benchmarks can use `createTools(workspaceDir, { toolProfile: "full" })` for the full profile, or `createToolsForBoundary(workspaceDir, role)` for role-isolated worker surfaces.

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

- `answer_paper_wiki_question`: local-wiki-only Q&A over wiki source summaries and synthesis pages. It preserves evidence warnings, including stale, speculative, disputed, or low-confidence evidence, so conclusions can report uncertainty before synthesis.
- `answer_research_question`: evidence-first research workflow; checks local wiki first, then acquires external evidence only when needed. Tool details include `evidenceStatus`, local/new evidence items, limitations, and a coordination plan explaining which worker owns each step.
- `bootstrap_wiki_page_evidence`: prepares source evidence for a new topic page before a page exists, reports missing summaries, and returns coordination metadata for fixed-evidence page construction.
- `build_wiki_page`: writes durable synthesis pages under `knowledge-base/pages/` from a fixed local evidence pack. It keeps source summaries for recall/compression, adds selected raw chunks, claim-level provenance, and contradiction notes when available, and supports explicit evidence contracts, minimum source counts, required source keys, external-evidence blocking, optional write-after lint verification, page-worker draft generation, and coordination metadata.
- `merge_wiki_aliases`: creates deliberate alias pages for acronyms or synonyms that are not existing duplicate pages. Existing duplicate pages, including simple plural or compact spelling variants, should instead go through `wiki_lint`, `wiki_structure_plan`, and `wiki_apply_structure_plan` so the redundant page is merged and deleted.
- `clarify_research_topic`: turns an ambiguous research request into concrete subtopics and evidence needs
- `research_topic_bootstrap`: creates an initial evidence plan for a research topic
- `expand_research_topic`: expands a topic through discovered gaps and related references
- `search_paper_wiki`: full-mode direct retrieval over source summaries and synthesis pages. Search uses structured wiki evidence scoring before falling back to legacy body search for weak matches. It accepts `sourceKinds`, `pageTypes`, `claimKinds`, `knowledgeStates`, `evidenceContracts`, and `maxEvidenceAgeDays` filters for deterministic evidence slicing.
- `wiki_review_page`: deterministic adversarial review for a typed page. It reports unsupported or weakly supported claims, stale evidence, speculative/disputed state, missing caveats, malformed quantitative provenance, and other evidence-contract risks before a page is treated as settled knowledge.
- `write_paper_wiki_source`: full-mode source-summary writer
- `generate_paper_wiki_summary`: full-mode clean-context source summary generation
- `paper_wiki_relations`: full-mode relation discovery and `related_papers` maintenance

The key distinction is that `sources/*/summary.md` are evidence summaries for individual papers, while `pages/*.md` are durable typed cross-paper knowledge pages. Source manifests under `manifests/` tie wiki-facing summaries back to acquisition records, parser artifacts, quality reports, hashes, tags, and status.

Wiki pages may also include evidence-audit metadata:

- `knowledge_state`: one of `established`, `promising_unverified`, `speculative`, or `disputed`.
- `last_reviewed_at`: ISO date used by search/review tools to warn about stale evidence when a caller supplies `maxEvidenceAgeDays`.
- `claims`: per-claim provenance records. Quantitative claims require concrete original-location or code-output evidence.
- `typed_relations`: typed graph edges to pages, sources, experiments, or code, with candidate/confirmed/rejected status.
- `experiment_refs`: workspace-relative local scripts, commands, logs, result files, and artifacts that support or test a page.
- `reviewer_critique`: structured critique items for likely reviewer objections and the suggested fix.

This is deterministic schema, retrieval, review, and lint support. It does not run background freshness checks, poll arXiv/publishers/GitHub on a schedule, or execute third-party paper repositories automatically. Freshness is explicit: tools warn only when the caller asks for an evidence-age threshold.

### Wiki Maintenance Tools

- `wiki_health`: reports acquisition state, downloads, authorization state, parse quality, incomplete `source.json` citation metadata, missing summaries, missing artifacts, missing source manifests, unsafe or missing manifest artifact paths, malformed typed wiki pages, weak evidence contracts, and interrupted wiki operations.
- `wiki_health_fix`: orchestrates supported repairs. Download and citation-metadata repairs go through the paper-download-subagent boundary; citation refresh first reuses local parse artifacts, then uses arXiv/Crossref metadata when an identifier is available. Parsing stays in the ingestion path; missing summaries go through the `wiki-evidence-worker` summary pass; missing source manifests can be backfilled from existing source summaries.
- `wiki_lint`: checks wiki structure, source-to-page coverage, repeated concept gaps, evidence-contract gaps, typed `source_refs`, semantic alias candidates, low-risk singular/plural or compact-spelling duplicate page merge candidates, existing simple alias pages that should be deleted, medium-risk source-backed contained-concept duplicate candidates, scope drift, stale index entries, broken links, missing citations, orphan pages, duplicate titles, repeated sections, weak uncited pages, rendered wiki-link failures, ready source summaries not covered by synthesis pages, missing knowledge states, missing review dates, disputed pages without contradiction evidence, missing quantitative claim provenance, unresolved contradiction candidates, legacy `related_pages` without typed relations, broken experiment references, and code-backed pages without experiment refs. Goal/focus options can prioritize concept gaps for a current research direction. Default issue display is capped per issue kind before applying the final response-size cap, so many concept gaps cannot hide duplicate-page cleanup candidates.
- `wiki_structure_plan`: turns `wiki_lint` findings into a reviewable, budgeted, goal-aware maintenance plan with owner, risk, recommended tool args, and verification actions. It suggests low-risk actions by default, including deterministic duplicate concept-page merges such as singular/plural page pairs and compact spellings like `su2`/`su-2`, and does not rewrite wiki content. Its `maxItems` cap limits primary maintenance actions; verification actions are appended separately so they do not displace cleanup work.
- `wiki_apply_structure_plan`: applies approved low-risk `wiki_structure_plan` actions with dry-run, preflight, journal, and verification safeguards. Supported writes are deterministic duplicate-section cleanup, safe duplicate-page merge and deletion with inbound-link rewrites, cleanup of existing simple alias pages, safe deliberate alias creation, deterministic index rebuild, and constrained `## Scope Note` updates.

### Wiki Evidence Tools

- `generate_paper_wiki_summary`: builds a bounded evidence package from parsed paper Markdown and sends it through the `wiki-evidence-worker` summary pass
- `write_paper_wiki_source`: writes grounded per-paper source summaries under `sources/*/summary.md`
- `paper_wiki_relations`: proposes or applies related-paper links among local source summaries

`paper-summary-worker` and `wiki-page-worker` are not separate runtime roles. Their clean-context behavior is implemented as `wiki-evidence-worker` subtasks: one summary pass for per-paper evidence and one fixed-evidence page-draft pass used by the wiki agent before final page promotion.

### Design And Paper-Writing Tools

- `write_design_artifact`: full-mode / design-agent tool that writes structured design records, verification reports, failure records, and benchmark cases under `design-repo/design-records/`
- `sync_design_environment`: full-mode / design-agent tool that runs `uv sync` for `design-repo/design-code/` while forcing the shared repository root `.venv` as the Python project environment. This is not a general shell and cannot sync arbitrary projects.
- `run_design_script`: full-mode / design-agent tool that runs `.py` layout or verification scripts from `design-repo/design-code/` in a `bwrap` sandbox with a writable temporary design-code copy, then copies back only declared design-code outputs. For Python scripts it requires the repository root `.venv/bin/python`; if it is missing, run `sync_design_environment` first. KLayout scripts still run through `klayout -b -r`.
- `load_paper_writing_skill`: full-mode / paper-writing-worker tool that loads worker-scoped writing prompt modules such as `skills/paper-writing-worker/sciwrite/prompt.md`
- `paper_orchestra_prepare_workspace`: full-mode / paper-writing-worker tool that creates and validates the controlled PaperOrchestra writing workspace layout
- `paper_orchestra_check_draft`: full-mode / paper-writing-worker tool that runs orphan-citation, LaTeX sanity, and anonymous anti-leakage draft gates
- `paper_orchestra_score_delta`: full-mode / paper-writing-worker tool that applies PaperOrchestra refinement accept/revert/plateau halt rules to score JSON files
- `paper_orchestra_snapshot_provenance`: full-mode / paper-writing-worker tool that writes input/final artifact hashes to `provenance.json`
- paper-writing-worker tools: project-local writing skill loading, manuscript file reading/writing, PaperOrchestra writing gates, LaTeX compilation, local wiki retrieval, and wiki-grounded Q&A
- `get_time`: full-mode diagnostic tool for checking the current local time

The design-agent is the engineering owner for executable layout code, dependency declarations, bounded verification scripts, and design records. It works in the nested `design-repo/design-code/` repository, declares Python dependencies there, uses `sync_design_environment` to run `uv sync` into the root `.venv`, executes only bounded design-code scripts through `run_design_script`, and returns artifacts or records to the wiki-agent for durable curation. It is the right owner for installing packages such as `gdsfactory`: the agent updates `design-repo/design-code/pyproject.toml`, runs `uv sync` into `.venv`, verifies imports, and then uses that shared interpreter for layout scripts. `design-subagent` remains an accepted compatibility alias.

Design code, reusable Python packages, scripts, generated-layout setup, and design notes should live under `design-repo/design-code/`. This directory is a separate Git repository alongside the wiki knowledge base. Keep one Python environment at the repository root `.venv` so `run_design_script` uses the same interpreter regardless of whether the agent was started from WSL, Feishu bridge, or another entrypoint.

### Tool Profiles And Worker Boundaries

| Surface | Purpose | Exposes | Does not expose |
| --- | --- | --- | --- |
| `default` | interactive agent surface | compact file, web, paper, wiki, health tools | full diagnostics and raw source writers |
| `full` | development and diagnostics | all default tools plus raw paper/wiki/design utilities | no extra filesystem escape permissions |
| `wiki-agent` | durable knowledge coordinator | local wiki search, page construction, aliases, wiki health/lint, paper search/download | web search, source-summary generation |
| `paper-download-subagent` | literature acquisition | search/download, browser/manual fallback, webpage capture, local-parse/arXiv/Crossref citation metadata refresh, parsing, health repair | wiki page writes, source-summary authoring |
| `wiki-evidence-worker` | evidence construction | source summaries, relation maintenance, fixed-evidence page draft output | paper download, external search, autonomous acquisition |
| `design-agent` | chip-design/layout engineering | `list_files`/`read_file` for inspection; local wiki/paper retrieval; bounded dependency management via `update_design_dependency`; root `.venv` sync via `sync_design_environment`; import verification via `verify_design_python_import`; design-code write/replace under `design-repo/design-code/` via `write_design_code_file` and `replace_design_code_file_text`; isolated design-code `run_design_script`; `write_design_artifact` | web search, paper download, wiki page writes, arbitrary file writes |
| `paper-writing-worker` | manuscript writing | project-local writing skills, manuscript read/write, PaperOrchestra workspace/gate/provenance tools, LaTeX compile, wiki retrieval/Q&A | paper download, source-summary generation, wiki page construction, web search |

Use the boundary APIs in benchmarks so each model is evaluated under the same tool surface.

`design-subagent` is retained only as a compatibility alias for older prompts and bridge integrations; public worker handoff records use `design-agent`.

The main wiki/research tools also return compact coordination metadata. This is meant for agents and bridge logs: it records the detected intent, the decision path, ordered steps, worker owners, blocked/insufficient-evidence reasons, and the suggested next owner. `wiki-synthesis-worker` is a logical owner label for synthesis/page-writing steps, not a separate router prefix or durable runtime role. Coordination metadata is not a replacement for the worker boundary; it is an audit trail for why the boundary was chosen.

## Knowledge Base Layout

By default the local knowledge base lives in `knowledge-base/`, which is gitignored. Set `PI_KNOWLEDGE_BASE_DIR=/absolute/path/to/knowledge-base` to move it into a private knowledge repository or large data volume.

```text
knowledge-base/
  raw/pdfs/                         # original PDFs
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

Design-agent-owned code, records, and generated artifacts live in sibling `design-repo/`. The wiki-agent may read those assets and curate wiki-facing summaries or manifests under `knowledge-base/`, but it should not edit design assets directly.

Typed wiki pages remain normal Markdown files with frontmatter, so humans can edit them directly. The typed store validates the metadata and reports malformed or weak-evidence pages through `wiki_health` / `wiki_lint` instead of making every read fail.

Evidence-audit metadata is stored in the same page frontmatter. Use workspace-relative paths in `experiment_refs`; absolute paths and `..` escapes are rejected by the schema validator. Use `typed_relations` for graph semantics and keep `related_pages` only as legacy compatibility.

## Design Project Layout

Design code workspaces live in `design-repo/`, alongside `knowledge-base/`. Do not create a top-level `design-projects/` tree, and do not create per-design-project virtual environments. The shared Python environment is the repository root `.venv`.

```text
design-repo/
  design-code/                    # separate Git repository
    README.md
    pyproject.toml
    uv.lock
    src/pi_chip_design/
    tests/
    outputs/
```

Use `design-repo/design-code/` for maintained executable design code, Python package modules, simulations, generated-layout scripts, and project-local tests. Use `design-repo/design-records/` for structured design evidence. These are design-agent-owned assets; `knowledge-base/` remains wiki-agent-owned and should only contain distilled wiki knowledge pages that cite design assets when the wiki-agent promotes design results.

`design-repo/design-code/` is a nested Git repository and should be treated as its own design-code package, not as normal source inside the TypeScript repo. The bridge-side repo manager can point `BRIDGE_DESIGN_WORKSPACE_DIR` at this directory when design code needs independent status/diff/commit/push operations.

Use `design-repo/design-artifacts/<experiment-key>/` for design-agent experiment outputs and design-side source records. These are not wiki source summaries; they stay in the design repository until the wiki-agent distills them into durable knowledge pages. The path contract is:

```text
design-repo/design-artifacts/<experiment-key>/
  README.md   # concise design-side source summary and scope
  manifest.json
  code/       # runnable experiment scripts, notebooks, and small helper modules
  layouts/    # generated layout data such as GDS/OAS/DXF
  logs/       # DRC/LVS/simulation/tool logs
  results/    # extracted metrics, tables, reports, screenshots, and summaries
```

Do not create `knowledge-base/sources/design-artifact-*` entries. When a design result becomes useful to the wiki, the wiki-agent should read the design artifact and write a highly condensed `knowledge-base/pages/` knowledge entry with explicit citations back to `design-repo/design-artifacts/...`.

The initial design workspace is the `pi_chip_design` Python package under `design-repo/design-code/`. It should hold reusable layout-generation and verification code, with layout families added under `src/pi_chip_design/layouts/`. Its local development setup uses `uv` to sync dependencies into the repository root virtual environment:

```sh
UV_PROJECT_ENVIRONMENT="$PWD/.venv" uv sync --project "$PWD/design-repo/design-code" --extra dev
```

The design-agent normally performs this through `sync_design_environment`; it does not require the parent agent process to activate this environment. `run_design_script` requires the repository root `.venv/bin/python` and the local `bwrap` sandbox command, runs scripts from an isolated copy of `design-repo/design-code/`, copies back only declared design-code outputs, and reports that `sync_design_environment` should be run first if the root interpreter is missing.

The design-agent must not call `pip install` directly, create `design-repo/design-code/.venv`, or install into a design-project-local environment. Dependency requests should be handled as declarative `pyproject.toml` changes followed by `sync_design_environment` and import/script verification.

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
npm run wiki-agent -- --provider openai --model gpt-5.4
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

By default the Feishu bridge starts the built-in wiki-agent RPC command. Leave it that way for normal chat operation so Feishu can update wiki/paper knowledge but cannot accidentally run design-code package installation or layout scripts. Use `PI_COMMAND` only to point at another compatible wiki-agent RPC process; do not point Feishu at `design-agent:rpc` unless you are intentionally building a separate design-only bridge.

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
- `npm run wiki-agent`: build and start the wiki/paper terminal chat / REPL agent
- `npm run wiki-agent:rpc`: build and start the wiki-agent JSONL RPC process used by Feishu
- `npm run design-agent`: build and start the design/code/dependency/layout/verification terminal chat / REPL agent
- `npm run design-agent:rpc`: build and start the design-agent JSONL RPC process for local harnesses
- `npm run agent` and `npm run agent:rpc`: intentionally absent; choose `wiki-agent` or `design-agent`
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
