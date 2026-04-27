# Paper LLM Wiki Implementation Plan

Date: 2026-04-27

## Checklist

- [x] Keep existing paper download records compatible with previously downloaded PDFs.
- [x] Write new raw PDFs under `downloads/papers/raw/`.
- [x] Store parser artifacts under `downloads/papers/llm-wiki/intermediate/`.
- [x] Add wiki scaffold helpers for `schema.md`, `index.md`, `log.md`, `sources/`, `wiki/`, and `assets/`.
- [x] Add `write_paper_wiki_source` to persist LLM-authored source summaries with provenance.
- [x] Add `search_paper_wiki` to retrieve from source summaries.
- [x] Cover the new paths and wiki source flow with tests.
- [x] Update README with the LLM wiki workflow.
