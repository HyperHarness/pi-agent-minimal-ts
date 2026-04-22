# Manual Paper Download Fallback Design

Date: 2026-04-23

## Goal

Extend `download_paper_pdf` so it still tries automatic browser-session download first, but when automatic download cannot complete, it automatically falls back to opening the paper page in the user's local Chrome or Edge browser with the shared `paper-access` profile and returns a structured non-error result for manual continuation.

This feature is explicitly limited to lawful reuse of the user's own browser session. It must not automate credential entry, bypass paywalls, defeat CAPTCHA or MFA, or attempt to extract protected content outside the permissions already granted to the logged-in user.

## Scope

### In scope

- Keep the current automatic `download_paper_pdf` flow as the first attempt.
- Add a manual fallback path when automatic download fails.
- Launch the local Chrome or Edge executable directly for fallback, without Playwright controlling the opened page.
- Reuse the existing workspace profile directory at `.browser-profile/paper-access/`.
- Return a structured success-like fallback result instead of throwing when fallback is triggered.
- Preserve the existing successful automatic download behavior.
- Document the new fallback behavior in README.

### Out of scope

- Waiting for the user to finish the manual browser interaction.
- Detecting whether the user completed the manual download after the fallback page opens.
- Importing files from the browser's default downloads directory back into the workspace.
- Adding background polling or OS-level download tracking.
- Automatically resuming the same failed download attempt after the user interacts with the browser.
- Any attempt to disguise Playwright automation or bypass site bot defenses.

## Primary Use Case

The user asks the agent to download a supported paper. The agent first tries the current automated download flow. If that flow succeeds, it writes the PDF into `downloads/papers/` and returns the normal result. If that flow fails for any supported operational reason, the agent immediately opens the paper URL in the user's local Chrome or Edge browser using the same dedicated `paper-access` profile and returns a structured result that tells the caller the page has been opened for manual continuation.

## Success Criteria

- Successful automatic downloads still return the current result shape, with an explicit success status.
- Automatic failures no longer surface as hard tool errors when fallback is possible.
- The fallback launches a normal local browser window with the shared `paper-access` profile.
- The fallback result clearly tells the caller that manual continuation is required and includes the failure reason from the automatic attempt.
- The fallback path does not use Playwright to control the opened page.
- Existing automatic download tests keep passing.

## User Experience

### Automatic success

The user runs `download_paper_pdf`. The tool downloads the PDF into the workspace and returns a `downloaded` status with the same key metadata as today.

### Automatic failure with fallback

The user runs `download_paper_pdf`. Automatic download fails. Instead of surfacing a tool error, the tool launches the local browser with the dedicated profile, opens the original paper page, and returns a `manual_fallback_opened` status that includes:

- the original requested URL
- the failure category and message from the automatic attempt
- the local browser executable path used for fallback
- the shared profile path
- the URL that was opened for manual continuation

### Hard failure

If the fallback browser cannot be launched at all, the tool still fails with a hard error. This remains necessary because the requested recovery action could not be performed.

## Trigger Conditions

The fallback should be attempted for these automatic failure categories:

- `browser_session_unavailable`
- `manual_login_required`
- `authorization_failed`
- `pdf_not_found`
- `download_failed`

The fallback should also be attempted when the automatic path reports success but the written file does not have a valid PDF signature.

The fallback should not be attempted for:

- unsupported publisher input
- invalid tool arguments
- local fallback browser launch failure

## Architecture

The change is split into three layers.

### 1. Automatic download service enhancement

Responsibility:

- preserve the existing automatic download workflow
- add result validation for the written file
- classify the automatic outcome as either final success or fallback-eligible failure

This layer should keep the existing `downloadPaperPdf` service focused on actual download behavior. It should continue throwing typed errors for automatic-stage failures.

### 2. Local browser fallback launcher

Responsibility:

- resolve the local Chrome or Edge executable path
- launch a normal browser window detached from the agent process
- reuse the workspace profile directory `.browser-profile/paper-access/`
- open the original paper URL for manual continuation

This layer must not use Playwright. It should call the local browser executable directly with `--user-data-dir=<profileDir>` and the target URL.

### 3. Tool orchestration

Responsibility:

- keep `download_paper_pdf` as the single user-facing tool
- try the automatic download first
- on fallback-eligible failure, invoke the local browser fallback launcher
- return a structured non-error fallback result

This orchestration belongs in the tool layer because the desired policy is specifically about user-facing tool behavior, not the core download service contract.

## Detailed Flow

1. Validate the requested article URL.
2. Run the existing automatic `downloadPaperPdf` flow.
3. If automatic download succeeds:
   - verify the written file starts with `%PDF-`
   - return a `downloaded` result
4. If automatic download fails with a fallback-eligible category:
   - launch the local Chrome or Edge browser directly
   - reuse `.browser-profile/paper-access/`
   - open the original article URL
   - return a `manual_fallback_opened` result
5. If automatic download fails with a non-fallback-eligible category:
   - preserve the hard failure behavior
6. If local browser fallback launch fails:
   - return a hard failure because the recovery action could not be completed

## Result Contract

`download_paper_pdf` becomes a discriminated result with explicit status.

### Automatic success result

- `status: "downloaded"`
- `path: string`
- `publisher: "science" | "nature" | "aps"`
- `articleUrl: string`
- `finalArticleUrl: string`
- `finalPdfUrl: string`

### Manual fallback result

- `status: "manual_fallback_opened"`
- `fallbackRequired: true`
- `articleUrl: string`
- `fallbackUrl: string`
- `profileDir: string`
- `executablePath: string`
- `failure: { code: string; message: string }`

This result is intentionally not a hard error. The caller can continue the user conversation using the returned details.

## File Layout

Expected touch points:

- `src/agent/browser-session.ts`
  - add local browser executable resolution and detached launch helper
- `src/agent/tools.ts`
  - orchestrate automatic download plus fallback return behavior
- `test/agent/browser-session.test.ts`
  - cover local browser executable resolution and launch arguments
- `test/agent/tools.test.ts`
  - cover tool-level fallback behavior and preserved success path
- `README.md`
  - explain the new fallback semantics for `download_paper_pdf`

## Error Handling

The automatic-stage typed errors remain the source of truth for failure classification. The tool should map them like this:

- automatic success -> `status: "downloaded"`
- fallback-eligible failure + browser launch success -> `status: "manual_fallback_opened"`
- fallback-eligible failure + browser launch failure -> hard tool error
- non-fallback-eligible failure -> hard tool error

The fallback result must preserve the original automatic failure code and message for operator visibility.

## Testing Strategy

### Unit tests

Cover:

- local browser executable path resolution preference order
- local browser launch arguments, especially `--user-data-dir`
- fallback result structure
- successful download path remains unchanged except for explicit status

### Tool tests

Cover:

- automatic success returns `status: "downloaded"` and does not launch fallback
- fallback-eligible automatic failure launches local browser and returns `manual_fallback_opened`
- fallback browser launch failure still rejects

### Manual verification

Run `download_paper_pdf` against a logged-in publisher page while the profile is already authorized. If automatic download still cannot proceed, confirm that the fallback opens the same paper page in the local browser without surfacing a hard tool error.

## Security And Privacy

- Reuse only the dedicated workspace profile.
- Do not export cookies or session tokens.
- Do not log authenticated request headers.
- Do not scrape the manually opened browser page after fallback launch.
- Do not add any anti-bot evasion logic.

## Open Decisions Resolved

- User-facing tool: keep `download_paper_pdf` as the single entry point
- Fallback browser: local Chrome or Edge executable
- Fallback launch mode: direct browser process, not Playwright
- Fallback return style: non-error structured result
- Fallback trigger set: all typed automatic download failures except unsupported/invalid input, plus invalid downloaded-file signature

## Future Extensions

Possible later work after this policy is stable:

- detect when the user has manually completed a download and offer import into `downloads/papers/`
- add a separate post-download import tool for browser download folders
- add an explicit `retry_after_manual_login` helper
- add optional output naming that reflects manual fallback attempts
