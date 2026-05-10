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
- `index.md` can degrade into a source-summary bibliography when no synthesis pages exist, which makes the wiki look like a download catalog rather than a knowledge-entry layer

## Minimal Scope

### Query

Extend `searchPaperWiki` so it searches:

- `knowledge-base/sources/<paper-key>/summary.md`
- `knowledge-base/pages/<page-key>.md`

Results carry a `kind` of `source` or `page`, plus a stable key. Existing source-summary callers continue to work.

### Lint

Add a deterministic `wiki_lint` tool for markdown/wiki structure. It reports:

- `stale_index`: source or page file missing from `index.md`
- `broken_wiki_link`: markdown link to a missing wiki file
- `missing_source_citation`: synthesis page frontmatter cites a missing source path
- `orphan_page`: synthesis page has no related pages or inbound page links
- `concept_gap`: a repeated source tag has no corresponding synthesis page

This is intentionally separate from `wiki_health`, which remains responsible for download, authorization, parse, and summary quality.

### Index

Keep `knowledge-base/index.md` as a knowledge-entry table of contents over `pages/`. It may report source-summary counts and link to `sources/`, but it should not enumerate every paper source. The full source layer remains searchable through `search_paper_wiki` and citeable from synthesis pages.

### Build

`build_wiki_page` can use source and page evidence in draft mode. Write mode still requires at least one source summary citation so persisted pages stay grounded in atomic evidence.

### Bootstrap

When a topic page does not exist yet, retrieval cannot rely on page-first search. The bootstrap path uses source summaries as the temporary page layer:

1. Generate deterministic seed queries from the topic and question.
2. Search source summaries and any existing pages with each seed query.
3. Expand matched source summaries through `tags` and `related_papers`.
4. Search parsed/local papers as fallback only when source summaries are insufficient.
5. Report parsed papers that match the topic but still need source summaries.
6. Optionally generate those missing source summaries, then refresh the source-summary search before page synthesis.

## Deferred

- vector or hybrid retrieval
- claim-level source-span citation
- automatic page refactoring or rename-safe links
- contradiction detection by LLM worker
- multi-file write WAL
