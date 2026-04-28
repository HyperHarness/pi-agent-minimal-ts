const NATIVE_HOST_NAME = "com.pi_agent.paper_downloader";
const POLL_ALARM_NAME = "pi-agent-paper-download-poll";
const EXTENSION_INSTANCE_ID = "chrome-main";
const STORAGE_KEY = "piAgentPaperDownloaderState";
const QUICK_POLL_INTERVAL_MS = 2000;
const QUICK_POLL_ACTIVE_MS = 5 * 60 * 1000;

const jobsById = new Map();
const jobsByTabId = new Map();
const downloadsById = new Map();
const openingJobIds = new Set();

let stateReady = hydrateState();
let quickPollTimer = null;
let quickPollUntil = 0;

function logAsyncError(label, error) {
  console.warn(`Pi Agent ${label} failed`, error);
}

function emptyStoredState() {
  return {
    jobs: {},
    downloads: {}
  };
}

function serializeState() {
  const jobs = {};
  const downloads = {};

  for (const [jobId, job] of jobsById.entries()) {
    jobs[jobId] = job;
  }
  for (const [downloadId, trackedDownload] of downloadsById.entries()) {
    downloads[String(downloadId)] = trackedDownload;
  }

  return { jobs, downloads };
}

async function hydrateState() {
  const stored = await chrome.storage.local.get({ [STORAGE_KEY]: emptyStoredState() });
  const state = stored[STORAGE_KEY] || emptyStoredState();

  jobsById.clear();
  jobsByTabId.clear();
  downloadsById.clear();

  for (const [jobId, job] of Object.entries(state.jobs || {})) {
    const trackedJob = { ...job, jobId: job.jobId || jobId };
    jobsById.set(trackedJob.jobId, trackedJob);
    if (typeof trackedJob.tabId === "number") {
      jobsByTabId.set(trackedJob.tabId, trackedJob);
    }
  }

  for (const [downloadId, trackedDownload] of Object.entries(state.downloads || {})) {
    downloadsById.set(Number(downloadId), trackedDownload);
  }
}

async function persistState() {
  await chrome.storage.local.set({ [STORAGE_KEY]: serializeState() });
}

async function withHydratedState(work) {
  await stateReady;
  return work();
}

async function sendNativeMessage(message) {
  try {
    return await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message);
  } catch (error) {
    console.warn("Pi Agent native host message failed", error);
    return {
      type: "error",
      code: "native_message_failed",
      message: error instanceof Error ? error.message : "Native host message failed."
    };
  }
}

async function reportJobStatus(job, status, message) {
  return sendNativeMessage({
    type: "job_status",
    jobId: job.jobId,
    status,
    articleUrl: job.articleUrl,
    source: job.source,
    ...(message ? { message } : {})
  });
}

async function openQueuedJob(job) {
  if (!job || jobsById.has(job.jobId) || openingJobIds.has(job.jobId)) {
    return;
  }

  openingJobIds.add(job.jobId);
  try {
    if (jobsById.has(job.jobId)) {
      return;
    }

    const tab = await chrome.tabs.create({ url: job.articleUrl, active: true });
    const trackedJob = {
      ...job,
      tabId: tab.id,
      automaticDownloadAttempted: false,
      pdfUrl: undefined
    };
    jobsById.set(job.jobId, trackedJob);
    if (typeof tab.id === "number") {
      jobsByTabId.set(tab.id, trackedJob);
    }
    await persistState();
    await reportJobStatus(trackedJob, "opened_in_browser", "Opened in browser tab.");

    if (trackedJob.source === "external") {
      if (urlPathEndsWithPdf(trackedJob.articleUrl)) {
        await startAutomaticDownload(trackedJob, trackedJob.articleUrl);
        return;
      }

      await enterManualDownloadMode(
        trackedJob,
        "External paper page opened. Download the PDF manually from this tab."
      );
    }
  } finally {
    openingJobIds.delete(job.jobId);
  }
}

async function pollJobs() {
  await withHydratedState(async () => {
    const response = await sendNativeMessage({
      type: "poll_jobs",
      extensionInstanceId: EXTENSION_INSTANCE_ID
    });

    if (!response || response.type !== "jobs" || !Array.isArray(response.jobs)) {
      return;
    }

    for (const job of response.jobs) {
      await openQueuedJob(job);
    }
  });
}

function scheduleQuickPoll(extendWindow = true) {
  if (extendWindow) {
    quickPollUntil = Math.max(quickPollUntil, Date.now() + QUICK_POLL_ACTIVE_MS);
  }
  if (quickPollTimer !== null) {
    return;
  }

  quickPollTimer = setTimeout(async () => {
    quickPollTimer = null;
    await pollJobs().catch((error) => logAsyncError("quick poll", error));
    if (Date.now() < quickPollUntil) {
      scheduleQuickPoll(false);
    }
  }, QUICK_POLL_INTERVAL_MS);

  if (quickPollTimer && typeof quickPollTimer.unref === "function") {
    quickPollTimer.unref();
  }
}

async function enterManualDownloadMode(job, message) {
  await reportJobStatus(
    job,
    "awaiting_user_manual_download",
    message || "Waiting for the user to download the PDF manually."
  );
}

function sanitizeFilenamePart(value) {
  var sanitized = String(value || "")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[ .]+$/g, "");

  return sanitized || "paper";
}

function filenamePartFromPathOrUrl(value) {
  var basename = basenameFromPathOrUrl(value);
  return basename.replace(/\.pdf$/i, "");
}

function canonicalPartFromPublisherUrl(source, articleUrl, pdfUrl) {
  var candidates = [articleUrl, pdfUrl].filter(Boolean);

  for (var index = 0; index < candidates.length; index += 1) {
    try {
      var parsed = new URL(candidates[index]);
      if (source === "nature") {
        var natureMatch = parsed.pathname.match(/^\/articles\/([^/?#]+?)(?:\.pdf)?$/i);
        if (natureMatch && natureMatch[1]) {
          return decodeURIComponent(natureMatch[1]);
        }
      }

      if (source === "science") {
        var scienceMatch = parsed.pathname.match(/^\/doi\/(?:(?:pdf|full|abs|epdf)\/)?(.+)$/i);
        if (scienceMatch && scienceMatch[1]) {
          return decodeURIComponent(scienceMatch[1]).replace(/\.pdf$/i, "");
        }
      }

      if (source === "aps") {
        var apsDirectMatch = parsed.pathname.match(/^\/doi\/(?:pdf\/)?(.+)$/i);
        if (apsDirectMatch && apsDirectMatch[1]) {
          return decodeURIComponent(apsDirectMatch[1]).replace(/\.pdf$/i, "");
        }

        var apsJournalMatch = parsed.pathname.match(/^\/[^/]+\/(?:abstract|pdf)\/(.+)$/i);
        if (apsJournalMatch && apsJournalMatch[1]) {
          return decodeURIComponent(apsJournalMatch[1]).replace(/\.pdf$/i, "");
        }
      }
    } catch (error) {
      // Fall back to URL basename below.
    }
  }

  return filenamePartFromPathOrUrl(pdfUrl) || filenamePartFromPathOrUrl(articleUrl);
}

function buildDefaultDownloadFilename(job, pdfUrl) {
  var source = sanitizeFilenamePart(job && job.source ? job.source : "paper").toLowerCase();
  var canonical = canonicalPartFromPublisherUrl(source, job && job.articleUrl, pdfUrl);
  var stem = sanitizeFilenamePart(source + "-" + (canonical || "paper"));
  return "pi-agent-papers/" + stem + ".pdf";
}

async function startAutomaticDownload(job, pdfUrl) {
  if (job.automaticDownloadAttempted) {
    return;
  }

  job.automaticDownloadAttempted = true;
  job.pdfUrl = pdfUrl;
  await persistState();
  await reportJobStatus(job, "pdf_candidate_found", "Found a direct PDF candidate.");

  try {
    var filename = buildDefaultDownloadFilename(job, pdfUrl);
    const downloadId = await chrome.downloads.download({
      url: pdfUrl,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });
    downloadsById.set(downloadId, {
      jobId: job.jobId,
      articleUrl: job.articleUrl,
      source: job.source,
      title: job.title,
      tabId: job.tabId,
      autoClose: job.autoClose,
      pdfUrl,
      filename
    });
    await persistState();
    await reportJobStatus(
      job,
      "automatic_download_started",
      "Started automatic PDF download with a default filename."
    );
  } catch (error) {
    await reportJobStatus(
      job,
      "automatic_download_failed",
      error instanceof Error ? error.message : "Automatic PDF download failed."
    );
    await enterManualDownloadMode(job);
  }
}

async function enterPublisherManualDownloadMode(job, pdfUrl) {
  job.automaticDownloadAttempted = true;
  job.manualDownloadMode = true;
  job.pdfUrl = pdfUrl;
  await persistState();
  await reportJobStatus(job, "pdf_candidate_found", "Found a direct PDF candidate.");
  await enterManualDownloadMode(
    job,
    "Science article page opened. Download the article PDF manually from this tab."
  );
}

async function handlePaperPageClassified(message, sender) {
  await withHydratedState(async () => {
    const tabId = sender && sender.tab ? sender.tab.id : undefined;
    const job = typeof tabId === "number" ? jobsByTabId.get(tabId) : undefined;
    if (!job) {
      return;
    }

    if (message.status === "awaiting_user_verification") {
      await reportJobStatus(job, "awaiting_user_verification", message.message);
      return;
    }

    await reportJobStatus(job, "page_classified", message.message);

    if (job.purpose === "webpage") {
      if (!message.html) {
        await reportJobStatus(
          job,
          "awaiting_user_verification",
          "The page loaded, but no article HTML snapshot was available."
        );
        return;
      }

      const response = await sendNativeMessage({
        type: "register_webpage_snapshot",
        jobId: job.jobId,
        articleUrl: job.articleUrl,
        source: job.source,
        html: message.html,
        ...(message.finalUrl ? { finalUrl: message.finalUrl } : {}),
        ...(message.title ? { title: message.title } : job.title ? { title: job.title } : {})
      });

      if (response && response.type === "webpage_registered") {
        await reportJobStatus(
          job,
          "webpage_snapshot_ready",
          "Registered webpage snapshot and saved parsed article artifacts."
        );
        jobsById.delete(job.jobId);
        if (typeof job.tabId === "number") {
          jobsByTabId.delete(job.tabId);
        }
        await persistState();
        await closeCompletedJobTab(job);
        return;
      }

      await reportJobStatus(
        job,
        "awaiting_user_verification",
        response && response.message
          ? response.message
          : "The webpage snapshot could not be registered by the native host."
      );
      return;
    }

    if (message.pdfUrl) {
      if (job.source === "science") {
        await enterPublisherManualDownloadMode(job, message.pdfUrl);
        return;
      }

      await startAutomaticDownload(job, message.pdfUrl);
      return;
    }

    await enterManualDownloadMode(job);
  });
}

function urlPathEndsWithPdf(value) {
  if (!value) {
    return false;
  }

  try {
    return new URL(value).pathname.toLowerCase().endsWith(".pdf");
  } catch (error) {
    return String(value).toLowerCase().split(/[?#]/, 1)[0].endsWith(".pdf");
  }
}

function basenameFromPathOrUrl(value) {
  if (!value) {
    return "";
  }

  try {
    return decodeURIComponent(new URL(value).pathname).split("/").pop() || "";
  } catch (error) {
    const withoutQuery = String(value).split(/[?#]/, 1)[0];
    const parts = withoutQuery.split(/[\\/]/);
    try {
      return decodeURIComponent(parts[parts.length - 1] || "");
    } catch (decodeError) {
      return parts[parts.length - 1] || "";
    }
  }
}

function isScienceSupplementDownload(downloadItem, job) {
  if (job.source !== "science") {
    return false;
  }

  return [downloadItem.filename, downloadItem.url, downloadItem.finalUrl, job.pdfUrl].some((value) =>
    basenameFromPathOrUrl(value).toLowerCase().endsWith("sm.pdf")
  );
}

function downloadLooksPdfLike(downloadItem, job) {
  const filename = String(downloadItem.filename || "").toLowerCase();
  const mime = String(downloadItem.mime || "").toLowerCase();
  const url = downloadItem.url || "";
  const finalUrl = downloadItem.finalUrl || "";

  return (
    filename.endsWith(".pdf") ||
    urlPathEndsWithPdf(url) ||
    urlPathEndsWithPdf(finalUrl) ||
    mime.indexOf("pdf") !== -1 ||
    (!!job.pdfUrl && (url === job.pdfUrl || finalUrl === job.pdfUrl))
  );
}

function urlHostnameMatches(value, hostname) {
  if (!value) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return parsed.hostname === hostname || parsed.hostname.endsWith(`.${hostname}`);
  } catch (error) {
    return false;
  }
}

function downloadLooksLikeScienceManualArticleDownload(downloadItem, job) {
  if (job.source !== "science" || !job.manualDownloadMode || !downloadLooksPdfLike(downloadItem, job)) {
    return false;
  }

  if (isScienceSupplementDownload(downloadItem, job)) {
    return false;
  }

  return [downloadItem.url, downloadItem.finalUrl, downloadItem.referrer].some((value) =>
    urlHostnameMatches(value, "science.org")
  );
}

function downloadBelongsToJob(downloadItem, job) {
  const referrer = downloadItem.referrer || "";
  const url = downloadItem.url || "";
  const finalUrl = downloadItem.finalUrl || "";
  const tabId = downloadItem.tabId;

  return (
    (typeof tabId === "number" && typeof job.tabId === "number" && tabId === job.tabId) ||
    (!!job.pdfUrl && (url === job.pdfUrl || finalUrl === job.pdfUrl)) ||
    (referrer === job.articleUrl && downloadLooksPdfLike(downloadItem, job)) ||
    downloadLooksLikeScienceManualArticleDownload(downloadItem, job)
  );
}

async function associateDownloadItemWithJob(downloadItem) {
  if (!downloadItem || downloadsById.has(downloadItem.id)) {
    return false;
  }

  for (const job of jobsById.values()) {
    if (isScienceSupplementDownload(downloadItem, job)) {
      continue;
    }

    if (!downloadBelongsToJob(downloadItem, job) || !downloadLooksPdfLike(downloadItem, job)) {
      continue;
    }

    const candidatePdfUrl = job.pdfUrl || downloadItem.finalUrl || downloadItem.url;
    downloadsById.set(downloadItem.id, {
      jobId: job.jobId,
      articleUrl: job.articleUrl,
      source: job.source,
      title: job.title,
      tabId: job.tabId,
      autoClose: job.autoClose,
      ...(candidatePdfUrl ? { pdfUrl: candidatePdfUrl } : {})
    });
    await persistState();
    await reportJobStatus(job, "manual_download_observed", "Observed a browser PDF download.");
    return true;
  }

  return false;
}

async function associateManualDownload(downloadItem) {
  await withHydratedState(async () => {
    await associateDownloadItemWithJob(downloadItem);
  });
}

async function findDownloadItem(downloadId) {
  const matches = await chrome.downloads.search({ id: downloadId });
  return matches && matches[0] ? matches[0] : null;
}

async function closeCompletedJobTab(trackedDownload) {
  if (trackedDownload.autoClose === false || typeof trackedDownload.tabId !== "number") {
    return;
  }

  try {
    await chrome.tabs.remove(trackedDownload.tabId);
  } catch (error) {
    console.warn("Pi Agent tab close failed", error);
  }
}

async function registerCompletedDownload(downloadId) {
  await withHydratedState(async () => {
    const item = await findDownloadItem(downloadId);
    if (!item || !item.filename) {
      return;
    }

    let trackedDownload = downloadsById.get(downloadId);
    if (!trackedDownload) {
      await associateDownloadItemWithJob(item);
      trackedDownload = downloadsById.get(downloadId);
    }
    if (!trackedDownload) {
      return;
    }

    if (isScienceSupplementDownload(item, trackedDownload)) {
      downloadsById.delete(downloadId);
      await persistState();
      const job = jobsById.get(trackedDownload.jobId);
      if (job) {
        await reportJobStatus(
          job,
          "awaiting_user_manual_download",
          "Ignored a Science supplementary material download; waiting for the article PDF."
        );
      }
      return;
    }

    const response = await sendNativeMessage({
      type: "register_download",
      jobId: trackedDownload.jobId,
      articleUrl: trackedDownload.articleUrl,
      source: trackedDownload.source,
      downloadPath: item.filename,
      ...(trackedDownload.pdfUrl ? { pdfUrl: trackedDownload.pdfUrl } : {}),
      ...(trackedDownload.title ? { title: trackedDownload.title } : {})
    });

    if (response && response.type === "registered") {
      const job = jobsById.get(trackedDownload.jobId);
      if (job) {
        await reportJobStatus(job, "downloaded", "Registered downloaded PDF.");
        jobsById.delete(job.jobId);
        if (typeof job.tabId === "number") {
          jobsByTabId.delete(job.tabId);
        }
      }
      downloadsById.delete(downloadId);
      await persistState();
      await closeCompletedJobTab(trackedDownload);
    } else if (response && response.type === "error") {
      const job = jobsById.get(trackedDownload.jobId);
      downloadsById.delete(downloadId);
      if (job) {
        await reportJobStatus(
          job,
          "automatic_download_failed",
          response.message || "Downloaded file could not be registered as a PDF."
        );
      }
      await persistState();
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM_NAME, { delayInMinutes: 0.1, periodInMinutes: 1 });
  scheduleQuickPoll();
  void pollJobs().catch((error) => logAsyncError("install poll", error));
});

chrome.runtime.onStartup.addListener(() => {
  stateReady = hydrateState();
  chrome.alarms.create(POLL_ALARM_NAME, { delayInMinutes: 0.1, periodInMinutes: 1 });
  scheduleQuickPoll();
  void pollJobs().catch((error) => logAsyncError("startup poll", error));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM_NAME) {
    scheduleQuickPoll();
    void pollJobs().catch((error) => logAsyncError("alarm poll", error));
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== "paper_page_classified") {
    return false;
  }

  void handlePaperPageClassified(message, sender).catch((error) =>
    logAsyncError("page classification handling", error)
  );
  return false;
});

chrome.downloads.onCreated.addListener((downloadItem) => {
  void associateManualDownload(downloadItem).catch((error) =>
    logAsyncError("download association", error)
  );
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && delta.state.current === "complete") {
    void registerCompletedDownload(delta.id).catch((error) =>
      logAsyncError("download registration", error)
    );
  }
});

chrome.alarms.create(POLL_ALARM_NAME, { delayInMinutes: 0.1, periodInMinutes: 1 });
scheduleQuickPoll();
void pollJobs().catch((error) => logAsyncError("initial poll", error));
