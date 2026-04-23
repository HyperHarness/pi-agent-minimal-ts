# Unified Paper Management Design

Date: 2026-04-23

## Goal

Unify the agent's paper search and download behavior under one consistent paper management model.

The current implementation splits paper handling into two incompatible paths:

- arXiv search plus PDF URL generation
- publisher-specific browser-managed download

That split leaks directly into the user-facing tool surface. `download_arxiv_pdf` does not actually download anything, while `download_paper_pdf` writes files, performs validation, and may open a manual fallback browser session. The result is a misleading API, inconsistent return shapes, and no single place to track downloaded papers.

This design replaces the split model with a unified paper layer that:

- exposes one search tool and one download tool
- downloads both arXiv and supported publisher papers into the workspace
- records normalized metadata for each downloaded paper
- keeps browser-session logic only where it is actually required

## Problem

### Current user-facing inconsistency

The current built-in tools mix two different concepts of "download":

- `search_arxiv` returns arXiv-specific paper metadata
- `download_arxiv_pdf` only builds a canonical PDF URL
- `download_paper_pdf` performs a real download into `downloads/papers/`

This makes the tool layer harder for the model to reason about and harder for users to predict. Two tools with nearly identical names do materially different things.

### Current implementation inconsistency

The current codebase has no unified paper management layer:

- `src/agent/arxiv.ts` handles arXiv search and URL generation only
- `src/agent/paper-download.ts` handles real publisher downloads only
- `src/agent/tools.ts` contains tool-level orchestration and some download validation policy
- browser session reuse is managed only for supported publishers through the paper browser manager

There is also no shared storage model for downloaded papers beyond the PDF file itself. Publisher downloads may produce meaningful filenames, but there is no record file that captures canonical source identity, download method, timestamp, or failure/fallback state.

### Why this matters

The lack of a unified model causes four concrete problems:

- the agent can misread capabilities and choose the wrong tool flow
- callers cannot rely on consistent result contracts
- new paper sources would require more parallel special cases
- the workspace contains PDFs without a normalized paper index

## Decision

Introduce a unified paper management layer with:

- a single paper search tool: `search_papers`
- a single paper download tool: `download_paper`
- a persistent paper record store under `downloads/papers/index/`
- source-specific download implementations behind one manager contract

`open_paper_page_for_login` remains as a specialized publisher-only tool because manual browser continuation is a real capability for paywalled or challenge-protected publishers, but it is not part of the arXiv flow and should not pretend to be.

This is a breaking API change by design. The old tools should be removed rather than kept as aliases.

## Recommended External Interface

### `search_papers`

Input:

- `provider?: "arxiv"`
- `query: string`
- `maxResults?: number`

Behavior:

- searches the requested provider
- initially only `arxiv` is implemented
- returns a unified paper result shape instead of an arXiv-specific one

Unified search result shape:

- `source: "arxiv"`
- `canonicalId: string`
- `title: string`
- `authors: string[]`
- `summary: string`
- `articleUrl: string`
- `pdfUrl: string`

`provider` should default to `"arxiv"` for the initial implementation so the new tool is immediately usable without extra friction.

### `download_paper`

Input:

- `id?: string`
- `url?: string`

Rules:

- exactly one of `id` or `url` must be provided
- `id` is currently interpreted as an arXiv identifier
- `url` may point to:
  - an arXiv article or PDF URL
  - a supported publisher article URL

Behavior:

- normalizes the input into a canonical paper identity
- routes to the correct source-specific download path
- saves the PDF into `downloads/papers/`
- writes a normalized paper record into `downloads/papers/index/`
- returns a unified result contract

Unified download success shape:

- `status: "downloaded"`
- `source: "arxiv" | "science" | "nature" | "aps"`
- `canonicalId: string`
- `articleUrl: string`
- `finalPdfUrl: string`
- `path: string`
- `recordPath: string`

Unified manual continuation shape:

- `status: "manual_fallback_opened"`
- `source: "science" | "nature" | "aps"`
- `canonicalId: string`
- `articleUrl: string`
- `fallbackUrl: string`
- `recordPath: string`
- `failure: { code: string; message: string }`
- `profileDir?: string`
- `executablePath?: string`

Only publisher flows may return `manual_fallback_opened`. arXiv download failure remains a hard error because there is no login workflow to continue manually.

### `open_paper_page_for_login`

Input:

- `url: string`

Behavior:

- validates that the URL belongs to a supported publisher
- opens the article in the managed browser session for manual login or verification
- remains unchanged in purpose

This tool is explicitly out of scope for arXiv. arXiv should not enter a manual-login or browser-manager path.

## Internal Architecture

The implementation should be reorganized into three layers.

### 1. Paper source layer

Responsibility:

- classify input as arXiv or supported publisher
- normalize source-specific identifiers
- convert inputs into canonical article and PDF metadata
- expose search capabilities for each provider

Recommended shape:

- `paper-sources/arxiv.ts`
- `paper-sources/publishers.ts`
- shared source utilities for parsing and normalization

The source layer should answer questions such as:

- is this URL arXiv or publisher?
- what is the canonical identifier?
- what article URL should be recorded?
- what PDF URL should be used when direct download is possible?

### 2. Paper download manager

Responsibility:

- provide the single internal entry point for paper download
- route to the correct download strategy
- own the unified result contract
- own fallback policy
- call the paper store to persist records

Recommended entry point:

- `downloadPaper({ workspaceDir, id?, url? })`

This layer should replace the current split between:

- arXiv URL building in `arxiv.ts`
- publisher-only orchestration in `paper-download.ts`
- tool-level post-processing in `tools.ts`

Tool code should stop assembling download policy itself. The manager should return already-normalized results.

### 3. Paper store

Responsibility:

- determine final file paths
- determine record file paths
- sanitize filenames
- write normalized paper record JSON

The paper store should be source-agnostic. It should not know how to authenticate, browse, or search. It should only know how to persist paper artifacts and metadata consistently.

## Download Strategies

### arXiv strategy

arXiv should use a direct download path:

1. normalize the arXiv identifier from `id` or `url`
2. derive canonical article and PDF URLs
3. fetch the PDF over HTTP
4. verify the downloaded bytes begin with `%PDF-`
5. write the PDF into `downloads/papers/`
6. write a normalized record into `downloads/papers/index/`

The arXiv path must not use the paper browser manager.

### Publisher strategy

Supported publishers continue to use the existing managed browser session:

1. validate the article URL
2. reuse or start the paper browser manager session
3. open the article page in the authenticated browser context
4. resolve the final PDF URL through the publisher adapter path
5. download and validate the PDF
6. persist the PDF and record
7. if fallback-eligible failure occurs, open the same article for manual continuation and persist a fallback record

The browser manager remains the correct abstraction for:

- manual login reuse
- Cloudflare or institution-login recovery
- session continuity between manual and automatic steps

## Storage Model

### PDF files

PDF files remain under:

- `downloads/papers/`

Naming rules:

- arXiv: `arxiv-<canonicalId>.pdf`
- Science: `science-<doi>.pdf`
- Nature: `nature-<articleId>.pdf`
- APS: `aps-<doi>.pdf`

All names should pass through one shared sanitization path so filename behavior is consistent across sources.

### Record files

Paper records live under:

- `downloads/papers/index/`

Recommended naming:

- `arxiv-2401.01234.json`
- `science-10.1126-science.adz8659.json`
- `nature-s41586-019-1666-5.json`
- `aps-10.1103-PhysRevLett.134.090601.json`

One record file per canonical paper identity is sufficient for the initial implementation.

### Record schema

Each record should contain:

- `source`
- `canonicalId`
- `articleUrl`
- `pdfUrl`
- `downloadPath?: string`
- `recordedAt`
- `downloadMethod: "direct_http" | "browser_session"`
- `status: "downloaded" | "manual_fallback_opened"`
- `failure?: { code: string; message: string }`

This schema intentionally records both successful downloads and publisher fallback openings in the same index model.

## Validation And Error Model

The unified paper layer should own one normalized error model.

Recommended codes:

- `unsupported_source`
- `invalid_paper_input`
- `paper_not_found`
- `browser_session_unavailable`
- `manual_login_required`
- `authorization_failed`
- `pdf_not_found`
- `download_failed`

### arXiv-specific expectations

Likely error usage:

- malformed `id` or unsupported `url` shape -> `invalid_paper_input`
- non-OK PDF fetch or missing paper -> `paper_not_found` or `download_failed`
- non-PDF body -> `download_failed`

### publisher-specific expectations

Likely error usage:

- unsupported host -> `unsupported_source`
- no PDF link on article page -> `pdf_not_found`
- browser startup or profile failure -> `browser_session_unavailable`
- login wall or authorization barrier -> `manual_login_required` or `authorization_failed`
- byte validation failure or timed-out browser download -> `download_failed`

### Fallback rules

Fallback to `manual_fallback_opened` should be attempted only for supported publisher flows and only for these failure categories:

- `browser_session_unavailable`
- `manual_login_required`
- `authorization_failed`
- `pdf_not_found`
- `download_failed`

The same fallback rule also applies when a publisher download reports success but the resulting file does not validate as a PDF.

arXiv failures do not trigger browser fallback.

## Migration Strategy

This design intentionally performs a breaking transition instead of layering aliases on top of the old tool names.

### Remove

- `search_arxiv`
- `download_arxiv_pdf`
- `download_paper_pdf`

### Add

- `search_papers`
- `download_paper`

### Keep

- `open_paper_page_for_login`

### Non-goals for migration

- no compatibility shims for old tool names
- no one-time migration of existing downloaded PDFs into record JSON files
- no backfill task for older workspaces

Existing PDF files in `downloads/papers/` remain valid artifacts, but only new downloads after this change are guaranteed to have a normalized record entry.

## Expected File Touch Points

- `src/agent/tools.ts`
  - replace old arXiv and paper download tools with unified tool definitions
- `src/agent/arxiv.ts`
  - keep arXiv parsing utilities, but move toward source-layer use rather than tool-specific use
- `src/agent/paper-download.ts`
  - either replace or refactor into a publisher-specific download strategy used by the unified manager
- `src/agent/paper-browser-manager-client.ts`
  - no major behavior change expected, but publisher download integration remains here indirectly
- new source and storage files
  - for unified paper classification, download routing, and record persistence
- `test/agent/tools.test.ts`
  - replace old tool tests with new unified tool tests
- new tests
  - for paper manager and paper store behavior
- `README.md`
  - replace old tool docs and examples with the unified surface

## Testing Strategy

Implementation must follow TDD.

### Search tests

Add failing tests first for:

- `search_papers` returning unified arXiv-backed paper results
- default provider behavior for arXiv
- rejection of mangled `????` queries

### Download tests

Add failing tests first for:

- `download_paper` with arXiv `id` downloads the PDF into `downloads/papers/`
- `download_paper` with arXiv article URL normalizes and downloads correctly
- `download_paper` with supported publisher URL still uses the browser-manager path
- successful downloads write a normalized record file
- invalid PDF bytes are rejected
- publisher failures still return `manual_fallback_opened` when fallback is eligible

### Store tests

Add failing tests first for:

- PDF filename generation for each source
- record filename generation for each source
- record content completeness and correctness
- record writes for both downloaded and fallback states

### Regression focus

Regression coverage should specifically protect:

- browser manager reuse
- stale metadata cleanup
- existing publisher filename quality
- workspace output path stability under `downloads/papers/`

## Tradeoffs

### Benefits

- one coherent paper API for the model and the user
- real download semantics for both arXiv and supported publishers
- normalized local metadata for downloaded papers
- clearer boundary between source logic, download logic, and persistence
- easier extension path for future paper providers

### Costs

- breaking tool-name and result-contract changes
- more implementation files and abstractions
- new test surface for paper storage and routing

These costs are acceptable because the current mixed semantics already create confusion and hide capability gaps.

## Success Criteria

The change is successful when all of the following are true:

- there is one search tool and one download tool for papers
- arXiv download actually writes a local PDF instead of only returning a URL
- publisher download still supports managed-browser reuse and manual continuation
- successful downloads for all supported sources write normalized record files
- result contracts are consistent enough that the model no longer needs source-specific download reasoning at the tool layer

## Open Decisions Resolved

- breaking change: accepted
- unified external tool surface: chosen
- arXiv local download: required
- paper index record store: required
- browser-manager reuse: retained only for publisher flows
- record backfill for historical files: not included in this change
