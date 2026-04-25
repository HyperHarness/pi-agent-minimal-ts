const NATIVE_HOST_NAME = "com.pi_agent.paper_downloader";
const POLL_ALARM_NAME = "pi-agent-paper-download-poll";
const EXTENSION_INSTANCE_ID = "chrome-main";
const STORAGE_KEY = "piAgentPaperDownloaderState";

const jobsById = new Map();
const jobsByTabId = new Map();
const downloadsById = new Map();

let stateReady = hydrateState();

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
  if (!job || jobsById.has(job.jobId)) {
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

async function enterManualDownloadMode(job, message) {
  await reportJobStatus(
    job,
    "awaiting_user_manual_download",
    message || "Waiting for the user to download the PDF manually."
  );
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
    const downloadId = await chrome.downloads.download({
      url: pdfUrl,
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
      pdfUrl
    });
    await persistState();
    await reportJobStatus(job, "automatic_download_started", "Started automatic PDF download.");
  } catch (error) {
    await reportJobStatus(
      job,
      "automatic_download_failed",
      error instanceof Error ? error.message : "Automatic PDF download failed."
    );
    await enterManualDownloadMode(job);
  }
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

    if (message.pdfUrl) {
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

function downloadBelongsToJob(downloadItem, job) {
  const referrer = downloadItem.referrer || "";
  const url = downloadItem.url || "";
  const finalUrl = downloadItem.finalUrl || "";

  return (
    (!!job.pdfUrl && (url === job.pdfUrl || finalUrl === job.pdfUrl)) ||
    (referrer === job.articleUrl && downloadLooksPdfLike(downloadItem, job))
  );
}

async function associateManualDownload(downloadItem) {
  await withHydratedState(async () => {
    if (!downloadItem || downloadsById.has(downloadItem.id)) {
      return;
    }

    for (const job of jobsById.values()) {
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
      return;
    }
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
    const trackedDownload = downloadsById.get(downloadId);
    if (!trackedDownload) {
      return;
    }

    const item = await findDownloadItem(downloadId);
    if (!item || !item.filename) {
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
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM_NAME, { periodInMinutes: 1 });
  void pollJobs().catch((error) => logAsyncError("install poll", error));
});

chrome.runtime.onStartup.addListener(() => {
  stateReady = hydrateState();
  chrome.alarms.create(POLL_ALARM_NAME, { periodInMinutes: 1 });
  void pollJobs().catch((error) => logAsyncError("startup poll", error));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM_NAME) {
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

void pollJobs().catch((error) => logAsyncError("initial poll", error));
