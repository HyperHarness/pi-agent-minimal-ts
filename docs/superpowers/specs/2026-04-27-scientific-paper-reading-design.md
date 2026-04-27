# Scientific Paper Reading Design

Date: 2026-04-27

Update: the later paper LLM wiki design supersedes the original `downloads/papers/reading/` artifact directory with `downloads/papers/llm-wiki/intermediate/`, while keeping the same parse/read/search tool boundary.

## Goal

Add scientific paper reading capabilities to the existing paper search, download, and management agent without splitting the product into a second standalone agent.

The current agent already has the right boundary for paper acquisition:

- `search_papers` discovers logical paper results across arXiv, APS, supported publishers, and external URLs.
- `download_paper` writes verified PDFs into `downloads/papers/`.
- `downloads/papers/index/` records the downloaded-paper identity and local PDF path.
- browser-extension and manual-registration flows still converge on the same local PDF store.

The reading feature should build on that store. Download records remain the source of truth for paper acquisition, while reading artifacts become derived data.

## Decision

Implement reading as a new internal paper reader layer inside the same agent:

```text
src/agent/paper-reader/
  types.ts
  paper-reader.ts
  paper-reader-store.ts
  engines/
    opendataloader-local.ts
    opendataloader-hybrid.ts
    plain-text-baseline.ts
  quality.ts
  chunks.ts
```

Expose a small tool surface:

- `parse_paper`: parse a downloaded PDF into structured reading artifacts.
- `inspect_paper`: show parsed metadata, sections, quality report, and available artifacts.
- `read_paper_section`: return bounded text for one section or page range with source locations.
- `search_paper_text`: lexical search inside the parsed paper, returning snippets with page and section metadata.
- later `ask_paper`: answer questions with citations after the retrieval path is stable.

Do not make a separate reading agent yet. The reading layer needs direct access to the download index, PDF paths, titles, source URLs, DOI/arXiv IDs, and future paper library metadata. Splitting now would add protocol and state-sync cost before the reading strategy is known.

## Parser Strategy

Use OpenDataLoader PDF as the main structured parser, based on the local evaluation in `/home/ququan2/opendataloader-pdf-for-scientific-papers.md`.

Recommended engine order:

1. `opendataloader-local`
   - default parser for modern scientific PDFs
   - produces Markdown and JSON
   - preserves page numbers, element types, heading structure, and bounding boxes
   - fast enough for batch preprocessing
2. `opendataloader-hybrid`
   - fallback for weak local parse quality
   - use for complex tables, OCR, formulas, and image descriptions
   - requires a separate Python/FastAPI hybrid server
3. `plain-text-baseline`
   - optional cheap fallback for debugging and tests
   - useful when the full parser is not installed in CI

Keep MinerU, Marker, cloud OCR, and strong vision models as later adapter candidates rather than first-version dependencies.

## Artifact Store

Store derived reading artifacts outside `downloads/papers/index/` so download records stay stable.

Recommended layout:

```text
downloads/papers/llm-wiki/intermediate/
  <paper-key>/
    source.json
    parses/
      opendataloader-local/
        parse.json
        document.md
        quality.json
      opendataloader-hybrid/
        parse.json
        document.md
        quality.json
    chunks/
      opendataloader-local.jsonl
```

`paper-key` should reuse the existing indexed identity when possible:

- `arxiv-2406.06015`
- `aps-10.1103-PhysRevLett.127.080505`
- `nature-s41586-024-08449-y`
- `external-<hostname>-<hash>`

`source.json` should capture:

- paper key
- PDF path
- source record path
- PDF SHA-256
- source, canonical ID, article URL, title when known
- artifact creation time

The PDF hash matters because a PDF can be replaced while the path stays the same. Cached parses should be invalidated when the hash changes.

## Parse Result Model

Normalize each parser output into one internal JSON shape, even if the raw parser returns different fields:

```ts
export interface ParsedPaperDocument {
  paperKey: string;
  engine: PaperParseEngine;
  pdfSha256: string;
  createdAt: string;
  title?: string;
  pages: number;
  elements: PaperElement[];
  sections: PaperSection[];
}

export interface PaperElement {
  id: string;
  type: "heading" | "paragraph" | "table" | "list" | "caption" | "figure" | "formula" | "reference" | "unknown";
  text: string;
  page: number;
  bbox?: [number, number, number, number];
  sectionId?: string;
  headingLevel?: number;
}
```

The normalized model should preserve page and bounding-box metadata because the final reading feature needs citations that can point back to the PDF.

## Quality Gate

Every parse should produce `quality.json`.

Minimum useful checks:

- PDF byte validity and file size
- total extracted text length
- text length per page
- proportion of empty pages
- suspicious replacement characters or mojibake
- heading count and heading hierarchy sanity
- table count and table text density
- figure/caption count
- likely scan/OCR need
- likely two-column reading order issue

The first implementation does not need perfect quality scoring. It only needs to reliably decide:

- `good`: use local parse
- `needs_hybrid`: retry with OpenDataLoader hybrid
- `poor`: tell the user parsing quality is weak and suggest OCR/vision fallback

## Tool Behavior

### `parse_paper`

Input:

- `path?: string`
- `recordPath?: string`
- `engine?: "auto" | "opendataloader-local" | "opendataloader-hybrid" | "plain-text-baseline"`
- `force?: boolean`

Behavior:

1. Resolve the PDF from a workspace-relative path or an existing paper record.
2. Validate that the resolved path is inside `downloads/papers/` and starts with `%PDF-`.
3. Compute PDF SHA-256.
4. Reuse a cached parse if the same engine and hash already exist and `force` is not true.
5. Run the parser through a narrow child-process adapter.
6. Normalize output.
7. Write parse, markdown, chunk, and quality artifacts.
8. Return a compact status, artifact paths, section preview, and quality summary.

### `inspect_paper`

Input:

- `path?: string`
- `recordPath?: string`
- `paperKey?: string`

Behavior:

- list available parses and engines
- return title, source, hash, quality summary
- return top-level sections and page ranges
- do not return the full paper body

### `read_paper_section`

Input:

- `paperKey: string`
- `sectionId?: string`
- `pageFrom?: number`
- `pageTo?: number`
- `maxChars?: number`

Behavior:

- return bounded content only
- include page numbers and element IDs
- include a truncation flag when content exceeds `maxChars`

### `search_paper_text`

Input:

- `paperKey: string`
- `query: string`
- `maxResults?: number`

Behavior:

- start with lexical search over normalized elements and chunks
- return snippets with `sectionId`, `page`, `bbox`, and `elementId`
- later this can be backed by embeddings without changing the agent-facing contract

### `ask_paper`

Defer this until parsing, section reading, and search are stable.

The first `ask_paper` version should use retrieved elements and require citations. It should not feed the entire PDF blindly into the model.

## OpenDataLoader Integration

Keep the TypeScript agent as the orchestrator and call OpenDataLoader through a CLI adapter first. This avoids embedding Python runtime assumptions into the core agent.

Suggested local command shape:

```sh
opendataloader-pdf paper.pdf --output-dir output --format markdown,json
```

Hybrid command shape:

```sh
opendataloader-pdf --hybrid docling-fast --hybrid-mode full paper.pdf --output-dir output --format markdown,json
```

Environment variables:

- `PI_PAPER_READER_OPENDATALOADER_BIN`
- `PI_PAPER_READER_HYBRID_URL` or `PI_PAPER_READER_HYBRID_PORT`
- `PI_PAPER_READER_TIMEOUT_MS`

The adapter should fail with typed errors:

- `parser_not_installed`
- `java_missing`
- `hybrid_server_unavailable`
- `parse_failed`
- `parse_quality_poor`

Do not auto-install Python packages or Java from the agent tool. Report exact install and verification commands to the user.

## Evaluation Plan

Because multiple reading strategies are possible, add a lightweight evaluation harness before building a complex RAG system.

Use 8-12 local PDFs from `downloads/papers/`, covering:

- arXiv modern two-column papers
- APS papers
- Nature/Science papers
- formula-heavy physics papers
- table-heavy experimental papers
- at least one difficult or scanned PDF if available

Evaluate each parser on:

- reading order
- section detection
- abstract/introduction/conclusion extraction
- table preservation
- formula preservation
- caption and figure linking
- citation traceability through page/bbox
- speed
- artifact size
- failure mode clarity

Add fixture-level expected checks rather than subjective summaries first, for example:

- expected title or phrase appears
- abstract section found
- references section found
- page count is plausible
- text length per page is plausible
- no severe mojibake

## Implementation Phases

### Phase 1: local structured parse MVP

- add `paper-reader` types and artifact store
- add `plain-text-baseline` for deterministic tests
- add `opendataloader-local` CLI adapter
- add `parse_paper` and `inspect_paper`
- test cache invalidation by PDF hash

### Phase 2: section and search tools

- normalize headings and page ranges into sections
- chunk by section and element type
- add `read_paper_section`
- add `search_paper_text`
- keep result sizes bounded for the agent loop

### Phase 3: quality-driven fallback

- implement quality scoring
- add `engine: "auto"` behavior
- if local parse is weak, retry hybrid when configured
- report actionable typed errors when hybrid is unavailable

### Phase 4: scientific reading workflows

- add prompt-level workflows for:
  - paper quick summary
  - method/results/contribution extraction
  - limitations and future work
  - compare two parsed papers
- add `ask_paper` only after retrieval snippets are reliable

### Phase 5: advanced figure/table understanding

- extract figure regions from bbox metadata
- hand selected figures to a vision model when needed
- add optional table-specific extraction and comparison
- consider MinerU/Marker adapters only after OpenDataLoader results are measured on the user's papers

## Testing

Unit tests:

- path resolution rejects files outside workspace and outside `downloads/papers/`
- PDF validation rejects non-PDF files
- paper key resolution matches existing index filenames
- parse cache is reused for the same hash
- parse cache is invalidated when the PDF hash changes
- normalized document handles missing headings and empty pages

Tool tests:

- `parse_paper` returns typed parser errors
- `inspect_paper` never returns full document text
- `read_paper_section` respects `maxChars`
- `search_paper_text` returns page/section/element metadata

Integration tests:

- use `plain-text-baseline` by default in CI
- gate OpenDataLoader tests behind an environment variable, for example `PI_RUN_OPENDATALOADER_TESTS=1`

## User-Facing Workflow

Target first workflow:

```text
Search papers about X with search_papers, download the most relevant result,
parse it with parse_paper, inspect the sections, then summarize the method and main findings with page citations.
```

Target later workflow:

```text
Read this downloaded paper and answer: what is the experimental setup, what are the main results, and what are the limitations?
```

The agent should cite pages and section names whenever possible, and should explicitly say when the parser quality is weak.

## Open Questions

- Whether to store embeddings locally, and which vector store to use.
- Whether the reading layer should eventually support a persistent paper library beyond `downloads/papers/index/`.
- Whether cloud OCR or vision-model calls should be allowed by default or only after explicit user approval.
- Whether formula-heavy physics papers require a dedicated Marker/MinerU comparison sooner than Phase 5.
