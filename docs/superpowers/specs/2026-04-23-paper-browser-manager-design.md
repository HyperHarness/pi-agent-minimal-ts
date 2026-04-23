# Paper Browser Manager Design

## Goal

Replace the current "each tool launch owns the browser profile" model with a single reusable browser owner for paper downloads. The design must eliminate `paper-access` profile contention between automatic download and manual continuation while keeping the user-facing agent tools simple.

## Problem

The current implementation uses one shared Chrome profile at `.browser-profile/paper-access/`, but ownership is split across two incompatible paths:

- automatic download launches a Playwright persistent context against that profile
- manual fallback launches a normal Chrome window against the same profile

This causes a hard conflict on Windows. Once manual fallback opens Chrome, later automatic download attempts cannot launch Playwright on the same profile. The result is a repeated `browser_session_unavailable` failure even though the browser session itself is still useful.

There is also a second issue in the current automatic download path: some publisher PDF URLs, especially Nature, can be rendered through Chrome's built-in PDF viewer page instead of returning raw PDF bytes via page navigation. That issue can be fixed locally, but it does not solve the larger profile-ownership conflict.

## Decision

Introduce a single-instance paper browser manager that is the only owner of `.browser-profile/paper-access/`.

The agent will no longer launch or manually spawn browsers directly for paper tools. Instead, it will connect to the browser manager and request actions such as:

- open an article page for manual review
- download a PDF using the existing authenticated browser session
- report health and connection state

This starts as a lightweight local manager for one workstation, one profile, and one active browser instance. It is not a general job queue or multi-user service.

## Recommended Architecture

### Browser Owner

A dedicated local process starts Chrome once with:

- the fixed `.browser-profile/paper-access/` user data directory
- remote debugging enabled
- a machine-local endpoint for discovery

That process keeps Chrome alive and is solely responsible for the browser lifecycle. It may use Playwright attached over CDP or a direct CDP client internally, but the key rule is that the manager owns the browser and the profile for the whole session.

### Agent Integration

The agent tool layer stops calling `chromium.launchPersistentContext()` directly for paper work. Instead it:

1. locates the running paper browser manager
2. asks it to execute one of a small set of commands
3. receives structured results

The user-facing tools remain the same:

- `open_paper_page_for_login`
- `download_paper_pdf`

Only the implementation behind those tools changes.

### Local Control Channel

Use a small local control channel, not a general network service. Two practical options are acceptable:

- loopback HTTP on a fixed or discoverable localhost port
- named pipe on Windows

For initial implementation, localhost HTTP is preferred because it is easier to inspect, test, and debug from Node. The manager should bind only to loopback and reject non-local access.

## Scope

### In Scope

- one single-instance paper browser manager per workspace or machine
- one shared `paper-access` profile
- agent-to-manager commands for paper download and manual page open
- discovery and health checks
- recovery when the browser dies or the manager loses its session
- clear user-facing errors when the manager is unavailable

### Out of Scope

- multi-user coordination
- distributed execution
- generic browser automation APIs
- task persistence across machine restarts
- arbitrary tab management beyond what paper download and manual review need

## High-Level Flow

### Automatic Download

1. User calls `download_paper_pdf`.
2. Tool asks the manager for a download session.
3. Manager opens or reuses a browser tab inside the managed browser.
4. Manager navigates to the article page, resolves the PDF URL, and downloads bytes using the authenticated browser session.
5. Manager returns structured metadata:
   - `status: "downloaded"`
   - output path
   - final article URL
   - final PDF URL

### Manual Continuation

1. Automatic download cannot complete, or user explicitly asks to open for login.
2. Tool asks the manager to open the article page in the already-managed browser.
3. Manager opens a new tab in the managed browser window.
4. Manager returns structured metadata:
   - opened URL
   - profile directory
   - manager/browser identity

This keeps manual continuation and automatic download inside the same browser owner instead of switching ownership models.

## Manager API

The manager should expose only a minimal API.

### `GET /health`

Returns:

- manager running state
- browser connected state
- profile path
- browser endpoint metadata

### `POST /open-article`

Input:

- article URL

Returns:

- opened URL
- tab identifier if available

### `POST /download-pdf`

Input:

- article URL
- workspace output directory

Returns:

- status
- saved path
- publisher id
- final article URL
- final PDF URL

### `POST /shutdown`

Optional for development and tests only. Not required for normal user flows.

## Discovery and Single-Instance Rules

There must be exactly one active manager for the paper profile.

Recommended mechanism:

- a lock file plus connection metadata written under the workspace, for example `.browser-profile/paper-access-manager.json`
- metadata includes:
  - PID
  - start time
  - control endpoint
  - profile path

Agent behavior:

- if metadata exists and manager responds to `/health`, reuse it
- if metadata exists but manager is dead, clear stale metadata and start a fresh manager
- if metadata does not exist, start a manager

This is simpler and more robust than probing arbitrary Chrome processes.

## Error Handling

### Manager Unavailable

If the agent cannot reach the manager, return a clear error that says the manager is unavailable or failed to start. Do not fall back to launching a separate Chrome process with the same profile.

### Browser Lost

If the manager is alive but the browser connection is gone, the manager should restart the managed browser and reattach before failing the request.

### Publisher Access Problems

Keep current typed categories where possible:

- `manual_login_required`
- `authorization_failed`
- `pdf_not_found`
- `download_failed`

These remain useful regardless of the new process boundary.

### Download Semantics

Prefer byte-verified completion over browser download events alone. The manager should treat `%PDF-` signature validation as the success criterion for saved files, because some navigation paths can return viewer HTML while still claiming `application/pdf`.

## Security Model

- manager listens only on loopback
- no remote access
- command set is narrow and paper-specific
- no arbitrary navigation or script execution API
- output paths remain inside the workspace-controlled paper download directory

## Testing Strategy

### Unit Tests

- discovery logic
- stale-manager cleanup
- manager client request/response handling
- filename generation and output-path handling
- typed error translation across the manager boundary

### Integration Tests

- start manager once, reuse across repeated download requests
- manual open followed by automatic download without profile contention
- manager restarts browser after simulated crash
- failure when manager endpoint exists but is stale

### Manual Verification

- start manager
- open a supported paper for manual review
- complete any human verification in that same browser
- run `download_paper_pdf` again without closing the browser
- confirm the download succeeds from the same managed browser session

This manual flow is the key success criterion because it directly targets the current profile-lock failure mode.

## Tradeoffs

### Benefits

- removes profile ownership conflict by design
- preserves authenticated browser state between manual and automatic steps
- makes "open for login, then retry download" a first-class supported flow
- gives a cleaner place to centralize browser diagnostics and recovery

### Costs

- adds a new local process and lifecycle management
- introduces discovery, health, and stale-process cleanup logic
- requires a client/server boundary even though both sides are local

These costs are acceptable because the current architecture fundamentally conflicts with shared-profile reuse.

## Rollout Plan

### Phase 1

Create the manager process and local discovery/health model.

### Phase 2

Move `open_paper_page_for_login` to use the manager.

### Phase 3

Move `download_paper_pdf` to use the manager.

### Phase 4

Delete direct profile-owning browser launch from the agent tool path once the manager-backed path is stable.

## Open Questions Resolved

- Full daemon framework: not needed initially
- Multi-user support: explicitly out of scope
- General browser RPC: rejected; paper-specific commands only
- Browser reuse strategy: manager-owned single browser instance is the chosen model

## Success Criteria

- manual page open and automatic download can both happen without closing the browser
- the same `paper-access` session can be reused after login or verification
- the agent no longer fails because the shared profile is already open
- user-facing tool behavior stays stable while backend ownership changes
