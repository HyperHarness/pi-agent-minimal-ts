# Paper LLM Wiki Design

Date: 2026-04-27

## Goal

Turn the paper downloader and reader into a compact LLM-maintained scientific literature wiki, following the pattern in Karpathy's `llm-wiki.md`: raw sources are immutable, derived text is intermediate, and LLM-authored markdown becomes the retrieval source.

## Directory Layout

Use one paper workspace under `downloads/papers/`:

```text
downloads/papers/
  raw/
    <paper-key>.pdf
  index/
    <paper-key>.json
  llm-wiki/
    schema.md
    index.md
    log.md
    intermediate/
      <paper-key>/
        source.json
        parses/
          <engine>/
            parse.json
            document.md
            quality.json
        chunks/
          <engine>.jsonl
    sources/
      <paper-key>.md
    wiki/
    assets/
```

Compatibility rule: older PDFs directly under `downloads/papers/*.pdf` remain readable, but new downloads should write raw PDFs into `downloads/papers/raw/`.

## Layer Semantics

- `raw/`: original PDFs. The agent may create them during download but should not mutate them during reading or summarization.
- `llm-wiki/intermediate/`: parser output from OpenDataLoader or fallback engines. This is machine-derived evidence, not the final knowledge source.
- `llm-wiki/sources/`: LLM-written, provenance-tracked paper summaries. These are the default retrieval corpus for knowledge questions.
- `llm-wiki/wiki/`: future synthesis pages across multiple papers, such as topic pages, comparisons, and evolving claims.
- `index.md`: content-oriented catalog for navigation.
- `log.md`: chronological append-only audit trail.
- `schema.md`: local conventions for future agent sessions.

## Tool Flow

1. Download or register a PDF with `download_paper` or `register_manual_paper_download`.
2. Parse it with `parse_paper`; this writes intermediate markdown and JSON.
3. Inspect and read the parsed paper using `inspect_paper`, `read_paper_section`, and `search_paper_text`.
4. Write the grounded LLM summary with `write_paper_wiki_source`; this creates or updates `llm-wiki/sources/<paper-key>.md`, `index.md`, and `log.md`.
5. Use `search_paper_wiki` for retrieval over the LLM-authored source layer.

The agent should not treat `document.md` as the long-term knowledge source. It is the evidence layer used to write and verify `sources/<paper-key>.md`.

## First Implementation Scope

- Move future raw PDF downloads to `downloads/papers/raw/`.
- Move parser artifacts from `downloads/papers/reading/` to `downloads/papers/llm-wiki/intermediate/`.
- Add `write_paper_wiki_source` for LLM-authored source summaries.
- Add `search_paper_wiki` for lexical retrieval over source summaries.
- Keep the system intentionally simple: no vector database until the source layer and conventions prove useful.

## Deferred

- Embedding or hybrid search over `sources/` and `wiki/`.
- Automated cross-paper synthesis pages in `wiki/`.
- Claim-level citation graph.
- Human approval workflow for high-impact edits.
