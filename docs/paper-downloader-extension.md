# Paper Downloader Browser Extension

This guide installs the Pi Agent paper downloader extension for Chrome or Edge and connects it to the local native host.

Use this path for `download_paper` on supported publisher and external URLs. arXiv direct downloads do not require the extension.

## What It Does

- Opens publisher and external paper pages in your normal browser profile.
- Attempts one direct PDF download when a PDF URL is available.
- Keeps the tab open when the page needs login, verification, or manual download.
- Watches completed browser PDF downloads and registers them in `downloads/papers/`.
- Lets later `download_paper` calls return `already_downloaded` from the local index.

## Prerequisites

- Chrome or Edge installed.
- Node.js and npm available in PowerShell.
- Dependencies installed in this repository.
- The agent built at least once:

```powershell
npm.cmd run build
```

## Install Or Update The Extension

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer Mode.
3. Choose **Load unpacked**.
4. Select:

```text
extension/paper-downloader
```

5. Copy the extension ID from the extension card.
6. Register the native host from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/register-paper-extension-host.ps1 -ExtensionId <extension-id>
```

7. Fully restart Chrome or Edge.
8. Restart the agent.

When updating this repository, reload the unpacked extension from `chrome://extensions` or `edge://extensions`. The extension version is shown on the extension card and in `extension/paper-downloader/manifest.json`.

## Verify Registration

Chrome:

```powershell
reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pi_agent.paper_downloader /ve
```

Edge:

```powershell
reg query HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.pi_agent.paper_downloader /ve
```

The default value should point to:

```text
.browser-profile\native-messaging\com.pi_agent.paper_downloader.json
```

The manifest should contain your extension ID in `allowed_origins`.

## Use It

Start the agent from this repository after building:

```powershell
npm.cmd run agent
```

Then ask for a publisher paper:

```text
Download this paper with download_paper: https://www.nature.com/articles/s41586-019-1666-5
```

Expected first-stage tool result:

```text
extension_job_queued
```

The extension should then open the paper page in your normal browser.

If the extension can download and register the PDF, the tab closes after native-host confirmation. If the page needs login, Cloudflare verification, or manual download, the tab stays open.

## Troubleshooting

If `download_paper` starts Playwright, you are probably running an old branch, old process, or explicit fallback path. Restart the agent from the repository that contains `createQueuedPaperExtensionBridge` in `src/pi-agent.ts`.

If the tool returns `extension_unavailable`, confirm you are running the current `main`, rebuilt with `npm.cmd run build`, and restarted the agent.

If the browser opens a page but registration never completes:

- Confirm the native host registry key exists.
- Confirm the manifest `allowed_origins` uses the current extension ID.
- Confirm the downloaded file is a PDF.
- Keep the browser tab open and download the PDF manually from that tab.

If the extension ID changes after reinstalling the unpacked extension, rerun:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/register-paper-extension-host.ps1 -ExtensionId <new-extension-id>
```
