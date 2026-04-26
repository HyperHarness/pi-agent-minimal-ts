import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(testDir, "../../extension/paper-downloader");
const contentDir = path.join(extensionDir, "content");

await import(pathToFileURL(path.join(contentDir, "common.js")).href);
await import(pathToFileURL(path.join(contentDir, "nature.js")).href);
await import(pathToFileURL(path.join(contentDir, "science.js")).href);
await import(pathToFileURL(path.join(contentDir, "aps.js")).href);

const { classifyPage, findPdfCandidate } = globalThis.PiAgentPaperCommon;
const { findNaturePdfCandidate } = globalThis.PiAgentPaperNature;
const { findSciencePdfCandidate } = globalThis.PiAgentPaperScience;
const { findApsPdfCandidate } = globalThis.PiAgentPaperAps;

const flushAsyncWork = () => new Promise((resolve) => setTimeout(resolve, 0));

function readAttribute(attributes, name) {
  const match = attributes.match(new RegExp(`${name}=["']([^"']+)["']`, "i"));
  return match ? match[1] : null;
}

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      for (const listener of listeners) {
        listener(...args);
      }
    }
  };
}

function createFakeChrome(options = {}) {
  let nextTabId = 100;
  const createdTabs = [];
  const removedTabs = [];
  const downloadedRequests = [];
  const nativeMessages = [];
  const storage = structuredClone(options.storage ?? {});
  const events = {
    onInstalled: createEvent(),
    onStartup: createEvent(),
    onMessage: createEvent(),
    onAlarm: createEvent(),
    onCreated: createEvent(),
    onChanged: createEvent()
  };

  const nativeHandler =
    options.nativeHandler ??
    ((message) => {
      if (message.type === "poll_jobs") {
        return { type: "jobs", jobs: options.jobs ?? [] };
      }
      if (message.type === "register_download") {
        return { type: "registered", jobId: message.jobId };
      }
      return { type: "status_ack", jobId: message.jobId, status: message.status };
    });

  const chrome = {
    runtime: {
      onInstalled: events.onInstalled,
      onStartup: events.onStartup,
      onMessage: events.onMessage,
      async sendNativeMessage(hostName, message) {
        nativeMessages.push({ hostName, message });
        return nativeHandler(message);
      }
    },
    alarms: {
      onAlarm: events.onAlarm,
      create() {}
    },
    tabs: {
      async create(input) {
        const tab = { id: nextTabId++, ...input };
        createdTabs.push(tab);
        return tab;
      },
      async remove(tabId) {
        removedTabs.push(tabId);
      }
    },
    downloads: {
      onCreated: events.onCreated,
      onChanged: events.onChanged,
      async download(input) {
        downloadedRequests.push(input);
        return options.downloadId ?? 501;
      },
      async search(query) {
        const item = options.downloadItems?.[query.id];
        return item ? [item] : [];
      }
    },
    storage: {
      local: {
        async get(keys) {
          if (keys === null || keys === undefined) {
            return structuredClone(storage);
          }
          if (Array.isArray(keys)) {
            const result = {};
            for (const key of keys) {
              if (Object.prototype.hasOwnProperty.call(storage, key)) {
                result[key] = structuredClone(storage[key]);
              }
            }
            return result;
          }
          if (typeof keys === "string") {
            return Object.prototype.hasOwnProperty.call(storage, keys)
              ? { [keys]: structuredClone(storage[keys]) }
              : {};
          }
          const result = structuredClone(keys);
          for (const key of Object.keys(keys)) {
            if (Object.prototype.hasOwnProperty.call(storage, key)) {
              result[key] = structuredClone(storage[key]);
            }
          }
          return result;
        },
        async set(values) {
          Object.assign(storage, structuredClone(values));
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete storage[key];
          }
        }
      }
    }
  };

  return {
    chrome,
    events,
    createdTabs,
    removedTabs,
    downloadedRequests,
    nativeMessages,
    storage
  };
}

async function importBackground(fakeChrome) {
  globalThis.chrome = fakeChrome.chrome;
  await import(
    `${pathToFileURL(path.join(extensionDir, "background.js")).href}?case=${Date.now()}-${Math.random()}`
  );
  await flushAsyncWork();
}

function messagesOf(fakeChrome, type) {
  return fakeChrome.nativeMessages
    .map((entry) => entry.message)
    .filter((message) => message.type === type);
}

function statusMessagesOf(fakeChrome, status) {
  return messagesOf(fakeChrome, "job_status").filter((message) => message.status === status);
}

function stripTags(value) {
  return value.replace(/<[^>]*>/g, "").trim();
}

function doc(html) {
  const anchors = Array.from(html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)).map(
    (match) => ({
      href: readAttribute(match[1], "href"),
      textContent: stripTags(match[2])
    })
  );

  return {
    querySelectorAll(selector) {
      if (selector !== "a[href]") {
        return [];
      }

      return anchors
        .filter((anchor) => anchor.href !== null)
        .map((anchor) => ({
          textContent: anchor.textContent,
          getAttribute(name) {
            return name === "href" ? anchor.href : null;
          }
        }));
    }
  };
}

test("helper globals are installed by content helper scripts", () => {
  assert.equal(typeof classifyPage, "function");
  assert.equal(typeof findPdfCandidate, "function");
  assert.equal(typeof findNaturePdfCandidate, "function");
  assert.equal(typeof findSciencePdfCandidate, "function");
  assert.equal(typeof findApsPdfCandidate, "function");
});

test("classifyPage detects Cloudflare and login handoff pages", () => {
  assert.deepEqual(
    classifyPage({
      url: "https://journals.aps.org/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page",
      title: "Just a moment...",
      text: "Checking if the site connection is secure"
    }),
    {
      status: "awaiting_user_verification",
      message: "This page appears to require user verification before download can continue."
    }
  );

  assert.equal(
    classifyPage({
      url: "https://www.nature.com/articles/s41586-019-1666-5",
      title: "Login",
      text: "Sign in through your institution"
    }).status,
    "awaiting_user_verification"
  );

  assert.deepEqual(
    classifyPage({
      url: "https://www.nature.com/articles/s41586-019-1666-5",
      title: "Nature article",
      text: "Article text"
    }),
    { status: "page_classified" }
  );
});

test("findPdfCandidate extracts direct PDF and download links", () => {
  assert.equal(
    findPdfCandidate({
      document: doc('<a href="/paper.pdf">PDF</a>'),
      baseUrl: "https://example.com/article"
    }),
    "https://example.com/paper.pdf"
  );

  assert.equal(
    findPdfCandidate({
      document: doc('<a href="../download?type=pdf">Download article</a>'),
      baseUrl: "https://example.com/articles/current"
    }),
    "https://example.com/download?type=pdf"
  );
});

test("runner sends pdfUrl even when article body contains generic login navigation", async () => {
  const sentMessages = [];
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;

  globalThis.chrome = {
    runtime: {
      sendMessage(message) {
        sentMessages.push(message);
      }
    }
  };
  globalThis.location = {
    href: "https://www.nature.com/articles/s41586-019-1666-5",
    hostname: "www.nature.com"
  };
  globalThis.document = {
    title: "Nature article",
    body: {
      innerText: "Institutional sign in is available in the navigation."
    },
    querySelectorAll(selector) {
      assert.equal(selector, "a[href]");
      return [
        {
          textContent: "Download PDF",
          getAttribute(name) {
            return name === "href" ? "/articles/s41586-019-1666-5.pdf" : null;
          }
        }
      ];
    }
  };

  try {
    await import(
      `${pathToFileURL(path.join(contentDir, "runner.js")).href}?case=${Date.now()}-${Math.random()}`
    );
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
  }

  assert.deepEqual(sentMessages[0], {
    type: "paper_page_classified",
    status: "page_classified",
    message: undefined,
    pdfUrl: "https://www.nature.com/articles/s41586-019-1666-5.pdf"
  });
});

test("runner keeps Cloudflare challenge pages in verification handoff", async () => {
  const sentMessages = [];
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;

  globalThis.chrome = {
    runtime: {
      sendMessage(message) {
        sentMessages.push(message);
      }
    }
  };
  globalThis.location = {
    href: "https://journals.aps.org/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page",
    hostname: "journals.aps.org"
  };
  globalThis.document = {
    title: "Just a moment...",
    body: {
      innerText: "Checking if the site connection is secure"
    },
    querySelectorAll(selector) {
      assert.equal(selector, "a[href]");
      return [
        {
          textContent: "PDF",
          getAttribute(name) {
            return name === "href" ? "/prl/pdf/10.1103/PhysRevLett.134.090601" : null;
          }
        }
      ];
    }
  };

  try {
    await import(
      `${pathToFileURL(path.join(contentDir, "runner.js")).href}?case=${Date.now()}-${Math.random()}`
    );
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
  }

  assert.equal(sentMessages[0].status, "awaiting_user_verification");
  assert.equal(sentMessages[0].pdfUrl, null);
});

test("publisher helpers extract Nature, Science, and APS PDF candidates", () => {
  assert.equal(
    findNaturePdfCandidate({
      document: doc(
        '<a data-track-action="download pdf" href="/articles/s41586-019-1666-5.pdf">PDF</a>'
      ),
      baseUrl: "https://www.nature.com/articles/s41586-019-1666-5"
    }),
    "https://www.nature.com/articles/s41586-019-1666-5.pdf"
  );

  assert.equal(
    findSciencePdfCandidate({
      document: doc('<a href="/doi/pdf/10.1126/science.adz8659">PDF</a>'),
      baseUrl: "https://www.science.org/doi/10.1126/science.adz8659"
    }),
    "https://www.science.org/doi/pdf/10.1126/science.adz8659"
  );

  assert.equal(
    findApsPdfCandidate({
      document: doc("<main>No PDF link</main>"),
      baseUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601"
    }),
    "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.134.090601"
  );
});

test("manifest declares required MV3 extension shell fields", async () => {
  const manifest = JSON.parse(await readFile(path.join(extensionDir, "manifest.json"), "utf8"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Pi Agent Paper Downloader");
  assert.equal(manifest.version, "0.1.1");

  for (const permission of [
    "activeTab",
    "alarms",
    "downloads",
    "nativeMessaging",
    "storage",
    "tabs"
  ]) {
    assert.ok(manifest.permissions.includes(permission), permission);
  }

  for (const host of [
    "https://arxiv.org/*",
    "https://www.nature.com/*",
    "https://nature.com/*",
    "https://www.science.org/*",
    "https://science.org/*",
    "https://journals.aps.org/*",
    "https://aps.org/*"
  ]) {
    assert.ok(manifest.host_permissions.includes(host), host);
  }

  assert.deepEqual(manifest.background, {
    service_worker: "background.js",
    type: "module"
  });

  assert.deepEqual(manifest.content_scripts[0].js, [
    "content/common.js",
    "content/nature.js",
    "content/science.js",
    "content/aps.js",
    "content/runner.js"
  ]);
});

test("manifest content scripts do not use import or export syntax", async () => {
  for (const fileName of ["common.js", "nature.js", "science.js", "aps.js", "runner.js"]) {
    const source = await readFile(path.join(contentDir, fileName), "utf8");
    assert.doesNotMatch(source, /^\s*import\s/m, fileName);
    assert.doesNotMatch(source, /^\s*export\s/m, fileName);
  }
});

test("background automatic download registration payload includes pdfUrl and closes tab after registered", async () => {
  const job = {
    jobId: "job-auto",
    articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
    source: "nature",
    title: "Nature paper"
  };
  const fakeChrome = createFakeChrome({
    jobs: [job],
    downloadItems: {
      501: {
        id: 501,
        filename: "C:\\Downloads\\paper.pdf",
        url: "https://www.nature.com/articles/s41586-019-1666-5.pdf",
        mime: "application/pdf"
      }
    }
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onMessage.emit(
    {
      type: "paper_page_classified",
      status: "page_classified",
      pdfUrl: "https://www.nature.com/articles/s41586-019-1666-5.pdf"
    },
    { tab: { id: 100 } }
  );
  await flushAsyncWork();
  fakeChrome.events.onChanged.emit({ id: 501, state: { current: "complete" } });
  await flushAsyncWork();

  assert.equal(fakeChrome.downloadedRequests[0].url, "https://www.nature.com/articles/s41586-019-1666-5.pdf");
  assert.equal(messagesOf(fakeChrome, "register_download")[0].pdfUrl, "https://www.nature.com/articles/s41586-019-1666-5.pdf");
  assert.deepEqual(fakeChrome.removedTabs, [100]);
  assert.deepEqual(fakeChrome.storage.piAgentPaperDownloaderState, {
    jobs: {},
    downloads: {}
  });
});

test("background starts automatic download for external direct PDF jobs", async () => {
  const job = {
    jobId: "job-external-pdf",
    articleUrl: "https://example.com/downloads/paper.pdf",
    source: "external",
    title: "External PDF"
  };
  const fakeChrome = createFakeChrome({
    jobs: [job],
    downloadItems: {
      501: {
        id: 501,
        filename: "C:\\Downloads\\external-paper.pdf",
        url: "https://example.com/downloads/paper.pdf",
        mime: "application/pdf"
      }
    }
  });

  await importBackground(fakeChrome);

  assert.deepEqual(fakeChrome.createdTabs.map((tab) => tab.url), [job.articleUrl]);
  assert.deepEqual(fakeChrome.downloadedRequests, [
    {
      url: job.articleUrl,
      conflictAction: "uniquify",
      saveAs: false
    }
  ]);
  assert.equal(statusMessagesOf(fakeChrome, "pdf_candidate_found").length, 1);
  assert.equal(statusMessagesOf(fakeChrome, "automatic_download_started").length, 1);
  assert.deepEqual(fakeChrome.storage.piAgentPaperDownloaderState.downloads["501"], {
    jobId: job.jobId,
    articleUrl: job.articleUrl,
    source: "external",
    title: "External PDF",
    tabId: 100,
    autoClose: undefined,
    pdfUrl: job.articleUrl
  });
});

test("background puts external non-PDF jobs into manual mode", async () => {
  const job = {
    jobId: "job-external-page",
    articleUrl: "https://example.com/research/paper",
    source: "external"
  };
  const fakeChrome = createFakeChrome({ jobs: [job] });

  await importBackground(fakeChrome);

  assert.deepEqual(fakeChrome.createdTabs.map((tab) => tab.url), [job.articleUrl]);
  assert.deepEqual(fakeChrome.downloadedRequests, []);
  assert.equal(statusMessagesOf(fakeChrome, "awaiting_user_manual_download").length, 1);
  assert.deepEqual(fakeChrome.removedTabs, []);
  assert.ok(fakeChrome.storage.piAgentPaperDownloaderState.jobs[job.jobId]);
});

test("background keeps tab open when native host does not register completed download", async () => {
  const fakeChrome = createFakeChrome({
    jobs: [
      {
        jobId: "job-unregistered",
        articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
        source: "science"
      }
    ],
    downloadItems: {
      501: {
        id: 501,
        filename: "C:\\Downloads\\science.pdf",
        url: "https://www.science.org/doi/pdf/10.1126/science.adz8659",
        mime: "application/pdf"
      }
    },
    nativeHandler(message) {
      if (message.type === "poll_jobs") {
        return {
          type: "jobs",
          jobs: [
            {
              jobId: "job-unregistered",
              articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
              source: "science"
            }
          ]
        };
      }
      if (message.type === "register_download") {
        return { type: "error", jobId: message.jobId, code: "not_pdf", message: "Not a PDF." };
      }
      return { type: "status_ack", jobId: message.jobId, status: message.status };
    }
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onMessage.emit(
    {
      type: "paper_page_classified",
      status: "page_classified",
      pdfUrl: "https://www.science.org/doi/pdf/10.1126/science.adz8659"
    },
    { tab: { id: 100 } }
  );
  await flushAsyncWork();
  fakeChrome.events.onChanged.emit({ id: 501, state: { current: "complete" } });
  await flushAsyncWork();

  assert.deepEqual(fakeChrome.removedTabs, []);
  assert.ok(fakeChrome.storage.piAgentPaperDownloaderState.jobs["job-unregistered"]);
  assert.ok(fakeChrome.storage.piAgentPaperDownloaderState.downloads["501"]);
});

test("background manual association ignores non-PDF downloads from article referrer", async () => {
  const fakeChrome = createFakeChrome({
    jobs: [
      {
        jobId: "job-manual",
        articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
        source: "aps"
      }
    ],
    downloadItems: {
      777: {
        id: 777,
        filename: "C:\\Downloads\\citation.ris",
        url: "https://journals.aps.org/prl/export/10.1103/PhysRevLett.134.090601",
        referrer: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
        mime: "application/x-research-info-systems"
      }
    }
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onCreated.emit({
    id: 777,
    filename: "C:\\Downloads\\citation.ris",
    url: "https://journals.aps.org/prl/export/10.1103/PhysRevLett.134.090601",
    referrer: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
    mime: "application/x-research-info-systems"
  });
  await flushAsyncWork();
  fakeChrome.events.onChanged.emit({ id: 777, state: { current: "complete" } });
  await flushAsyncWork();

  assert.equal(messagesOf(fakeChrome, "register_download").length, 0);
  assert.equal(statusMessagesOf(fakeChrome, "manual_download_observed").length, 0);
  assert.deepEqual(fakeChrome.removedTabs, []);
});

test("background hydrates persisted jobs before polling and avoids duplicate tab opens", async () => {
  const persistedJob = {
    jobId: "job-persisted",
    articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
    source: "nature",
    tabId: 321,
    automaticDownloadAttempted: false
  };
  const fakeChrome = createFakeChrome({
    storage: {
      piAgentPaperDownloaderState: {
        jobs: {
          "job-persisted": persistedJob
        },
        downloads: {}
      }
    },
    jobs: [
      {
        jobId: "job-persisted",
        articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
        source: "nature"
      }
    ]
  });

  await importBackground(fakeChrome);

  assert.deepEqual(fakeChrome.createdTabs, []);
  assert.equal(messagesOf(fakeChrome, "poll_jobs").length, 1);
  assert.deepEqual(fakeChrome.storage.piAgentPaperDownloaderState.jobs["job-persisted"], persistedJob);
});
