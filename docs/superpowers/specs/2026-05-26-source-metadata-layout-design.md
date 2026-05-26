# Source Metadata Layout Design

## Context

The current knowledge-base source layout is hard to inspect and maintain:

- `knowledge-base/sources/<sourceKey>/acquisition.json` is already the paper acquisition record.
- `knowledge-base/sources/<sourceKey>/source.json` is a second paper-specific metadata record.
- `knowledge-base/manifests/<sourceKey>.json` is the wiki source manifest.
- `summary.md`, parse artifacts, and raw artifacts are stored near the source, but the source manifest is outside the source directory.

For a new knowledge base, preserving this split creates more cost than value. A maintainer should be able to open one source directory and find the source identity, provenance, acquisition state, source summary, parse outputs, and links to pages without jumping to a parallel `manifests/` tree.

This design replaces the split manifest/source-metadata model with a self-contained source directory model.

## Goals

1. Make `knowledge-base/sources/<sourceKey>/` the complete maintenance unit for one evidence source.
2. Rename the human-facing source entry file to `metadata.json`.
3. Keep `acquisition.json` as the paper/download-specific runtime acquisition record.
4. Remove `knowledge-base/manifests/` from the primary layout.
5. Stop writing legacy wiki source manifests and legacy paper `source.json` files.
6. Make paper, material databases, software docs, standards, lab notes, code outputs, webpages, and manual sources share one metadata schema.
7. Optimize for simple lookup, deterministic health checks, and easy manual repair.

## Non-Goals

- No compatibility layer for the old `knowledge-base/manifests/<key>.json` path.
- No compatibility layer for old paper `source.json` metadata records.
- No automatic migration of every historical local knowledge base.
- No graph database or external index migration.
- No new standalone source registry service.
- No change to raw PDF storage under `knowledge-base/raw/pdfs/`.

## Recommended Layout

Each source is stored as one self-contained directory:

```text
knowledge-base/
  sources/
    <sourceKey>/
      metadata.json
      acquisition.json
      summary.md
      parses/
        <engine>/
          document.md
          parse.json
          quality.json
      chunks/
        <engine>.jsonl
      artifacts/
        <artifact files>
  pages/
    <pageKey>.md
  raw/
    pdfs/
      <paperKey>.pdf
  state/
    wiki-operations.jsonl
  index.md
  log.md
```

`metadata.json` is required for every source. `acquisition.json` is optional and only exists for sources that need download/acquisition runtime state, especially papers fetched through browser or publisher workflows.

The top-level `knowledge-base/manifests/` directory is no longer part of the main contract.

## Source Responsibilities

### `metadata.json`

`metadata.json` is the durable, source-kind-neutral identity and provenance record. It is the first file a human or tool reads when inspecting a source.

It owns:

- source identity: `sourceKey`, `sourceKind`, `title`;
- lifecycle status: `status`, `createdAt`, `updatedAt`;
- citation and provenance: DOI, arXiv ID, URL, publisher, venue, authors, year, retrieved version, license, software version;
- evidence artifacts: raw path, parse path, quality path, chunks path, tables, figures, scripts, logs, result snapshots;
- source summary link: `summaryPath`;
- wiki links: `relatedSourceKeys`, `synthesisPageKeys`;
- tags and source-specific review notes.

### `acquisition.json`

`acquisition.json` is an operational record, not the durable source manifest.

It owns:

- how a paper or external source was acquired;
- browser extension job state;
- download status and handling method;
- article URL and PDF URL used during acquisition;
- transient acquisition failures and retry information;
- reading queue state if that state is tightly coupled to the acquisition flow.

Citation-complete metadata must be copied into `metadata.json` after acquisition succeeds. Downstream wiki, retrieval, lint, and page-building code should not need to read `acquisition.json` for normal evidence use.

### `summary.md`

`summary.md` is the human-readable and retrieval-readable source summary. It may keep concise frontmatter for display and search, but `metadata.json` is the authoritative machine record.

### Parse And Chunk Artifacts

Parse artifacts stay inside the source directory:

- `parses/<engine>/document.md`
- `parses/<engine>/parse.json`
- `parses/<engine>/quality.json`
- `chunks/<engine>.jsonl`

`metadata.json.artifacts` references these paths using workspace-relative paths.

## Metadata Schema

Use one new schema for the new layout. Start at `schemaVersion: 1` because it is a new file contract, not a continuation of the old top-level manifest contract.

```ts
type KnowledgeSourceKind =
  | "paper"
  | "material-database"
  | "software-doc"
  | "vendor-note"
  | "standard"
  | "lab-note"
  | "code-output"
  | "webpage"
  | "manual";

type KnowledgeSourceStatus =
  | "ready"
  | "stale"
  | "blocked"
  | "low_quality"
  | "citation_incomplete"
  | "missing_artifact"
  | "version_unknown"
  | "needs_review";

interface KnowledgeSourceArtifact {
  kind: "raw" | "parse" | "chunk" | "table" | "figure" | "script" | "result" | "log" | "snapshot";
  path: string;
  engine?: string;
  markdownPath?: string;
  jsonPath?: string;
  qualityPath?: string;
  sha256?: string;
  note?: string;
}

interface KnowledgeSourceMetadata {
  schemaVersion: 1;
  sourceKind: KnowledgeSourceKind;
  sourceKey: string;
  title: string;
  status: KnowledgeSourceStatus;
  createdAt: string;
  updatedAt: string;
  summaryPath?: string;
  citation?: {
    authors?: string[];
    year?: number;
    venue?: string;
    publisher?: string;
    doi?: string;
    arxivId?: string;
    citationStatus?: "complete" | "incomplete";
    missingFields?: string[];
  };
  provenance: {
    url?: string;
    pdfUrl?: string;
    rawPath?: string;
    rawSha256?: string;
    acquisitionPath?: string;
    retrievedAt?: string;
    version?: string;
    softwareName?: string;
    softwareVersion?: string;
    vendor?: string;
    license?: string;
  };
  artifacts: KnowledgeSourceArtifact[];
  tags: string[];
  relatedSourceKeys: string[];
  synthesisPageKeys: string[];
  reviewNotes?: string[];
}
```

For papers, `citation` replaces the old paper-specific `source.json` citation metadata. `provenance.acquisitionPath` points to `knowledge-base/sources/<sourceKey>/acquisition.json` when present.

## Data Flow

### Paper Acquisition

1. Paper acquisition writes or updates `sources/<paperKey>/acquisition.json`.
2. The paper store resolves citation metadata from acquisition data, local parse data, DOI metadata, arXiv, Crossref, or Semantic Scholar.
3. The paper store writes `sources/<paperKey>/metadata.json`.
4. Parse and reading steps add artifacts under `sources/<paperKey>/parses/` and `sources/<paperKey>/chunks/`.
5. Summary generation writes `sources/<paperKey>/summary.md` and updates `metadata.json.summaryPath`, `artifacts`, tags, related sources, and status.

### Non-Paper Sources

1. Source registration creates `sources/<sourceKey>/metadata.json`.
2. Optional raw files, parsed documents, tables, scripts, logs, or snapshots are stored inside the source directory or under an approved raw/artifact path.
3. Summary generation writes `summary.md` and updates `metadata.json`.
4. Retrieval and page synthesis use the same source evidence contract as paper sources.

## Code Boundary Changes

### Workspace Contract

`wiki/workspace-contract.ts` should remove `manifests` as a primary lifecycle root. The source metadata path is derived from the source directory:

```text
sources/<sourceKey>/metadata.json
```

### Wiki Manifest Store

`wiki/manifest-store.ts` should become a source metadata store:

- `getKnowledgeSourceMetadataPath(workspaceDir, sourceKey)`
- `readKnowledgeSourceMetadata(...)`
- `writeKnowledgeSourceMetadata(...)`
- `validateKnowledgeSourceMetadataIdentity(...)`

It should no longer normalize old V1 paper manifests or read `knowledge-base/manifests/`.

### Paper Store

`paper-store.ts` should stop writing `source.json`. It should write `metadata.json` after acquisition and citation enrichment.

`writePaperSourceMetadataForSource(...)` should be replaced with metadata-path-oriented helpers, for example:

- `writePaperMetadataForRecord(...)`
- `writePaperMetadataForSourceDirectory(...)`

Errors should say `metadata.json`, not `source.json`.

### Local Paper Library

`local-paper-library.ts` should collect paper entries from:

- `sources/<paperKey>/acquisition.json` for acquisition/download state;
- `sources/<paperKey>/metadata.json` for citation, source identity, provenance, and source status;
- parse and summary artifacts referenced from `metadata.json`.

### Wiki Content And Retrieval

`content.ts`, `bootstrap.ts`, `retrieval-contract.ts`, `retrieval-search.ts`, and `evidence-pack.ts` should use `metadata.json` as the source manifest. A source summary without `metadata.json` is unhealthy, not a legacy-compatible fallback.

### Health And Lint

`wiki_health` should report:

- missing `metadata.json` for a source directory;
- invalid `metadata.json`;
- `metadata.json.sourceKey` mismatch with directory name;
- missing required artifacts referenced by `metadata.json`;
- paper source with acquisition data but missing citation fields;
- `acquisition.json` present but not referenced by `metadata.json.provenance.acquisitionPath`;
- stale or incomplete source summaries.

`wiki_lint` should continue to focus on page-level evidence, source refs, and graph/index quality.

## Maintenance Rules

1. To inspect a source, open `knowledge-base/sources/<sourceKey>/metadata.json` first.
2. To inspect acquisition/debug state for a paper download, open `acquisition.json`.
3. To inspect evidence text, open `summary.md` and referenced parse/chunk artifacts.
4. Tools must not create top-level `knowledge-base/manifests/`.
5. Tools must not create `sources/<sourceKey>/source.json`.
6. Every path stored in `metadata.json` must be workspace-relative and must stay inside an approved knowledge-base root.
7. Filename identity must be checked: the source directory name must match `metadata.json.sourceKey`.

## Testing Strategy

Update tests around the new primary contract:

- paper store writes `metadata.json` next to `acquisition.json`;
- citation enrichment updates `metadata.json.citation`;
- wiki source writing updates `metadata.json` instead of `manifests/<key>.json`;
- retrieval reads source evidence through `metadata.json`;
- health reports missing or malformed `metadata.json`;
- no write path creates `source.json` or top-level `manifests/`;
- non-paper sources use the same metadata path and schema;
- source-key identity mismatches are rejected or reported as diagnostics.

Legacy compatibility tests for `knowledge-base/manifests/<key>.json` and `sources/<key>/source.json` should be removed or rewritten as negative tests if needed.

## Rollout Plan

Because this is a new knowledge-base cleanup, implementation can be direct:

1. Change path helpers and workspace contract.
2. Replace manifest-store types and functions with metadata-store names.
3. Update paper store writes from `source.json` to `metadata.json`.
4. Update local library, wiki health, content, retrieval, and bootstrap callers.
5. Rewrite tests to assert the new layout.
6. Delete legacy compatibility branches for old source manifests and old paper source metadata.
7. Run targeted tests, then the full test suite.

Existing local `knowledge-base/` artifacts can be regenerated or manually cleaned after code changes. They are not part of the source-controlled migration contract.
