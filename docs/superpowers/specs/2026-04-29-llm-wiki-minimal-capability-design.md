# LLM Wiki Minimal Capability Design

Date: 2026-04-29

## Goal

Fill the smallest useful gaps between the current paper wiki agent and Karpathy's `llm-wiki.md` pattern:

- raw paper sources remain immutable evidence
- LLM-authored source summaries and synthesis pages are durable wiki artifacts
- local wiki answers search both atomic source summaries and higher-level pages
- wiki maintenance can detect structural issues before the graph becomes hard to trust

## Current Gap

The agent already has paper acquisition, parsing, source summaries, wiki pages, health checks, and repair. The missing minimal pieces are:

- `pages/` are written but not searched as first-class wiki evidence
- `wiki_health` focuses on paper records and parse/summary state, not wiki graph structure
- repeated source tags do not create any signal that a durable concept page should exist
- broken page links and missing source citations are not diagnosed

## Minimal Scope

### Query

Extend `searchPaperWiki` so it searches:

- `knowledge-base/wiki/sources/<paper-key>.md`
- `knowledge-base/wiki/pages/<page-key>.md`

Results carry a `kind` of `source` or `page`, plus a stable key. Existing source-summary callers continue to work.

### Lint

Add a deterministic `wiki_lint` tool for markdown/wiki structure. It reports:

- `stale_index`: source or page file missing from `index.md`
- `broken_wiki_link`: markdown link to a missing wiki file
- `missing_source_citation`: synthesis page frontmatter cites a missing source path
- `orphan_page`: synthesis page has no related pages or inbound page links
- `concept_gap`: a repeated source tag has no corresponding synthesis page

This is intentionally separate from `wiki_health`, which remains responsible for download, authorization, parse, and summary quality.

### Build

`build_wiki_page` can use source and page evidence in draft mode. Write mode still requires at least one source summary citation so persisted pages stay grounded in atomic evidence.

## Deferred

- vector or hybrid retrieval
- claim-level source-span citation
- automatic page refactoring or rename-safe links
- contradiction detection by LLM worker
- multi-file write WAL
