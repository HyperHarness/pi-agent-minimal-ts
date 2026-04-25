# Extension-First Paper Download Design

## Goal

Replace the default Playwright-owned publisher download path with a user-browser-first workflow that can run for a long time without locking the browser profile. The system should prefer automatic PDF download from a Chrome/Edge extension running in the user's real browser profile, keep the page open when automation cannot complete, and still write verified PDFs into the existing local paper index.

## Problem

The current paper download path improved the original profile conflict by adding a single paper browser manager, but it still depends on a Playwright-owned persistent browser profile at `.browser-profile/paper-access/`. In live runs this profile remains fragile:

- Chrome profile locks can block automatic download before the publisher page even opens.
- A clean automation profile is more likely to hit login, Cloudflare, and publisher verification paths.
- APS often reaches Cloudflare challenge pages; repeated automatic retries waste time and make the state worse.
- Failure handling still depends on the agent process owning enough of the browser lifecycle to keep pages visible.

The stable long-term boundary should be different: the user owns the browser session, and the agent owns the paper task/index state.

## Decision

Make a Chrome/Edge Manifest V3 extension plus a local native messaging host the primary publisher download path.

The extension runs inside the user's normal browser profile, using the user's real cookies, login state, download manager, and manual verification flow. The native host is a local Node process registered for Chrome Native Messaging; it receives completed download metadata, verifies PDF bytes, copies files into `downloads/papers/`, and updates the existing paper index.

The current Playwright paper browser manager remains available only as a fallback for environments where the extension is not installed.

## Design Principles

- Do not try to bypass Cloudflare or publisher protections.
- Use the user's real browser profile instead of launching a separate automation profile.
- Prefer automatic extension-initiated download when the page exposes a clear PDF URL.
- If automatic download fails, keep the article tab open and listen for the user's manual download.
- Treat PDF byte validation and index write as the source of truth.
- Keep the agent-facing tools small and paper-specific.

## Architecture

### Agent

The agent keeps the existing responsibilities:

- search papers
- classify URLs
- check `downloads/papers/index/` for `already_downloaded`
- create download jobs
- expose tool results to the model

The agent should stop treating Playwright as the default publisher path. Instead, for supported publisher URLs it submits jobs to the extension bridge.

### Browser Extension

The extension is an unpacked Manifest V3 extension for Chrome/Edge in the first version. It needs:

- `downloads` permission to start and monitor downloads
- `tabs` or `activeTab` for opening and tracking paper tabs
- host permissions for supported publishers
- content scripts for Nature, Science, APS, and generic external pages
- native messaging permission to talk to the local host

The extension owns tab-level workflow state, not global paper indexing.

### Native Messaging Host

The native host is a local Node entrypoint installed through a Chrome native messaging manifest. It exposes a narrow message protocol over stdin/stdout:

- receive download job events from the extension
- validate completed PDF files
- copy or move PDFs into `downloads/papers/`
- write the existing index record shape
- report completion/failure status back to the extension

The native host must not expose a general file or shell API.

### Local Job Store

Add a small durable job store under `.browser-profile/` or `downloads/papers/index/`, for example `.browser-profile/paper-download-jobs.jsonl`.

Each job records:

- job id
- article URL
- source and canonical id when known
- title when known
- current status
- tab id if known
- download id if known
- indexed record path if completed
- failure details when blocked

This store is operational state, not the long-term knowledge base. The paper index remains the long-term source of downloaded-paper truth.

## Download State Machine

```text
queued
-> opened_in_browser
-> page_classified
-> pdf_candidate_found
-> automatic_download_started
-> downloaded
-> close_tab
```

Fallback paths:

```text
opened_in_browser
-> awaiting_user_verification
-> page_classified
```

```text
automatic_download_started
-> automatic_download_failed
-> awaiting_user_manual_download
-> manual_download_observed
-> downloaded
-> close_tab
```

```text
page_classified
-> no_pdf_candidate
-> awaiting_user_manual_download
```

## Automatic Download Policy

The extension should attempt automatic download first only when all are true:

- the page is not a Cloudflare, login, paywall, or verification page
- a publisher adapter or content script finds a clear PDF URL or download action
- the URL is associated with the active paper job
- the job has not already attempted automatic download

The extension should use `chrome.downloads.download()` for direct PDF URLs. For publisher pages that expose a button rather than a URL, the content script may click only explicit PDF/download controls on the page. It must not click verification, login, captcha, or anti-bot controls.

There is one automatic attempt per job. If it fails, the extension keeps the tab open and switches to manual download monitoring.

## Manual Download Monitoring

When automatic download cannot complete, the extension keeps the tab visible and listens to `chrome.downloads.onCreated` and `chrome.downloads.onChanged`.

To associate a user download with a job:

- prefer downloads whose `finalUrl` or `url` matches the article or PDF candidate
- use tab id or referrer information when available
- use a short time window after the tab enters manual mode
- if multiple candidates are possible, ask the user in the extension UI before indexing

After a matching download completes, the extension sends the file path to the native host. The host validates `%PDF-`, computes SHA-256, stores the PDF in `downloads/papers/`, and writes a downloaded record. After successful indexing, the extension may close the tab if the job requested auto-close.

## Cloudflare and Verification Handling

Cloudflare and verification pages are explicit handoff states.

The content script should detect common challenge indicators and report:

- `status: "awaiting_user_verification"`
- article URL
- tab id
- detected publisher
- human-readable message

The extension must not try to solve, bypass, or simulate the challenge. It keeps the tab open. When the page later navigates away from the challenge, the extension reclassifies the page and resumes PDF detection.

For APS batch jobs, after the first Cloudflare-style status in a batch, remaining jobs should open tabs and enter manual monitoring directly instead of attempting automatic download.

## Agent Tool Changes

### New Primary Tool Path

Add an extension-backed publisher download path behind the existing `download_paper` tool:

1. Check local paper index.
2. If already downloaded, return `already_downloaded`.
3. If source is arXiv, keep direct HTTP download.
4. If source is supported publisher or external URL, submit an extension job.
5. Return a structured status:
   - `extension_job_queued`
   - `opened_in_user_browser`
   - `awaiting_user_verification`
   - `awaiting_user_manual_download`
   - `downloaded`

### Existing Tool Compatibility

Keep `register_manual_paper_download` for files the user downloads outside the extension flow.

Keep `open_paper_page_for_login` as a compatibility command, but route it to the extension when available.

### Fallback

If the extension bridge is unavailable, return a clear typed result:

- `extension_unavailable`
- installation hint
- optional fallback recommendation

Do not silently launch the old Playwright profile unless the user or config explicitly enables the fallback.

## Native Host Message Protocol

Messages from extension to host:

```json
{
  "type": "register_download",
  "jobId": "job-123",
  "articleUrl": "https://example.com/paper",
  "source": "external",
  "downloadPath": "C:\\Users\\user\\Downloads\\paper.pdf",
  "title": "Optional title"
}
```

```json
{
  "type": "job_status",
  "jobId": "job-123",
  "status": "awaiting_user_verification",
  "articleUrl": "https://journals.aps.org/..."
}
```

Messages from host to extension:

```json
{
  "type": "registered",
  "jobId": "job-123",
  "recordPath": "D:\\workspace\\downloads\\papers\\index\\...",
  "downloadPath": "D:\\workspace\\downloads\\papers\\...",
  "fileSha256": "..."
}
```

Errors must be structured with `code` and `message`.

## Security Model

- The extension can only talk to one named native host.
- The native host accepts only known message types.
- The native host validates that destination paths stay inside the workspace paper directory.
- The native host reads a completed download path provided by Chrome but does not execute it.
- The extension requests host permissions only for supported publisher domains plus optional external pages opened through active tab/user gesture.
- No remote server is exposed.

## Files and Modules

Expected new areas:

- `extension/paper-downloader/manifest.json`
- `extension/paper-downloader/background.js`
- `extension/paper-downloader/content/*.js`
- `src/agent/paper-extension-host.ts`
- `src/agent/paper-extension-protocol.ts`
- `src/agent/paper-download-jobs.ts`
- tests for protocol, native host validation, job state transitions, and tool routing

Existing modules to integrate:

- `src/agent/paper-manager.ts`
- `src/agent/paper-store.ts`
- `src/agent/tools.ts`
- `src/agent/publisher-access-state.ts`

## Testing Strategy

### Unit Tests

- job state transitions
- protocol validation
- native host PDF validation and indexing
- download-to-job association rules
- extension-unavailable fallback result
- APS batch behavior after a Cloudflare handoff

### Integration Tests

- native host receives a completed PDF path and writes a downloaded index record
- `download_paper` submits an extension job when extension mode is available
- `download_paper` returns `already_downloaded` before contacting the extension
- manual fallback path still accepts `register_manual_paper_download`

### Manual Verification

The success criteria require live browser checks:

- Nature article with clear PDF: extension auto-downloads, host indexes, tab closes.
- arXiv remains direct HTTP and de-dupes through the existing index.
- APS article behind Cloudflare: extension opens tab, reports verification state, keeps page open, observes user download, host indexes.
- A failed automatic download leaves the tab open and can still complete through manual download monitoring.

## Rollout Plan

### Phase 1: Native Host and Index Registration

Build the host protocol and reuse existing paper-store registration logic. Validate completed PDF files and write index records.

### Phase 2: Extension Download Listener

Build the extension shell, native messaging connection, and download completion monitoring. Support manual download observation first.

### Phase 3: Extension Auto Download

Add PDF candidate detection and one-shot automatic download. Close tabs only after host-confirmed indexing.

### Phase 4: Agent Tool Routing

Route publisher and external downloads through the extension bridge by default. Keep Playwright fallback behind an explicit config flag.

### Phase 5: Publisher-Specific Refinement

Add dedicated content scripts and heuristics for Nature, Science, and APS. Keep Cloudflare as manual handoff.

## Success Criteria

- Default publisher download no longer launches a Playwright-owned persistent profile.
- Existing user browser profile can stay open indefinitely without profile-lock failures.
- Automatic extension download succeeds for straightforward PDF pages.
- Failed automatic download leaves the article page open.
- User manual download is detected and indexed without extra copy/paste steps.
- Cloudflare challenges become visible handoff states, not repeated automatic failures.
- Indexed PDFs continue to return `already_downloaded`.

## First Implementation Decisions

- Target Chrome and Edge on Windows using the same unpacked Manifest V3 extension code.
- Auto-close article tabs by default only after the native host confirms that the PDF was indexed. Keep a per-job `autoClose` flag so tests and troubleshooting can disable closing.
- Put the Windows native host registration script under `scripts/` and document it in the Windows quickstart plus README.
- Use explicit host permissions for Nature, Science, APS, and arXiv. Use `activeTab` for ad hoc external pages in the first version instead of broad external host permissions.
