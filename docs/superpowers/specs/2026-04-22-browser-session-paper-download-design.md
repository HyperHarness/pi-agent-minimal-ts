# Browser Session Paper Download Design

Date: 2026-04-22

## Goal

Add a paper download capability to the agent that can use a user-managed, already-authorized Chrome browser session to access publisher-hosted PDFs and save them into the workspace.

This capability is explicitly limited to lawful reuse of the user's own browser session. It must not automate credential entry, bypass paywalls, defeat CAPTCHA or MFA, or attempt to extract protected content outside the permissions already granted to the logged-in user.

## Scope

### In scope

- Launch or connect to a dedicated Chrome profile for paper access.
- Reuse the existing browser session after the user has manually completed any institutional login flow.
- Open article landing pages and resolve PDF download flows for an initial set of publishers:
  - `science.org`
  - `nature.com`
  - `journals.aps.org` / `aps.org`
- Download the PDF into a fixed workspace directory.
- Expose the flow through a new agent tool.
- Return structured success or failure diagnostics.

### Out of scope

- Automatic username/password entry.
- CAPTCHA solving, MFA handling, paywall bypassing, or DRM removal.
- Unsupported publisher automation beyond the first three target domains.
- Background browser session syncing across machines.
- Bulk citation management or metadata enrichment beyond what is required for download diagnostics.

## Primary Use Case

The user gives the agent a paper URL such as a DOI landing page or article page URL. The agent uses a dedicated Chrome profile that the user has already logged into via institutional access, navigates to the page, resolves the publisher's PDF access path, downloads the file into the repository workspace, and returns the local file path plus diagnostic information.

## Success Criteria

- A single dedicated Chrome profile can be reused across runs.
- For the three URLs listed in `paper_url.txt`, the tool attempts a download using the live browser session.
- For authorized content, the PDF is saved under `downloads/papers/`.
- For unauthorized, expired, or broken sessions, the tool fails with a specific explanation instead of a generic timeout.
- Re-running against the same paper skips an existing file unless overwrite is explicitly requested in a future iteration.

## User Experience

### First-run setup

The user starts the tool for the first time. If the dedicated Chrome profile is not authenticated for the target publisher, the tool opens the article page in that profile and reports that manual login is required. The user completes institutional login in the browser. The tool can then be re-run against the same URL.

### Normal run

The user asks the agent to download a paper PDF from a supported publisher URL. The tool reuses the saved Chrome profile, resolves the article page, finds the PDF route, downloads the file, and returns a structured result.

### Failure modes

The tool should distinguish among:

- unsupported publisher
- browser launch/connect failure
- manual login required
- authorization/session expired
- article page loaded but no PDF entry point found
- download started but file was not written

## Architecture

The feature is split into four layers.

### 1. Browser session runtime

Responsibility:

- own the dedicated Chrome user data directory
- launch or connect to Chrome
- create a page/context handle for the workflow

Design:

- use a fixed profile path inside the workspace, for example `.browser-profile/paper-access/`
- treat this profile as user-owned state, not test fixture state
- avoid storing credentials outside the browser profile

### 2. Publisher adapters

Responsibility:

- recognize whether a URL belongs to a supported publisher
- drive the article-page-to-PDF flow for that publisher
- detect recognizable authorization failures

Initial adapters:

- `science.org`
- `nature.com`
- `aps.org`

Each adapter should expose a consistent interface such as:

- `matches(url)`
- `prepareArticlePage(page, url)`
- `resolvePdfTarget(page)`
- `classifyFailure(page)`

### 3. Paper download service

Responsibility:

- orchestrate browser runtime plus publisher adapter
- derive the output filename
- ensure the output directory exists
- save the PDF into the workspace
- return structured diagnostics

This layer owns the high-level workflow and is the main unit under test.

### 4. Agent tool

Responsibility:

- expose the service as a tool such as `download_paper_pdf`
- validate inputs
- map service results into tool text plus structured details

## Detailed Flow

1. Validate the requested article URL.
2. Select a publisher adapter based on hostname.
3. Launch or connect to the dedicated Chrome session.
4. Open the article landing page in the browser.
5. Let the adapter determine whether the page is ready, unauthorized, or unsupported.
6. Resolve the PDF entry point.
7. Trigger or fetch the PDF download through the authenticated browser session.
8. Save the resulting PDF to `downloads/papers/`.
9. Return:
   - local file path
   - original article URL
   - final article URL
   - final PDF URL if known
   - publisher ID
   - whether the session appeared authorized

## File Layout

Proposed additions:

- `src/agent/paper-download.ts`
- `src/agent/browser-session.ts`
- `src/agent/publisher-adapters/`
- `test/agent/paper-download.test.ts`
- `test/agent/publisher-adapters/`

Documentation:

- README section for browser-session-based paper downloading

Workspace output:

- `downloads/papers/`
- `.browser-profile/paper-access/`

## Tool Contract

Proposed initial tool:

- name: `download_paper_pdf`
- inputs:
  - `url: string`

Initial behavior:

- download the PDF if authorized
- fail with a structured error if login is required or the publisher is unsupported

Future options that are intentionally deferred:

- custom output path
- overwrite control
- batch download mode

## Output Naming

Default naming strategy:

1. DOI-derived safe filename when available
2. otherwise final article slug
3. if needed, append a timestamp to avoid collisions

Examples:

- `10.1126_science.adz8659.pdf`
- `s41586-019-1666-5.pdf`

## Error Handling

Errors should be classified into stable categories rather than returned as raw browser exceptions.

Suggested categories:

- `unsupported_publisher`
- `browser_session_unavailable`
- `manual_login_required`
- `authorization_failed`
- `pdf_not_found`
- `download_failed`

Each category should include a short human-readable message suitable for the REPL.

## Testing Strategy

### Unit tests

Cover:

- publisher matching
- filename normalization
- output path generation
- error classification

### Integration-style tests

Use mocked browser/page abstractions or HTML fixtures to validate adapter logic without requiring real publisher access in CI.

Cover:

- successful PDF link resolution
- expired session detection
- missing PDF button handling

### Manual acceptance tests

Run against the three URLs in `paper_url.txt` using the user's dedicated Chrome profile and institutional access.

Acceptance is complete when:

- each URL reaches a deterministic outcome
- successful downloads are written into `downloads/papers/`
- failures are classified correctly

## Security And Privacy

- Reuse only the dedicated Chrome profile.
- Do not export or log cookies, access tokens, or institution identifiers.
- Do not print authenticated request headers.
- Keep all downloads inside the workspace.
- Do not implement automated credential capture or replay outside browser-managed session state.

## Open Decisions Resolved

- Browser: Chrome
- Session source: dedicated browser session, not exported cookie JSON
- Success mode: direct download into workspace
- Test set: the three article URLs in `paper_url.txt`

## Future Extensions

Possible later work after the first version is stable:

- support more publishers
- batch download tool for a file of URLs
- session health check tool
- optional metadata sidecar JSON per downloaded paper
