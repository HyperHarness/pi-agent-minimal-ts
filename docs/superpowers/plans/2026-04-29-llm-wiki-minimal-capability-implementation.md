# LLM Wiki Minimal Capability Implementation

Date: 2026-04-29

## Context

The current paper wiki already implements the core storage layout from the LLM wiki pattern, but query and lint still treat `pages/` as secondary. The goal is to make the abstract loop runnable with minimal new machinery:

1. ingest source summaries
2. query source summaries and synthesis pages
3. write useful query results back as pages
4. lint the wiki graph for obvious maintenance gaps

## Plan

- [x] Extend paper wiki search to include `wiki/pages/*.md`.
- [x] Preserve compatibility with existing source-summary search callers.
- [x] Add `wiki_lint` for stale index entries, broken links, missing citations, orphan pages, and repeated concept tags without pages.
- [x] Keep `wiki_health` focused on paper acquisition/parse/summary health.
- [x] Ensure `build_wiki_page` can draft from page evidence but writes only when source-summary citations are available.
- [x] Update the default tool profile so the agent can lint the wiki during normal chat.
- [x] Add focused tests for page search, wiki lint, and tool exposure.

## Non-Goals

- No embedding database.
- No LLM contradiction checker.
- No automatic page rewrite/repair beyond existing `build_wiki_page`.
- No new directory hierarchy beyond existing `wiki/pages/`.
