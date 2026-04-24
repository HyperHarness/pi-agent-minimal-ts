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
- discovers papers through both arXiv and general web search
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
- a two-stage search pipeline that queries arXiv first and then reuses the existing `web_search` provider
- source-specific search and download implementations behind one manager contract

`open_paper_page_for_login` remains as a specialized publisher-only tool because manual browser continuation is a real capability for paywalled or challenge-protected publishers, but it is not part of the arXiv flow and should not pretend to be.

This is a breaking API change by design. The old tools should be removed rather than kept as aliases.

## Recommended External Interface

### `search_papers`

Input:

- `query: string`
- `maxResults?: number`

Behavior:

- runs a two-stage search pipeline
- stage 1 searches arXiv directly
- stage 2 reuses the configured `web_search` provider for broader paper discovery
- classifies web results into supported publisher results or generic external results
- deduplicates overlapping content across arXiv and web search
- returns grouped logical paper results instead of source-specific result lists

Unified search result shape:

- `title: string`
- `authors: string[]`
- `summary: string`
- `primarySource: "arxiv" | "science" | "nature" | "aps" | "external"`
- `primaryAction: "authorized_download" | "direct_download" | "open_url_only"`
- `sources: Array<{ source: "arxiv" | "science" | "nature" | "aps" | "external"; canonicalId?: string; articleUrl: string; pdfUrl?: string; action: "authorized_download" | "direct_download" | "open_url_only" }>`

The grouped result model is intentional. If the same paper is discovered on arXiv and on a supported publisher site, the user should see one logical paper result with multiple available sources instead of two near-duplicate rows.

### Search pipeline rules

1. Query arXiv with the raw paper query.
2. Query the existing `web_search` provider with the same query.
3. Classify each web result by hostname:
   - `science.org` -> `science`
   - `nature.com` -> `nature`
   - `journals.aps.org` or `aps.org` -> `aps`
   - any other host -> `external`
4. Merge duplicate results across arXiv and web search.
5. Choose one primary source per logical paper result.
6. Return at most `maxResults` logical results after merge and ranking.

### Deduplication rules

Deduplication should happen in two passes:

- exact canonical URL match
- exact normalized-title match after lowercasing, stripping punctuation, and collapsing whitespace

When two sources are deduplicated into one logical paper:

- keep all source representations in `sources`
- choose the primary source by action priority, not by discovery order

Primary source priority should be:

1. supported publisher (`science`, `nature`, `aps`)
2. `arxiv`
3. `external`

This keeps the supported publisher download path reachable while still preventing duplicate result clutter.

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
  - any other article-like web URL

Behavior:

- normalizes the input into a canonical paper identity
- routes to the correct source-specific download path
- either downloads the paper or opens the URL for user continuation, depending on source classification
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

Unified external-source handoff shape:

- `status: "external_opened"`
- `source: "external"`
- `articleUrl: string`
- `openedUrl: string`
- `recordPath: string`
- `executablePath?: string`

Only publisher flows may return `manual_fallback_opened`. arXiv download failure remains a hard error because there is no login workflow to continue manually. Generic external web results should not fail as unsupported input when they come through `download_paper`; instead, the tool should open the article URL for the user and return `external_opened`.

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

- classify input as arXiv, supported publisher, or external web source
- normalize source-specific identifiers
- convert inputs into canonical article and PDF metadata
- expose search capabilities for each provider
- expose deduplication keys for merge decisions
- classify broader web results as supported publisher or external

Recommended shape:

- `paper-sources/arxiv.ts`
- `paper-sources/publishers.ts`
- `paper-sources/external.ts`
- shared source utilities for parsing and normalization

The source layer should answer questions such as:

- is this URL arXiv, supported publisher, or external?
- what is the canonical identifier?
- what article URL should be recorded?
- what PDF URL should be used when direct download is possible?
- what deduplication key should this search result contribute?

### 2. Paper manager

Responsibility:

- provide the single internal entry point for paper search
- provide the single internal entry point for paper download
- merge and rank multi-source search results
- route to the correct download strategy
- own the unified result contract
- own fallback and external-open policy
- call the paper store to persist records

Recommended entry point:

- `searchPapers({ workspaceDir, query, maxResults? })`
- `downloadPaper({ workspaceDir, id?, url? })`

This layer should replace the current split between:

- arXiv URL building in `arxiv.ts`
- web-only discovery outside the paper system
- publisher-only orchestration in `paper-download.ts`
- tool-level post-processing in `tools.ts`

Tool code should stop assembling search and download policy itself. The manager should return already-normalized results.

### 3. Paper store

Responsibility:

- determine final file paths
- determine record file paths
- sanitize filenames
- write normalized paper record JSON

The paper store should be source-agnostic. It should not know how to authenticate, browse, or search. It should only know how to persist paper artifacts and metadata consistently.

## Search Strategy

### Stage 1: arXiv-first discovery

The search flow should always query arXiv first. This preserves the current strength of the implementation for research-paper discovery and ensures preprint coverage even when the general web search provider is weak.

### Stage 2: web search expansion

After the arXiv query, the manager should reuse the existing `web_search` provider to expand discovery beyond arXiv. This phase is responsible for finding:

- supported publisher article pages on `science.org`
- supported publisher article pages on `nature.com`
- supported publisher article pages on `journals.aps.org` or `aps.org`
- all other article-like pages as `external`

### Merge and ranking policy

The merged search result set should:

- prefer supported publisher representations when available
- keep arXiv as a secondary or fallback source when it matches the same logical paper
- keep external results only when they are not already covered by a supported publisher or arXiv source representation

This ranking policy ensures that supported publisher downloads remain reachable without losing arXiv visibility.

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

### External web strategy

External sources should not attempt browser-managed download and should not be rejected as unusable. Instead:

1. validate that the URL is an `http` or `https` URL
2. open the URL in the local browser for the user
3. write an `external_opened` paper record
4. return a structured non-error handoff result

This gives the user a consistent paper follow-up path even when the agent cannot download the source automatically.

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
- `external-example.com-1a2b3c4d.json`

One record file per canonical paper identity is sufficient for the initial implementation. For external sources that do not have a stable canonical paper identifier, the record name should use a sanitized hostname plus a stable URL-derived hash.

### Record schema

Each record should contain:

- `source`
- `canonicalId?: string`
- `articleUrl`
- `pdfUrl?: string`
- `downloadPath?: string`
- `openedUrl?: string`
- `recordedAt`
- `handlingMethod: "direct_http" | "browser_session" | "system_browser_open"`
- `status: "downloaded" | "manual_fallback_opened" | "external_opened"`
- `failure?: { code: string; message: string }`

This schema intentionally records successful downloads, publisher fallback openings, and generic external URL handoffs in the same index model.

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

### External-source handoff rules

If `download_paper` receives a non-arXiv URL that does not belong to a supported publisher, it should:

- open the URL in the local browser
- return `external_opened`
- avoid raising `unsupported_source` at the tool surface for that case

`unsupported_source` remains appropriate for internal classification and for explicit publisher-only entry points such as `open_paper_page_for_login`.

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
- `src/agent/web-search.ts`
  - continue to provide general search, now reused by the unified paper manager
- `src/agent/paper-download.ts`
  - either replace or refactor into a publisher-specific download strategy used by the unified manager
- `src/agent/paper-browser-manager-client.ts`
  - no major behavior change expected, but publisher download integration remains here indirectly
- `src/agent/browser-session.ts`
  - likely provide or reuse the local browser opener for external URL handoff
- new source and storage files
  - for unified paper classification, multi-stage search, dedupe, download routing, and record persistence
- `test/agent/tools.test.ts`
  - replace old tool tests with new unified tool tests
- new tests
  - for paper manager search, dedupe, external-open handling, and paper store behavior
- `README.md`
  - replace old tool docs and examples with the unified surface

## Testing Strategy

Implementation must follow TDD.

### Search tests

Add failing tests first for:

- `search_papers` running both arXiv search and `web_search`
- `search_papers` classifying `science`, `nature`, `aps`, and external results by hostname
- `search_papers` deduplicating overlapping arXiv and web results
- `search_papers` grouping same-content results under one logical paper result
- `search_papers` choosing the primary source by action priority
- rejection of mangled `????` queries

### Download tests

Add failing tests first for:

- `download_paper` with arXiv `id` downloads the PDF into `downloads/papers/`
- `download_paper` with arXiv article URL normalizes and downloads correctly
- `download_paper` with supported publisher URL still uses the browser-manager path
- `download_paper` with unsupported external URL opens the URL for the user and returns `external_opened`
- successful downloads write a normalized record file
- invalid PDF bytes are rejected
- publisher failures still return `manual_fallback_opened` when fallback is eligible

### Store tests

Add failing tests first for:

- PDF filename generation for each source
- record filename generation for each source
- record content completeness and correctness
- record writes for downloaded, fallback, and external-open states

### Regression focus

Regression coverage should specifically protect:

- browser manager reuse
- stale metadata cleanup
- existing publisher filename quality
- workspace output path stability under `downloads/papers/`

## Tradeoffs

### Benefits

- one coherent paper API for the model and the user
- one search path that can discover both arXiv papers and supported publisher articles
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
- `search_papers` can surface arXiv, supported publisher, and external results in one merged result set
- arXiv download actually writes a local PDF instead of only returning a URL
- publisher download still supports managed-browser reuse and manual continuation
- successful downloads for all supported sources write normalized record files
- external sources are handed off by opening the URL instead of failing as dead ends
- result contracts are consistent enough that the model no longer needs source-specific download reasoning at the tool layer

## Open Decisions Resolved

- breaking change: accepted
- unified external tool surface: chosen
- arXiv local download: required
- search expansion via existing `web_search`: required
- cross-source deduplication and grouping: required
- paper index record store: required
- browser-manager reuse: retained only for publisher flows
- external sources: open URL for user continuation
- record backfill for historical files: not included in this change
