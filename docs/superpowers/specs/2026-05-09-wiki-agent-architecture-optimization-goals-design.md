# Wiki Agent Architecture Optimization Goals

Date: 2026-05-09

## Goal

Redesign the `pi-agent-minimal-ts` wiki-agent architecture so the local knowledge base becomes a durable, auditable, downstream-consumable research substrate rather than a set of useful but loosely connected paper/wiki tools.

This spec intentionally describes the desired architecture and optimization direction before implementation difficulty is considered. Large changes to the current wiki-agent internals are allowed. The desired result should absorb the strongest ideas from `/home/ququan2/wiki_agent` while preserving the capabilities where `pi-agent-minimal-ts` is already stronger: paper acquisition, browser-assisted publisher access, parsing, source-summary generation, worker boundaries, Feishu/RPC operation, and manuscript/design workflows.

## Why `wiki_agent` Is Worth Borrowing From

`wiki_agent` is smaller and less capable than `pi-agent-minimal-ts` in paper acquisition, but its knowledge-base model is cleaner. Its most valuable design choice is that it treats the wiki as a long-lived engineering artifact with explicit lifecycle boundaries, schemas, provenance, status, repair, and read contracts.

The reasonable parts are:

- durable knowledge and runtime state are separated by lifecycle, not mixed by convenience
- every wiki page has typed frontmatter and a known page category
- source ingestion writes a compact machine-readable manifest that explains provenance and derived artifacts
- multi-file operations are recorded in a lightweight WAL before mutation
- status and repair can reason about interrupted operations instead of guessing from file presence
- downstream users consume a small read-only contract instead of depending on internal directory layout
- query behavior is evidence-first: search local wiki, acquire only when insufficient, ingest, then answer from the refreshed wiki
- executable domain helpers can be attached to validated wiki pages when knowledge must support calculation, not just prose
- UI/backend separation allows direct deterministic workflows and full agent-backed workflows to share the same user surface

The goal is not to copy its superconducting-chip-specific categories or its simpler downloader. The goal is to import its discipline around knowledge lifecycle, provenance, validation, and downstream contracts.

## Current `pi-agent-minimal-ts` Strengths

The current project already has several advantages that should remain central:

- strong paper-download and browser-extension flow, including publisher-specific handling
- local paper library with acquisition records, parse artifacts, quality reports, source metadata, and blocklist behavior
- `sources` as atomic source-summary evidence and `pages` as higher-level synthesis
- `answer_research_question`, `bootstrap_wiki_page_evidence`, and `build_wiki_page` as evidence-first workflows
- worker boundaries for paper download, wiki evidence, wiki synthesis, design, and paper writing
- Feishu bridge, JSONL RPC, CLI, and local wiki web viewer
- wiki lint, structure planning, alias pages, and self-optimization work already moving in the right direction

The redesign should build on these strengths rather than replace them with `wiki_agent`'s smaller runtime.

## Main Current Weaknesses

### 1. Knowledge Lifecycle Is Not Explicit Enough

`knowledge-base/` currently contains raw PDFs, source summaries, synthesis pages, manifests, state, and logs. This layout is usable, but the lifecycle contract is not strong enough:

- durable curated knowledge, raw immutable evidence, parser cache, and runtime state are not described as separate layers
- wiki code must know too much about concrete paths
- source artifacts and source summaries share nearby paths without a strong schema explaining their relationship
- tools can write multiple files without a central operation record

Target direction: define the knowledge base as a layered workspace with explicit lifecycle classes:

- raw immutable inputs
- parser and extraction artifacts
- source-summary evidence
- synthesis pages and aliases
- provenance manifests
- runtime state and WAL
- human chronology logs

The exact directory names may remain compatible with the current `knowledge-base/` layout, but the lifecycle contract should become first-class.

### 2. Wiki Markdown Is Under-Typed

The current wiki source and page files have useful frontmatter, but parsing and validation are local and partial. Different modules interpret fields such as `type`, `paper_key`, `tags`, `sources`, `related_pages`, and `related_papers` by ad hoc extraction.

Target direction: introduce typed wiki page models and a shared parser/validator:

- `paper-source`: one curated source summary per paper or source record
- `synthesis`: cross-source analysis or topic page
- `concept`: durable reusable concept
- `method`: experimental, computational, or workflow method
- `finding`: durable claim supported by sources
- `dataset`: benchmark, corpus, or data source
- `question`: unresolved issue or research gap
- `design-record`: durable design decision, failure, or verification result
- `alias`: redirect or synonym page

Every page type should share a common metadata core:

- stable key or slug
- title
- aliases
- tags
- citations or source references
- created and updated timestamps
- owning layer and evidence contract

Page-type-specific fields should be explicit rather than inferred from prose.

### 3. Source Provenance Is Fragmented

The paper subsystem stores acquisition, parse, quality, and source metadata, and the wiki source summary stores provenance fields in markdown. This is useful, but there is no final compact manifest tying the durable wiki source summary to all upstream artifacts.

Target direction: make `wiki/manifests/<source-key>.json` a required provenance layer for durable source summaries. A manifest should answer:

- what raw source or PDF produced this source summary
- which acquisition record and article URL were used
- which parser engine and parse artifact paths were used
- which PDF hash or raw content hash was summarized
- which quality report was accepted
- which markdown source summary was produced
- which synthesis pages cite this source
- which related sources, tags, and aliases were known at write time
- whether the source is blocked, stale, low quality, or citation-incomplete

The manifest should not replace existing acquisition or parse records. It should be the durable wiki-facing index over them.

### 4. Multi-File Operations Need Operation Semantics

Current workflows such as download-parse-summary, summary regeneration, page building, alias merge, index rebuild, and structure cleanup can touch several files. Failure leaves the system relying on later health/lint checks to infer what happened.

Target direction: add a lightweight wiki operation WAL:

- record operation id, intent, owner, planned files, start time, and inputs before mutation
- append completion, partial, failed, or cancelled outcome after mutation
- expose interrupted operations in wiki status
- let repair mark old interrupted operations and rebuild derived indexes
- keep the WAL human-readable and short enough for agents to inspect

This should become a baseline safety mechanism for all wiki-agent multi-file writes.

### 5. Read Contracts Are Too Implicit

Downstream consumers currently use tools such as `search_paper_wiki`, `answer_paper_wiki_question`, wiki lint, and file reads. That is powerful, but it requires workers to know too much about wiki internals.

Target direction: define a stable read-only contract for downstream agents:

- search source summaries
- read a source summary by key
- read a source manifest by key
- search synthesis/concept/method/finding pages
- read a wiki page by key
- list pages by type, tag, source citation, and evidence contract
- read citation/provenance metadata without opening parser artifacts
- later, read source spans or chunks when claim-level citation exists

Design-agent and paper-writing-worker should consume this read contract first. They should not depend on the physical storage layout except through deliberately exposed file paths.

### 6. Search and Query Need Stronger Structured Semantics

The current search implementation has useful weighted text matching and domain-specific synonym handling. It should evolve from document search toward structured evidence retrieval.

Target direction:

- score title, aliases, tags, key findings, limitations, open questions, and citations separately
- search atomic source summaries before synthesis pages when grounding factual claims
- search synthesis pages first when the user asks for orientation, maps, or prior conclusions
- return why each result matched
- return evidence type, confidence, freshness, and known quality warnings
- make insufficient evidence a first-class result, not just an empty search
- force final scientific answers to cite wiki evidence, not external search candidates

The `wiki_agent` two-pass pattern should remain the policy: local wiki first, acquire or summarize only when insufficient, then answer from refreshed wiki evidence.

### 7. Maintenance Should Become a Knowledge Governance Layer

`wiki_lint`, `wiki_structure_plan`, and related maintenance work are already moving in this direction. The next architecture should make governance a first-class wiki-agent responsibility.

Target direction:

- separate paper health from wiki structure health
- detect stale summaries after newer parse artifacts
- detect source summaries without manifests
- detect manifests whose referenced artifacts are missing
- detect pages with missing or weak evidence contracts
- detect repeated tags that deserve concept pages
- detect orphan pages, duplicate pages, near aliases, and rendered wiki links
- detect source summaries not covered by any synthesis page
- detect scope drift when a page title or summary keeps an outdated framing
- produce reviewable maintenance plans before writing
- keep deterministic low-risk fixes separate from LLM-authored rewrites

The wiki-agent should become the curator of structure and evidence quality, not just the writer of pages.

## Desired Architecture

### Layer 1: Knowledge Workspace Contract

Introduce a single authoritative knowledge workspace contract that defines roots and lifecycle categories. Existing path helpers should converge on this contract.

The contract should cover:

- raw inputs
- source records
- parse artifacts
- source summaries
- synthesis and typed pages
- assets
- manifests
- WAL and runtime state
- index and human log

This contract should be exported for tests and downstream integrations. Modules should not rebuild storage paths independently.

### Layer 2: Typed Wiki Store

Create a wiki store that owns:

- parse markdown frontmatter
- validate page schema
- serialize page schema
- list pages by type and filters
- skip or report malformed pages without breaking the entire wiki
- preserve human-editable markdown bodies

The store should not know how to download papers or call LLMs. It should own durable wiki file semantics.

### Layer 3: Source Manifest Store

Create a manifest store that owns:

- source manifest read/write
- provenance validation
- stale checks against parse and source-summary timestamps
- manifest-to-page and page-to-manifest relationships
- manifest status values such as `ready`, `stale`, `blocked`, `low_quality`, `citation_incomplete`, and `missing_artifact`

The manifest should be the bridge between raw acquisition artifacts and the durable wiki.

### Layer 4: Operation Journal

Create a wiki operation journal for multi-file mutations. It should be used by:

- source summary generation
- source summary refresh
- build wiki page
- merge aliases
- apply structure plan
- rebuild index
- repair

This layer should not make operations transactional in a database sense. Its job is observability, repairability, and agent comprehension.

### Layer 5: Evidence Retrieval Contract

Expose a read-only contract that hides implementation layout from downstream workers. It should support both structured retrieval and exact reads.

Consumers:

- wiki-agent
- design-subagent
- paper-writing-worker
- Feishu bridge workflows
- local wiki web viewer
- future benchmark harnesses

This contract should be the default path for downstream knowledge use.

### Layer 6: Wiki-Agent Coordinator

The wiki-agent should coordinate durable knowledge growth:

- inspect current wiki state
- decide whether a question needs source evidence, synthesis, or maintenance
- request paper-download-subagent only for acquisition gaps
- request wiki-evidence-worker only for source-summary construction
- write or revise synthesis pages only from fixed evidence
- plan maintenance before applying structural changes
- keep handoffs compact and machine-readable

It should not directly scrape web pages, download papers, parse PDFs, or author raw source summaries in benchmark/boundary mode.

### Layer 7: Domain Execution Bindings

Borrow `wiki_agent`'s idea of validated executable bindings where appropriate. A wiki page should be able to declare a validated helper for calculations or checks.

Initial target domains:

- quantum chip design formulas
- transmon and resonator estimates
- frequency allocation helpers
- layout or constraint checks
- benchmark scripts

Execution bindings should be optional and validated. Most wiki pages remain prose and evidence pages.

## Workflow Policy

### Scientific Question

1. Search local source summaries and typed pages through the read contract.
2. If enough local evidence exists, answer from local wiki only.
3. If evidence is insufficient, search/download/parse candidate papers through the existing paper-download path.
4. Generate missing source summaries through wiki-evidence-worker.
5. Write manifests for new or refreshed source summaries.
6. Re-run retrieval against the wiki.
7. Answer only from refreshed wiki evidence, with citations and evidence limitations.

### New Topic Page

1. Bootstrap evidence from source summaries, existing pages, related papers, and tags.
2. Identify missing source summaries or acquisition gaps.
3. Build a draft from fixed evidence.
4. Write only when source citations satisfy the page evidence contract.
5. Record the operation in WAL.
6. Update index and graph relationships.
7. Run lint/verification.

### Maintenance Session

1. Run status and lint.
2. Read manifests and detect provenance drift.
3. Rank issues by evidence risk and downstream impact.
4. Produce a reviewable structure plan.
5. Apply only low-risk deterministic changes automatically.
6. Route evidence gaps to wiki-evidence-worker or paper-download-subagent.
7. Record all multi-file writes in WAL.
8. Re-run verification and summarize remaining risks.

## Boundaries

### What Should Move Toward `wiki_agent`

- lifecycle-separated knowledge architecture
- typed page schema
- versioned source manifest
- WAL and repair semantics
- read-only downstream contract
- evidence-first query policy
- validated executable bindings for selected domain pages
- UI/backend event separation if the local wiki viewer becomes a workbench

### What Should Stay `pi-agent-minimal-ts` Specific

- browser-extension and Playwright publisher acquisition
- paper manager, blocklist, and license/authorization semantics
- paper-reader engines and parse quality gating
- worker boundary architecture
- Feishu bridge and RPC runtime
- manuscript and design workflow integration
- source-summary generation through worker isolation
- local wiki web graph and repo-specific operational commands

### What Should Not Be Optimized First

- embeddings before typed schema and manifests are stable
- complex UI before the knowledge contract is clean
- fully automatic LLM rewrites of existing pages without review
- moving all state into a database
- copying `wiki_agent` page categories exactly
- replacing the current downloader with the simpler `wiki_agent` open-access downloader

## Success Criteria

The redesigned wiki-agent architecture is successful when:

- every durable wiki source summary has a corresponding manifest
- every synthesis page declares an evidence contract and source citations
- malformed pages are reported without breaking wiki search
- multi-file wiki operations are visible in status and repairable after interruption
- downstream workers can search and read wiki evidence without knowing storage internals
- scientific answers clearly distinguish local evidence, newly acquired evidence, blocked acquisition, and insufficient evidence
- wiki maintenance can explain which pages, sources, manifests, and links are weak or stale
- index and graph views are derived artifacts, not the source of truth
- acquisition, parsing, evidence writing, synthesis writing, and paper-writing remain separate responsibilities

## Non-Goals

This optimization spec does not require:

- a new standalone repository
- replacing all current wiki tools at once
- abandoning the existing `knowledge-base/` path
- solving vector search immediately
- building a full TUI inside `pi-agent-minimal-ts`
- guaranteeing automatic repair for every failed operation
- making every wiki page executable

## Recommended Architectural Direction

The recommended direction is a schema-first wiki-agent redesign:

1. define the knowledge workspace contract
2. define typed wiki pages and parser/validator
3. require source manifests for durable source summaries
4. add operation WAL/status/repair semantics
5. expose a read-only downstream contract
6. refactor current wiki tools to use these layers
7. deepen retrieval, lint, and structure planning on top of structured data

This sequence makes the wiki more trustworthy before making it more autonomous. It also preserves `pi-agent-minimal-ts`'s existing advantage: strong acquisition and worker orchestration around a local research knowledge base.
