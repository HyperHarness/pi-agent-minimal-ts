# Paper LLM Wiki Implementation Plan

Date: 2026-04-27

## Checklist

- [x] Migrate existing paper PDFs and records into `knowledge-base/` and remove the old `downloads/` storage.
- [x] Write new raw PDFs under `knowledge-base/raw/pdfs/`.
- [x] Store parser artifacts under `knowledge-base/sources/<paper-key>/`.
- [x] Add wiki scaffold helpers for `index.md`, `log.md`, `sources/`, `wiki/`, and `assets/`.
- [x] Add `write_paper_wiki_source` to persist LLM-authored source summaries with provenance.
- [x] Add `search_paper_wiki` to retrieve from source summaries.
- [x] Cover the new paths and wiki source flow with tests.
- [x] Update README with the LLM wiki workflow.
- [x] Move the default knowledge base out of `downloads/` and support `PI_KNOWLEDGE_BASE_DIR` for separating the code repository from the knowledge base.
