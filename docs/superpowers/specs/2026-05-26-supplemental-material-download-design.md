# Supplemental Material Download Design

## Goal

When a supported publisher article page exposes supplemental material, the paper acquisition flow downloads those files alongside the article PDF and makes them visible from the same paper record. This applies to Science, Nature, and APS publisher flows, including APS pages such as `https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502`.

## Current Behavior

The browser extension can identify and download the main article PDF for supported publishers, then the native host registers the PDF as the primary `downloaded` paper artifact. Science supplementary PDFs are currently rejected when they look like the main download target, which prevents a supplement from being mistaken for the article PDF. APS currently derives a main PDF URL from abstract or DOI pages, but it does not collect supplemental material links.

## Architecture

Supplemental material is a secondary artifact on a paper record, not a standalone paper and not a replacement for the main PDF. The extension detects supplemental links on the article page, fetches the files with browser credentials, and sends them to the native host in a new registration message. The native host writes them under a dedicated supplemental-material root and merges metadata into the same acquisition record as the main article.

## Data Model

Add a `supplementalMaterials` array to publisher paper records and source metadata. Each item records:

- `url`: the resolved publisher URL.
- `title`: the visible link text or publisher label when available.
- `filename`: the stored basename.
- `path`: the workspace-local stored file path.
- `mimeType`: browser-provided response content type when available.
- `sha256`: content hash.
- `downloadedAt`: ISO timestamp.

The primary record fields `status`, `downloadPath`, `pdfUrl`, `parse`, `webpage`, and `reading` keep their existing meanings.

## Extension Flow

The content scripts collect supplemental candidates from article pages. Generic detection covers links labeled `Supplemental Material`, `Supplementary Material`, `Supplementary Information`, and URL patterns containing `/supplemental/`, `/doi/suppl/`, or `suppl_file`. APS gets publisher-specific URL derivation from a DOI or abstract page when the page implies supplemental material but does not expose a simple direct link.

The background worker fetches each candidate with `credentials: "include"`, enforces a small count and size cap, and sends a native-host registration message for each successfully fetched file. A failed supplemental fetch is reported as a job status event but does not fail the main article PDF download.

## Native Host Flow

The native host accepts supplemental material bytes, resolves the article canonical ID, writes files under `knowledge-base/raw/supplemental/<source>/<canonical-id>/`, and merges or replaces entries by URL/content hash. It appends a job event so `.browser-profile/paper-download-jobs.jsonl` shows which supplemental files were saved.

Supplemental files are never registered through the existing main `register_download` path. The existing Science supplement rejection remains for the main PDF path, but Science supplements can be accepted through the new supplemental-material path.

## Wiki-Agent Behavior

Wiki evidence and local-library views can discover that a paper has supplemental materials from the paper record. The first implementation does not parse supplemental PDFs as primary article text and does not create separate wiki pages for them. The wiki agent can cite or inspect the saved supplemental artifact later through the same source record.

## Error Handling

If the main article PDF download succeeds but one or more supplemental downloads fail, the paper remains downloaded and the job history records the supplemental failure. If supplemental registration happens before the paper record exists, the native host creates or updates the publisher acquisition record keyed by source and canonical ID without changing the main PDF status to `downloaded` unless the main PDF has actually been registered.

## Testing

Tests should prove the behavior without live publisher traffic:

- Extension helper tests detect APS, Science, and Nature supplemental links while still returning the main PDF candidate.
- Background worker tests fetch supplemental candidates with browser credentials and send native registration messages without blocking the main PDF download.
- Protocol tests validate the new supplemental registration message and response shape.
- Native-host tests save supplemental bytes under the supplemental root and merge metadata into the existing publisher record.
- Regression tests keep Science supplementary PDFs out of the main `register_download` path.
- Full validation uses `npm test`; the separate browser-extension test remains `node --test test/browser-extension/paper-downloader.test.mjs` when extension-only files change.
