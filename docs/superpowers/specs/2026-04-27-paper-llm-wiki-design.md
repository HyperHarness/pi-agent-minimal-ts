# Paper LLM Wiki Design

Date: 2026-04-27

## Goal

Turn the paper downloader and reader into a compact LLM-maintained scientific literature wiki, following the pattern in Karpathy's `llm-wiki.md`: raw sources are immutable, derived text is intermediate, and LLM-authored markdown becomes the retrieval source.

## Directory Layout

Use one knowledge base under `knowledge-base/` by default. The knowledge base can be moved outside the code checkout with `PI_KNOWLEDGE_BASE_DIR=/absolute/path/to/knowledge-base`, which keeps the open-source code repository separate from the large, private wiki knowledge base.

```text
knowledge-base/
  raw/
    pdfs/
      <paper-key>.pdf
  wiki/
    index.md
    log.md
    sources/
      <paper-key>.md
      <paper-key>/
        source.json
        acquisition.json
        parses/
          <engine>/
            parse.json
            document.md
            quality.json
        chunks/
          <engine>.jsonl
    pages/
    manifests/
    assets/
    state/
```

## Layer Semantics

- `raw/pdfs/`: original PDFs. The agent may create them during download but should not mutate them during reading or summarization.
- `wiki/sources/<paper-key>/`: parser output from OpenDataLoader or fallback engines. This is machine-derived evidence for one paper source.
- `wiki/sources/<paper-key>.md`: LLM-written, provenance-tracked paper summaries. These are the default retrieval corpus for knowledge questions.
- `wiki/pages/`: future synthesis pages across multiple papers, such as topic pages, comparisons, and evolving claims.
- `wiki/manifests/`: future machine-readable provenance for final source summaries.
- `index.md`: knowledge-entry navigation for `wiki/pages/`; source summaries remain a citeable evidence layer and should not be expanded into a downloaded-paper list here.
- `log.md`: chronological append-only audit trail for knowledge-page operations under `wiki/pages/`; downloads are tracked in per-source `knowledge-base/wiki/sources/<paperKey>/acquisition.json` files, and source-summary evidence changes should not be logged here.
- Workflow and schema conventions live in `src/`, tests, and this design document rather than a runtime `wiki/schema.md` file.

## Tool Flow

1. Download or register a PDF with `download_paper` or `register_manual_paper_download`.
2. Parse it with `parse_paper`; this writes evidence markdown and JSON under that paper's source directory.
3. Inspect and read the parsed paper using `inspect_paper`, `read_paper_section`, and `search_paper_text`.
4. Write the grounded LLM summary with `write_paper_wiki_source`; this creates or updates `wiki/sources/<paper-key>.md` as citeable evidence without appending to the page-operation log.
5. Use `search_paper_wiki` for retrieval over the LLM-authored source layer.

The agent should not treat `document.md` as the long-term knowledge source. It is the evidence layer used to write and verify `sources/<paper-key>.md`.

## First Implementation Scope

- Move future raw PDF downloads to `knowledge-base/raw/pdfs/`.
- Store parser artifacts under `knowledge-base/wiki/sources/<paper-key>/`.
- Add `write_paper_wiki_source` for LLM-authored source summaries.
- Add `search_paper_wiki` for lexical retrieval over source summaries.
- Keep the system intentionally simple: no vector database until the source layer and conventions prove useful.

## Deferred

- Embedding or hybrid search over `sources/` and `wiki/`.
- Automated cross-paper synthesis pages in `wiki/`.
- Claim-level citation graph.
- Human approval workflow for high-impact edits.
