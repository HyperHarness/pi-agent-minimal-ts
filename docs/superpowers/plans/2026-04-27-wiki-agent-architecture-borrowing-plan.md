# Wiki Agent Architecture Borrowing Plan

Date: 2026-04-27

## Context

`/home/ququan2/wiki_agent` is a more mature knowledge-workspace prototype than the current paper LLM wiki in `pi-agent-minimal-ts`. It is not just a paper downloader. Its strongest design is a durable knowledge system around agentic ingestion, retrieval, maintenance, and downstream consumption.

The current `pi-agent-minimal-ts` paper workflow now uses `knowledge-base/` by default, with optional relocation through `PI_KNOWLEDGE_BASE_DIR`:

```text
knowledge-base/
  raw/pdfs/
  records/
  wiki/
    sources/
    pages/
    manifests/
    assets/
    index.md
    log.md
```

The next optimization should keep this compact, movable layout, while borrowing the parts of `wiki_agent` that make knowledge safer, more maintainable, and easier for other agents to consume.

## What `wiki_agent` Does Well

### 1. Explicit Knowledge / Workspace Boundaries

`wiki_agent` separates durable knowledge from runtime state:

```text
knowledge/
  schema.md
  wiki/
  scripts/
  source-manifests/
workspace/
  raw/
  cache/
  state/
```

The important idea is not the exact directory names. The important idea is lifecycle separation:

- durable knowledge is small, curated, and readable by downstream agents
- raw files and extraction cache are local artifacts
- runtime logs and WAL state do not pollute the knowledge layer

For `pi-agent-minimal-ts`, the `knowledge-base` structure preserves this by treating:

- `raw/pdfs/` as immutable original PDFs
- `sources/<paper-key>/` as parser evidence for each paper source
- `sources/<paper-key>/summary.md` as the retrieval source summary layer
- `pages/` as higher-level synthesis
- `state/` as future WAL/status state if needed

### 2. Typed Path Resolver

`wiki_agent` centralizes path construction in `src/lib/project-paths.ts`. This prevents modules from re-encoding storage rules.

The current paper wiki code has path helpers in `paper-wiki-store.ts` and reader helpers in `paper-reader-store.ts`, which is already a good start. The next step is to promote these into one typed paper workspace path object so reader, wiki, source manifests, maintenance, and tools all share the same layout contract.

### 3. Versioned Source Manifests

`wiki_agent` stores `knowledge/source-manifests/<source_id>.json` with:

- source ID
- source kind
- SHA-256
- original filename
- page count
- warnings
- derived pages
- selected assets
- acquisition provenance

This is highly relevant. The current paper reader stores `source.json`, `parse.json`, `quality.json`, and markdown intermediates, but the final `sources/<paper-key>/summary.md` layer does not yet have a compact sibling manifest that explains all derived durable artifacts in one machine-readable place.

Borrowing this would make it easier to audit a paper, rebuild sources, and answer questions such as: which parser generated this source summary, which raw PDF hash was used, and which source summaries depend on this paper?

### 4. Frontmatter Schema and Page Types

`wiki_agent` models wiki pages as typed markdown pages:

- `sources`
- `concepts`
- `devices`
- `formulas`
- `design-rules`
- `procedures`
- `analyses`
- `open-questions`
- `assets`

Each page has frontmatter fields such as `slug`, `title`, `page_type`, `aliases`, `tags`, `source_refs`, `citations`, and `updated_at`.

The paper LLM wiki should borrow the schema discipline, but not copy the superconducting-chip-specific categories wholesale. A better scientific-paper schema is:

- `paper-source`: one curated summary per paper
- `concept`: reusable scientific concept
- `method`: experimental or computational method
- `finding`: durable claim supported by papers
- `dataset`: data or benchmark
- `figure`: selected visual evidence or extracted asset
- `question`: unresolved issue
- `synthesis`: cross-paper analysis

### 5. Read-Only Downstream Contract

`wiki_agent` has `src/downstream/read-contract.ts`, which exposes only safe read operations:

- search wiki
- read page
- list executable formula bindings
- load a validated helper

This is one of the most useful ideas for an LLM wiki. `pi-agent-minimal-ts` should expose a paper wiki read contract that downstream agents can use without knowing the internal PDF parser cache layout.

Suggested contract:

- `searchPaperSources(query)`
- `readPaperSource(paperKey)`
- `listPaperSources(filters)`
- `readSourceManifest(paperKey)`
- `searchPaperWikiPages(query, pageType?)`
- later: `readEvidenceSpan(paperKey, sectionOrChunkId)`

### 6. WAL, Status, Maintain, and Repair

`wiki_agent` tracks multi-file operations in a markdown WAL and has tools for:

- status
- maintenance scan
- repair
- index rebuild

This is worth borrowing before the paper wiki becomes large. The current paper wiki writes source summaries and index/log files, but it does not yet have operation recovery or quality scans.

For paper reading, WAL is useful for operations that touch multiple files:

- parse PDF
- write paper source summary
- rebuild index
- promote assets
- generate cross-paper synthesis

Maintenance checks should catch:

- source summary points to missing parse artifacts
- `pdf_sha256` mismatch
- stale summary after a newer parse
- broken related-paper links
- source with no tags or no key findings
- duplicate paper keys for the same SHA-256

### 7. Query Fallback and Acquisition Orchestration

`wiki_agent` has a clean query flow:

1. search local wiki
2. if insufficient evidence, auto-acquire open-access papers
3. ingest successful downloads
4. query again
5. answer only from ingested wiki evidence

`pi-agent-minimal-ts` already has stronger browser/session-based paper download capability. The borrowable idea is the two-pass evidence workflow, not the exact provider code. The future paper agent should avoid answering from raw network search results when the question is scientific; it should import or summarize source material into the wiki first, then answer from the wiki.

### 8. UI / Backend Separation

`wiki_agent` separates:

- TUI rendering
- direct deterministic backend
- pi runtime backend
- local REPL fallback

This is useful later, but not the immediate priority for `pi-agent-minimal-ts`. The current paper work should first stabilize the storage, source schema, and maintenance contract. UI backend separation can wait until the paper-reading workflow is good enough to expose interactively.

## Main Gaps in Current Paper LLM Wiki

- Path helpers are split between reader and wiki modules rather than one paper workspace contract.
- `sources/<paper-key>/summary.md` is useful, but not validated against a typed source schema.
- There is no separate source manifest layer for final LLM-authored source summaries.
- Search is currently simple substring search over source markdown.
- There is no maintenance tool for stale, broken, duplicate, or low-quality paper wiki entries.
- There is no repair tool to rebuild index/log state after partial writes.
- Parser quality reports exist, but they are not yet integrated into source-summary freshness checks.
- The retrieval source layer and future synthesis page layer are not yet separated by typed page categories.

## Optimization Plan

### Phase 1: Consolidate Paper Wiki Paths and Manifests

- [x] Add a typed knowledge-base path resolver for `knowledge-base` and `PI_KNOWLEDGE_BASE_DIR`.
- [ ] Move shared path knowledge out of ad hoc reader/wiki helper functions where practical.
- [ ] Add `wiki/manifests/<paper-key>.json` for final source-summary provenance.
- [ ] Include raw PDF path, PDF SHA-256, parser engine, parse artifact paths, source summary path, tags, related papers, quality score, and update timestamps.
- [ ] Keep existing `source.json`, `parse.json`, and `quality.json` for parser intermediates.
- [ ] Add tests for path resolution and manifest round-trip behavior.

### Phase 2: Introduce Typed Markdown Source Pages

- [ ] Define a `PaperWikiPage` type with frontmatter validation.
- [ ] Start with `page_type: "paper-source"` for files under `sources/`.
- [ ] Require `paper_key`, `title`, `pdf_sha256`, `parse_engine`, `source_refs`, `tags`, `updated_at`, and `citations`.
- [ ] Replace regex-only frontmatter reads with a small parser/validator adapted from `wiki_agent`.
- [ ] Keep markdown human-editable and compact.
- [ ] Add tests that malformed source summaries are skipped or reported without breaking search.

### Phase 3: Add Maintain, Repair, and Status Tools

- [ ] Add `paper_wiki_status` to report source count, parser count, stale summaries, duplicate hashes, and broken links.
- [ ] Add `paper_wiki_maintain` to list quality issues without mutating files.
- [ ] Add `paper_wiki_repair` to rebuild `index.md`, normalize manifest/index drift, and mark interrupted operations if WAL is added.
- [ ] Add checks for missing parse artifacts, missing raw PDF, SHA mismatch, empty key findings, and broken related-paper references.
- [ ] Add tests around intentionally broken wiki states.

### Phase 4: Add Operation WAL for Multi-File Writes

- [ ] Add `state/wal.md` and keep `log.md` as human chronology.
- [ ] Record planned files before parse/write/repair operations that mutate more than one file.
- [ ] Mark operations completed after all writes succeed.
- [ ] Make `paper_wiki_status` surface interrupted operations.
- [ ] Make `paper_wiki_repair` mark interrupted operations as failed and rebuild derived indexes.

### Phase 5: Improve Retrieval Beyond Substring Search

- [ ] Keep the current substring search as the zero-dependency fallback.
- [ ] Add structured scoring over title, aliases, tags, key findings, limitations, and open questions.
- [ ] Search `sources/` first, then `wiki/` synthesis pages.
- [ ] Return citations using paper key plus source section or chunk ID.
- [ ] Later add embeddings only after the typed source layer and manifests are stable.

### Phase 6: Promote Cross-Paper Wiki Pages

- [ ] Keep `sources/<paper-key>/summary.md` as the atomic evidence source.
- [ ] Add `wiki/concepts/`, `wiki/methods/`, `wiki/findings/`, `wiki/questions/`, and `wiki/syntheses/`.
- [ ] Require every synthesis page to cite paper-source pages, not raw parser markdown.
- [ ] Add index sections by page type, modeled after `wiki_agent`'s automatic index builder.
- [ ] Add `write_paper_wiki_page` only after source-summary schema validation is reliable.

### Phase 7: Connect Download, Parse, Summarize, Query as One Evidence Loop

- [ ] Add a high-level flow that can answer a scientific question by checking paper wiki sources first.
- [ ] If insufficient, use existing paper search/download tools to acquire candidate papers.
- [ ] Parse downloaded PDFs into `sources/<paper-key>/`.
- [ ] Ask the LLM to write grounded `sources/<paper-key>/summary.md` summaries.
- [ ] Re-run retrieval against the source layer.
- [ ] Never cite downloaded metadata or raw search results directly as final scientific evidence.

## Recommended Priority

Do not start with embeddings or a complex UI. The next concrete implementation should be:

1. `PaperWorkspacePaths`
2. final source manifests
3. typed source page validation
4. maintain/status tools
5. better structured search

This preserves the compact knowledge-base design while importing the strongest parts of `wiki_agent`: provenance, repairability, durable contracts, and evidence-first retrieval.
