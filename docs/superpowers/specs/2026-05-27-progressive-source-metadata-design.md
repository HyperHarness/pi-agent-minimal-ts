# Progressive Source Metadata Disclosure

## Context

Paper sources currently store overlapping download details in both
`knowledge-base/sources/<sourceKey>/acquisition.json` and
`knowledge-base/sources/<sourceKey>/metadata.json`. This makes it unclear which
file owns PDF URLs, local download paths, download status, reading status, and
canonical publisher IDs.

The durable boundary should be:

- `acquisition.json` owns paper acquisition and reading runtime state.
- `metadata.json` owns source discovery, citation metadata, wiki linkage, and
  LLM-readable artifact indexing.
- `summary.md` remains human-readable output and is not metadata authority.

## Design

Use progressive disclosure for paper source details.

`metadata.json` should expose only the information needed for source lookup and
LLM reading:

- `sourceKind`, `sourceKey`, `title`, `status`, `createdAt`, `updatedAt`
- `summaryPath`
- `citation`
- `provenance.url`
- `provenance.doi` or `provenance.arxivId` when known
- `provenance.acquisitionPath`
- `artifacts[]` entries for LLM-readable parse outputs under
  `knowledge-base/sources/<sourceKey>/parses/...`
- `tags`, `relatedSourceKeys`, and `synthesisPageKeys`

`metadata.json` should not duplicate acquisition runtime fields:

- `provenance.recordPath`
- `provenance.source`
- `provenance.canonicalId`
- `provenance.downloadStatus`
- `provenance.readingStatus`
- `provenance.pdfUrl`
- `provenance.downloadPath`
- raw PDF entries in `artifacts[]`

When callers need download provenance, browser-session details, raw PDF paths,
PDF URLs, supplemental download state, failures, or reading queue state, they
should follow `provenance.acquisitionPath` and read `acquisition.json`.

## Artifact Semantics

`metadata.artifacts[]` represents source artifacts that downstream wiki and LLM
flows can consume directly. For paper sources, that means parse artifacts such as:

- `kind: "parse"`
- `path: knowledge-base/sources/<sourceKey>/parses/webpage`
- `markdownPath: knowledge-base/sources/<sourceKey>/parses/webpage/document.md`
- `jsonPath: knowledge-base/sources/<sourceKey>/parses/webpage/parse.json`
- `qualityPath: knowledge-base/sources/<sourceKey>/parses/webpage/quality.json`

Raw PDFs are not source metadata artifacts. They are acquisition/download
artifacts and remain discoverable through `acquisition.json`.

If a paper has a downloaded PDF but no parse output yet, `metadata.artifacts[]`
should remain empty for that paper, and `metadata.status` should reflect that the
source is not yet fully LLM-readable.

## Migration Rules

Existing metadata readers should treat omitted acquisition-runtime fields as
normal. Health checks should validate `provenance.acquisitionPath`,
`summaryPath`, and parse artifact paths when present, but should not require raw
PDF paths in `metadata.json`.

Metadata writers should derive minimal source lookup fields from
`acquisition.json`, but should not copy the full acquisition record into
`metadata.provenance`.

The implementation should remove duplicate metadata fields at the writer
boundary so newly written records use the progressive-disclosure shape. Existing
records can be cleaned by re-running metadata refresh or by a targeted migration.
