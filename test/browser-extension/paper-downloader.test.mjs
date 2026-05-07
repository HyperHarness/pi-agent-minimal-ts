import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(testDir, "../../browser-extension/paper-downloader");
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
  const updatedTabs = [];
  const sentTabMessages = [];
  const downloadedRequests = [];
  const nativeMessages = [];
  const alarmCreates = [];
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
      if (message.type === "register_download" || message.type === "register_download_bytes") {
        return {
          type: "registered",
          jobId: message.jobId,
          articleUrl: message.articleUrl,
          downloadPath: message.downloadPath ?? `knowledge-base/raw/pdfs/${message.pdfFileName ?? "paper.pdf"}`,
          recordPath: "knowledge-base/wiki/sources/paper/acquisition.json",
          fileSha256: "abc123"
        };
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
      create(name, options) {
        alarmCreates.push({ name, options });
      }
    },
    tabs: {
      async create(input) {
        if (options.beforeTabCreateResolve) {
          await options.beforeTabCreateResolve();
        }
        const tab = { id: nextTabId++, ...input };
        createdTabs.push(tab);
        return tab;
      },
      async remove(tabId) {
        removedTabs.push(tabId);
      },
      async update(tabId, input) {
        updatedTabs.push({ tabId, ...input });
        return { id: tabId, ...input };
      },
      async sendMessage(tabId, message) {
        sentTabMessages.push({ tabId, message });
        if (options.tabMessageHandler) {
          return options.tabMessageHandler(tabId, message);
        }
        return { ok: false };
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
    updatedTabs,
    sentTabMessages,
    downloadedRequests,
    nativeMessages,
    alarmCreates,
    storage,
    fetchImpl: options.fetchImpl
  };
}

async function importBackground(fakeChrome) {
  globalThis.chrome = fakeChrome.chrome;
  if (fakeChrome.fetchImpl) {
    globalThis.fetch = fakeChrome.fetchImpl;
  }
  await import(
    `${pathToFileURL(path.join(extensionDir, "background.js")).href}?case=${Date.now()}-${Math.random()}`
  );
  await flushAsyncWork();
}

function createPdfFetch(pdfBytes = "%PDF-1.4\n% test pdf\n") {
  return async (url, init) =>
    new Response(Buffer.from(pdfBytes), {
      status: 200,
      headers: { "content-type": "application/pdf" }
    });
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
      message: "Cloudflare verification is blocking this publisher page. Complete the Cloudflare check in the browser extension tab, then retry the download."
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
    pdfUrl: "https://www.nature.com/articles/s41586-019-1666-5.pdf",
    finalUrl: "https://www.nature.com/articles/s41586-019-1666-5",
    title: "Nature article",
    html: "",
    webpageAssets: []
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
  assert.match(sentMessages[0].message, /Cloudflare verification is blocking/);
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
      document: doc(
        '<a href="/doi/suppl/10.1126/science.adz8659/suppl_file/science.adz8659_sm.pdf">Supplementary Materials</a>'
      ),
      baseUrl: "https://www.science.org/doi/10.1126/science.adz8659"
    }),
    "https://www.science.org/doi/pdf/10.1126/science.adz8659?download=true"
  );

  assert.equal(
    findSciencePdfCandidate({
      document: doc("<main>No PDF link</main>"),
      baseUrl: "https://www.science.org/doi/epdf/10.1126/sciadv.adp6388"
    }),
    "https://www.science.org/doi/pdf/10.1126/sciadv.adp6388?download=true"
  );

  assert.equal(
    findApsPdfCandidate({
      document: doc("<main>No PDF link</main>"),
      baseUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601"
    }),
    "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.134.090601"
  );

  assert.equal(
    findApsPdfCandidate({
      document: doc("<main>No PDF link</main>"),
      baseUrl: "https://journals.aps.org/doi/10.1103/k3d5-v43c"
    }),
    "https://journals.aps.org/doi/pdf/10.1103/k3d5-v43c"
  );
});

test("manifest declares required MV3 extension shell fields", async () => {
  const manifest = JSON.parse(await readFile(path.join(extensionDir, "manifest.json"), "utf8"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Pi Agent Paper Downloader");
  assert.equal(manifest.version, "0.1.21");

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
    "https://media.springernature.com/*",
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
    fetchImpl: createPdfFetch(),
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

  assert.deepEqual(fakeChrome.downloadedRequests, []);
  assert.equal(messagesOf(fakeChrome, "register_download_bytes")[0].pdfUrl, "https://www.nature.com/articles/s41586-019-1666-5.pdf");
  assert.equal(messagesOf(fakeChrome, "register_download_bytes")[0].pdfFileName, "nature-s41586-019-1666-5.pdf");
  assert.deepEqual(fakeChrome.removedTabs, [100]);
  assert.deepEqual(fakeChrome.storage.piAgentPaperDownloaderState, {
    jobs: {},
    downloads: {}
  });
});

test("background fetches webpage image assets with browser credentials before native registration", async () => {
  const previousFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return new Response(Buffer.from("image-bytes"), {
      status: 200,
      headers: { "content-type": "image/png" }
    });
  };

  try {
    const job = {
      jobId: "job-webpage-assets",
      articleUrl: "https://www.nature.com/articles/s41567-022-01591-2",
      source: "nature",
      title: "Nature webpage",
      purpose: "webpage"
    };
    const fakeChrome = createFakeChrome({
      jobs: [job],
      nativeHandler(message) {
        if (message.type === "poll_jobs") {
          return { type: "jobs", jobs: [job] };
        }
        if (message.type === "register_webpage_snapshot") {
          return {
            type: "webpage_registered",
            jobId: message.jobId,
            articleUrl: message.articleUrl,
            paperKey: "nature-s41567-022-01591-2",
            markdownPath: "/tmp/document.md",
            parsePath: "/tmp/parse.json",
            qualityPath: "/tmp/quality.json",
            chunksPath: "/tmp/chunks.jsonl",
            quality: {
              status: "good",
              score: 1,
              pages: 1,
              totalTextLength: 1500,
              warnings: []
            }
          };
        }
        return { type: "status_ack", jobId: message.jobId, status: message.status };
      }
    });

    await importBackground(fakeChrome);
    fakeChrome.events.onMessage.emit(
      {
        type: "paper_page_classified",
        status: "page_classified",
        html: "<html><body><article><h1>Paper</h1><img src=\"/assets/fig1.png\"></article></body></html>",
        webpageAssets: [
          {
            url: "https://www.nature.com/assets/fig1.png",
            originalUrl: "/assets/fig1.png",
            filename: "fig1.png",
            alt: "Figure 1"
          },
          {
            url: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
            originalUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
            filename: "svg+xml;base64,PHN2Zz48L3N2Zz4=.svg",
            alt: "Inline icon"
          }
        ]
      },
      { tab: { id: 100 } }
    );
    await flushAsyncWork();

    assert.deepEqual(fetchCalls, [
      {
        url: "https://www.nature.com/assets/fig1.png",
        init: { credentials: "include" }
      }
    ]);
    const registerMessage = messagesOf(fakeChrome, "register_webpage_snapshot")[0];
    assert.equal(registerMessage.webpageAssets.length, 2);
    assert.deepEqual(registerMessage.webpageAssets[0], {
      url: "https://www.nature.com/assets/fig1.png",
      originalUrl: "/assets/fig1.png",
      filename: "fig1.png",
      mimeType: "image/png",
      dataBase64: Buffer.from("image-bytes").toString("base64"),
      alt: "Figure 1"
    });
    assert.deepEqual(registerMessage.webpageAssets[1], {
      url: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      originalUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      filename: "asset.svg",
      mimeType: "image/svg+xml",
      dataBase64: "PHN2Zz48L3N2Zz4=",
      alt: "Inline icon"
    });
    assert.equal(statusMessagesOf(fakeChrome, "webpage_snapshot_ready").length, 1);
    assert.deepEqual(fakeChrome.removedTabs, [100]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("background gates publisher PDF downloads on complete webpage snapshot quality", async () => {
  const job = {
    jobId: "job-download-and-webpage-poor",
    articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
    source: "nature",
    title: "Nature paper",
    purpose: "download_and_webpage"
  };
  const fakeChrome = createFakeChrome({
    jobs: [job],
    nativeHandler(message) {
      if (message.type === "poll_jobs") {
        return { type: "jobs", jobs: [job] };
      }
      if (message.type === "register_webpage_snapshot") {
        return {
          type: "webpage_registered",
          jobId: message.jobId,
          articleUrl: message.articleUrl,
          paperKey: "nature-s41586-019-1666-5",
          markdownPath: "/tmp/document.md",
          parsePath: "/tmp/parse.json",
          qualityPath: "/tmp/quality.json",
          chunksPath: "/tmp/chunks.jsonl",
          quality: {
            status: "needs_hybrid",
            score: 0.45,
            pages: 1,
            totalTextLength: 180,
            warnings: ["Detected access-limited article text."]
          }
        };
      }
      if (message.type === "register_download_bytes") {
        return {
          type: "registered",
          jobId: message.jobId,
          articleUrl: message.articleUrl,
          downloadPath: `knowledge-base/raw/pdfs/${message.pdfFileName}`,
          recordPath: "knowledge-base/wiki/sources/nature/acquisition.json",
          fileSha256: "abc123"
        };
      }
      return { type: "status_ack", jobId: message.jobId, status: message.status };
    }
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onMessage.emit(
    {
      type: "paper_page_classified",
      status: "page_classified",
      html: "<html><body><main><h1>Access the full article</h1></main></body></html>",
      pdfUrl: "https://www.nature.com/articles/s41586-019-1666-5.pdf"
    },
    { tab: { id: 100 } }
  );
  await flushAsyncWork();

  assert.deepEqual(fakeChrome.downloadedRequests, []);
  assert.equal(messagesOf(fakeChrome, "register_download").length, 0);
  const verificationStatuses = statusMessagesOf(fakeChrome, "awaiting_user_verification");
  assert.equal(verificationStatuses.length, 1);
  assert.match(verificationStatuses[0].message, /does not look complete enough/);
});

test("background does not register Science ePDF reader shells as webpage snapshots", async () => {
  const articleUrl = "https://www.science.org/doi/10.1126/science.aao4309";
  const epdfUrl = "https://www.science.org/doi/epdf/10.1126/science.aao4309";
  const job = {
    jobId: "job-science-epdf-webpage",
    articleUrl,
    source: "science",
    title: "Science paper",
    purpose: "download_and_webpage"
  };
  const fakeChrome = createFakeChrome({
    jobs: [job],
    nativeHandler(message) {
      if (message.type === "poll_jobs") {
        return { type: "jobs", jobs: [job] };
      }
      return { type: "status_ack", jobId: message.jobId, status: message.status };
    }
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onMessage.emit(
    {
      type: "paper_page_classified",
      status: "page_classified",
      finalUrl: epdfUrl,
      title: "A blueprint for demonstrating quantum supremacy with superconducting qubits",
      html: "<html><body>Reader environment loaded Loading publication</body></html>",
      pdfUrl: epdfUrl
    },
    { tab: { id: 100 } }
  );
  await flushAsyncWork();

  assert.equal(messagesOf(fakeChrome, "register_webpage_snapshot").length, 0);
  assert.equal(statusMessagesOf(fakeChrome, "pdf_candidate_found").length, 0);
  assert.deepEqual(fakeChrome.downloadedRequests, []);
  assert.deepEqual(fakeChrome.updatedTabs, [{ tabId: 100, url: articleUrl }]);
  const verificationStatuses = statusMessagesOf(fakeChrome, "awaiting_user_verification");
  assert.equal(verificationStatuses.length, 1);
  assert.match(verificationStatuses[0].message, /ePDF is a PDF reader page/);
});

test("background starts publisher PDF download after good webpage snapshot quality", async () => {
  const job = {
    jobId: "job-download-and-webpage-good",
    articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
    source: "nature",
    title: "Nature paper",
    purpose: "download_and_webpage"
  };
  const pdfUrl = "https://www.nature.com/articles/s41586-019-1666-5.pdf";
  const fakeChrome = createFakeChrome({
    jobs: [job],
    fetchImpl: createPdfFetch(),
    downloadItems: {
      501: {
        id: 501,
        filename: "C:\\Downloads\\paper.pdf",
        url: pdfUrl,
        mime: "application/pdf"
      }
    },
    nativeHandler(message) {
      if (message.type === "poll_jobs") {
        return { type: "jobs", jobs: [job] };
      }
      if (message.type === "register_webpage_snapshot") {
        return {
          type: "webpage_registered",
          jobId: message.jobId,
          articleUrl: message.articleUrl,
          paperKey: "nature-s41586-019-1666-5",
          markdownPath: "/tmp/document.md",
          parsePath: "/tmp/parse.json",
          qualityPath: "/tmp/quality.json",
          chunksPath: "/tmp/chunks.jsonl",
          quality: {
            status: "good",
            score: 1,
            pages: 1,
            totalTextLength: 2500,
            warnings: []
          }
        };
      }
      if (message.type === "register_download_bytes") {
        return {
          type: "registered",
          jobId: message.jobId,
          articleUrl: message.articleUrl,
          downloadPath: `knowledge-base/raw/pdfs/${message.pdfFileName}`,
          recordPath: "knowledge-base/wiki/sources/nature/acquisition.json",
          fileSha256: "abc123"
        };
      }
      return { type: "status_ack", jobId: message.jobId, status: message.status };
    }
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onMessage.emit(
    {
      type: "paper_page_classified",
      status: "page_classified",
      html: "<html><body><article><h1>Paper</h1><p>Full paper content.</p></article></body></html>",
      pdfUrl
    },
    { tab: { id: 100 } }
  );
  await flushAsyncWork();

  assert.deepEqual(fakeChrome.downloadedRequests, [
  ]);
  assert.equal(messagesOf(fakeChrome, "register_download_bytes")[0].pdfUrl, pdfUrl);
  assert.equal(statusMessagesOf(fakeChrome, "webpage_snapshot_ready").length, 1);
  assert.equal(statusMessagesOf(fakeChrome, "automatic_download_started").length, 1);
});

test("background falls back to downloads API with a default filename when background fetch fails", async () => {
  const job = {
    jobId: "job-aps-tab-download",
    articleUrl: "https://journals.aps.org/prapplied/abstract/10.1103/4ssz-6ctb",
    source: "aps",
    title: "APS open paper"
  };
  const pdfUrl = "https://journals.aps.org/prapplied/pdf/10.1103/4ssz-6ctb";
  const fakeChrome = createFakeChrome({
    jobs: [job],
    fetchImpl: async () => {
      throw new Error("fetch blocked");
    },
    tabMessageHandler: () => ({ ok: true }),
    downloadId: 601,
    downloadItems: {
      601: {
        id: 601,
        tabId: 100,
        filename: "C:\\Downloads\\aps-paper.pdf",
        url: pdfUrl,
        mime: "application/pdf"
      }
    }
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onMessage.emit(
    {
      type: "paper_page_classified",
      status: "page_classified",
      pdfUrl
    },
    { tab: { id: 100 } }
  );
  await flushAsyncWork();
  fakeChrome.events.onCreated.emit({
    id: 601,
    tabId: 100,
    filename: "C:\\Downloads\\aps-paper.pdf",
    url: pdfUrl,
    mime: "application/pdf"
  });
  await flushAsyncWork();
  fakeChrome.events.onChanged.emit({ id: 601, state: { current: "complete" } });
  await flushAsyncWork();

  assert.deepEqual(fakeChrome.sentTabMessages, []);
  assert.deepEqual(fakeChrome.downloadedRequests, [
    {
      url: pdfUrl,
      filename: "pi-agent-papers/aps-10.1103-4ssz-6ctb.pdf",
      conflictAction: "uniquify",
      saveAs: false
    }
  ]);
  assert.equal(statusMessagesOf(fakeChrome, "automatic_download_started").length, 1);
  assert.equal(messagesOf(fakeChrome, "register_download")[0].pdfUrl, pdfUrl);
  assert.deepEqual(fakeChrome.removedTabs, [100]);
});

test("background fetches Science PDF bytes without manual download", async () => {
  const job = {
    jobId: "job-science-manual",
    articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
    source: "science",
    title: "Science paper"
  };
  const pdfUrl = "https://www.science.org/doi/epdf/10.1126/science.adz8659";
  const fakeChrome = createFakeChrome({
    jobs: [job],
    fetchImpl: createPdfFetch(),
    downloadItems: {
      602: {
        id: 602,
        tabId: 100,
        filename: "C:\\Downloads\\science-paper.pdf",
        url: pdfUrl,
        mime: "application/pdf"
      }
    }
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onMessage.emit(
    {
      type: "paper_page_classified",
      status: "page_classified",
      pdfUrl
    },
    { tab: { id: 100 } }
  );
  await flushAsyncWork();

  assert.deepEqual(fakeChrome.createdTabs.map((tab) => tab.url), [job.articleUrl]);
  assert.deepEqual(fakeChrome.sentTabMessages, []);
  assert.deepEqual(fakeChrome.downloadedRequests, []);
  assert.equal(statusMessagesOf(fakeChrome, "pdf_candidate_found").length, 1);
  assert.equal(statusMessagesOf(fakeChrome, "awaiting_user_manual_download").length, 0);
  assert.equal(messagesOf(fakeChrome, "register_download_bytes")[0].pdfUrl, pdfUrl);
  assert.deepEqual(fakeChrome.removedTabs, [100]);
});

test("background associates Science manual downloads by publisher URL when tab metadata is missing", async () => {
  const job = {
    jobId: "job-science-url-manual",
    articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
    source: "science"
  };
  const pdfUrl = "https://www.science.org/doi/epdf/10.1126/science.adz8659";
  const fakeChrome = createFakeChrome({
    jobs: [job],
    fetchImpl: createPdfFetch(),
    nativeHandler(message) {
      if (message.type === "poll_jobs") {
        return { type: "jobs", jobs: [job] };
      }
      if (message.type === "register_download_bytes") {
        return {
          type: "error",
          jobId: message.jobId,
          code: "manual_login_required",
          message: "Science returned a reader page instead of PDF bytes."
        };
      }
      if (message.type === "register_download") {
        return { type: "registered", jobId: message.jobId, articleUrl: message.articleUrl, downloadPath: message.downloadPath, recordPath: "knowledge-base/wiki/sources/science/acquisition.json", fileSha256: "abc123" };
      }
      return { type: "status_ack", jobId: message.jobId, status: message.status };
    },
    downloadItems: {
      603: {
        id: 603,
        filename: "C:\\Downloads\\science.adz8659.pdf",
        url: pdfUrl,
        finalUrl: pdfUrl,
        mime: "application/pdf"
      }
    }
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onMessage.emit(
    {
      type: "paper_page_classified",
      status: "page_classified",
      pdfUrl
    },
    { tab: { id: 100 } }
  );
  await flushAsyncWork();
  fakeChrome.events.onCreated.emit({
    id: 603,
    filename: "C:\\Downloads\\science.adz8659.pdf",
    url: pdfUrl,
    finalUrl: pdfUrl,
    mime: "application/pdf"
  });
  await flushAsyncWork();
  fakeChrome.events.onChanged.emit({ id: 603, state: { current: "complete" } });
  await flushAsyncWork();

  assert.equal(statusMessagesOf(fakeChrome, "manual_download_observed").length, 1);
  assert.equal(messagesOf(fakeChrome, "register_download")[0].downloadPath, "C:\\Downloads\\science.adz8659.pdf");
  assert.equal(messagesOf(fakeChrome, "register_download")[0].pdfUrl, pdfUrl);
});

test("background records Science license-denied PDF responses as automatic download failures", async () => {
  const job = {
    jobId: "job-science-license-denied",
    articleUrl: "https://www.science.org/doi/10.1126/science.ado6285",
    source: "science"
  };
  const pdfUrl = "https://www.science.org/doi/epdf/10.1126/science.ado6285";
  const fakeChrome = createFakeChrome({
    jobs: [job],
    fetchImpl: async () =>
      new Response(
        Buffer.from(
          "<!doctype html><html><body>Your license does not permit this publication to be downloaded.</body></html>"
        ),
        {
          status: 200,
          headers: { "content-type": "text/html" }
        }
      ),
    nativeHandler(message) {
      if (message.type === "poll_jobs") {
        return { type: "jobs", jobs: [job] };
      }
      if (message.type === "register_download_bytes") {
        return {
          type: "error",
          jobId: message.jobId,
          code: "publisher_license_not_permitted",
          message:
            "Science reports that the current license does not permit this publication to be downloaded. The article webpage may still be readable, but the publisher PDF cannot be downloaded with the current account or institutional license."
        };
      }
      return { type: "status_ack", jobId: message.jobId, status: message.status };
    }
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onMessage.emit(
    {
      type: "paper_page_classified",
      status: "page_classified",
      pdfUrl
    },
    { tab: { id: 100 } }
  );
  await flushAsyncWork();

  const failed = statusMessagesOf(fakeChrome, "automatic_download_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].failureCode, "publisher_license_not_permitted");
  assert.match(failed[0].message, /license does not permit this publication to be downloaded/);
  assert.equal(statusMessagesOf(fakeChrome, "awaiting_user_manual_download").length, 0);
  assert.equal(fakeChrome.storage.piAgentPaperDownloaderState.jobs[job.jobId].manualDownloadMode, undefined);
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
    fetchImpl: createPdfFetch(),
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
  await flushAsyncWork();
  await flushAsyncWork();

  assert.deepEqual(fakeChrome.createdTabs.map((tab) => tab.url), [job.articleUrl]);
  assert.deepEqual(fakeChrome.downloadedRequests, []);
  assert.equal(statusMessagesOf(fakeChrome, "pdf_candidate_found").length, 1);
  assert.equal(statusMessagesOf(fakeChrome, "automatic_download_started").length, 1);
  assert.equal(messagesOf(fakeChrome, "register_download_bytes")[0].pdfUrl, job.articleUrl);
  assert.equal(fakeChrome.storage.piAgentPaperDownloaderState.downloads["501"], undefined);
  assert.deepEqual(fakeChrome.removedTabs, [100]);
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
        url: "https://www.science.org/doi/epdf/10.1126/science.adz8659",
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
      pdfUrl: "https://www.science.org/doi/epdf/10.1126/science.adz8659"
    },
    { tab: { id: 100 } }
  );
  await flushAsyncWork();
  fakeChrome.events.onChanged.emit({ id: 501, state: { current: "complete" } });
  await flushAsyncWork();

  assert.deepEqual(fakeChrome.removedTabs, []);
  assert.ok(fakeChrome.storage.piAgentPaperDownloaderState.jobs["job-unregistered"]);
  assert.equal(fakeChrome.storage.piAgentPaperDownloaderState.downloads["501"], undefined);
  assert.deepEqual(statusMessagesOf(fakeChrome, "automatic_download_failed"), [
    {
      type: "job_status",
      jobId: "job-unregistered",
      articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
      source: "science",
      status: "automatic_download_failed",
      failureCode: "not_pdf",
      message: "Not a PDF."
    }
  ]);
});

test("background reports publisher HTML downloads as manual login required", async () => {
  const fakeChrome = createFakeChrome({
    jobs: [
      {
        jobId: "job-aps-html",
        articleUrl: "https://journals.aps.org/prapplied/abstract/10.1103/k3d5-v43c",
        source: "aps"
      }
    ],
    downloadItems: {
      502: {
        id: 502,
        filename: "C:\\Downloads\\aps-10.1103-k3d5-v43c.htm",
        url: "https://journals.aps.org/prapplied/pdf/10.1103/k3d5-v43c",
        mime: "text/html"
      }
    },
    nativeHandler(message) {
      if (message.type === "poll_jobs") {
        return {
          type: "jobs",
          jobs: [
            {
              jobId: "job-aps-html",
              articleUrl: "https://journals.aps.org/prapplied/abstract/10.1103/k3d5-v43c",
              source: "aps"
            }
          ]
        };
      }
      if (message.type === "register_download") {
        return {
          type: "error",
          jobId: message.jobId,
          code: "manual_login_required",
          message:
            "APS returned an HTML page instead of the article PDF. Log in or complete publisher verification in the browser extension tab, then retry the download."
        };
      }
      return { type: "status_ack", jobId: message.jobId, status: message.status };
    }
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onMessage.emit(
    {
      type: "paper_page_classified",
      status: "page_classified",
      pdfUrl: "https://journals.aps.org/prapplied/pdf/10.1103/k3d5-v43c"
    },
    { tab: { id: 100 } }
  );
  await flushAsyncWork();
  fakeChrome.events.onChanged.emit({ id: 502, state: { current: "complete" } });
  await flushAsyncWork();

  assert.deepEqual(statusMessagesOf(fakeChrome, "awaiting_user_manual_download"), [
    {
      type: "job_status",
      jobId: "job-aps-html",
      articleUrl: "https://journals.aps.org/prapplied/abstract/10.1103/k3d5-v43c",
      source: "aps",
      status: "awaiting_user_manual_download",
      message:
        "APS returned an HTML page instead of the article PDF. Log in or complete publisher verification in the browser extension tab, then retry the download."
    }
  ]);
  assert.equal(statusMessagesOf(fakeChrome, "automatic_download_failed").length, 0);
  assert.ok(fakeChrome.storage.piAgentPaperDownloaderState.jobs["job-aps-html"].manualDownloadMode);
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

test("background registers manual PDF downloads from the tracked article tab", async () => {
  const job = {
    jobId: "job-manual-tab",
    articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
    source: "nature"
  };
  const fakeChrome = createFakeChrome({
    jobs: [job],
    downloadItems: {
      778: {
        id: 778,
        tabId: 100,
        filename: "C:\\Downloads\\manual-paper.pdf",
        url: "https://media.springernature.com/full/s41586-019-1666-5.pdf",
        mime: "application/pdf"
      }
    }
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onCreated.emit({
    id: 778,
    tabId: 100,
    filename: "C:\\Downloads\\manual-paper.pdf",
    url: "https://media.springernature.com/full/s41586-019-1666-5.pdf",
    mime: "application/pdf"
  });
  await flushAsyncWork();
  fakeChrome.events.onChanged.emit({ id: 778, state: { current: "complete" } });
  await flushAsyncWork();

  assert.equal(statusMessagesOf(fakeChrome, "manual_download_observed").length, 1);
  assert.equal(messagesOf(fakeChrome, "register_download").length, 1);
  assert.equal(messagesOf(fakeChrome, "register_download")[0].downloadPath, "C:\\Downloads\\manual-paper.pdf");
  assert.deepEqual(fakeChrome.removedTabs, [100]);
});

test("background ignores Science supplementary material downloads", async () => {
  const job = {
    jobId: "job-science-sm",
    articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
    source: "science"
  };
  const fakeChrome = createFakeChrome({
    jobs: [job],
    downloadItems: {
      780: {
        id: 780,
        tabId: 100,
        filename: "C:\\Downloads\\science.adz8659_sm.pdf",
        url: "https://www.science.org/doi/suppl/10.1126/science.adz8659/suppl_file/science.adz8659_sm.pdf",
        mime: "application/pdf"
      }
    }
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onCreated.emit({
    id: 780,
    tabId: 100,
    filename: "C:\\Downloads\\science.adz8659_sm.pdf",
    url: "https://www.science.org/doi/suppl/10.1126/science.adz8659/suppl_file/science.adz8659_sm.pdf",
    mime: "application/pdf"
  });
  await flushAsyncWork();
  fakeChrome.events.onChanged.emit({ id: 780, state: { current: "complete" } });
  await flushAsyncWork();

  assert.equal(messagesOf(fakeChrome, "register_download").length, 0);
  assert.equal(statusMessagesOf(fakeChrome, "manual_download_observed").length, 0);
  assert.deepEqual(fakeChrome.removedTabs, []);
});

test("background registers completed downloads even when the created event was missed", async () => {
  const job = {
    jobId: "job-complete-first",
    articleUrl: "https://journals.aps.org/prapplied/abstract/10.1103/4ssz-6ctb",
    source: "aps"
  };
  const fakeChrome = createFakeChrome({
    jobs: [job],
    downloadItems: {
      779: {
        id: 779,
        tabId: 100,
        filename: "C:\\Downloads\\aps-complete-first.pdf",
        url: "https://journals.aps.org/prapplied/pdf/10.1103/4ssz-6ctb",
        mime: "application/pdf"
      }
    }
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onChanged.emit({ id: 779, state: { current: "complete" } });
  await flushAsyncWork();

  assert.equal(statusMessagesOf(fakeChrome, "manual_download_observed").length, 1);
  assert.equal(messagesOf(fakeChrome, "register_download").length, 1);
  assert.equal(
    messagesOf(fakeChrome, "register_download")[0].downloadPath,
    "C:\\Downloads\\aps-complete-first.pdf"
  );
  assert.equal(
    messagesOf(fakeChrome, "register_download")[0].pdfUrl,
    "https://journals.aps.org/prapplied/pdf/10.1103/4ssz-6ctb"
  );
  assert.deepEqual(fakeChrome.removedTabs, [100]);
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

test("background does not open duplicate tabs when polls overlap", async () => {
  let releaseTabCreate;
  const tabCreateGate = new Promise((resolve) => {
    releaseTabCreate = resolve;
  });
  const job = {
    jobId: "job-overlap",
    articleUrl: "https://journals.aps.org/prapplied/abstract/10.1103/4ssz-6ctb",
    source: "aps"
  };
  const fakeChrome = createFakeChrome({
    jobs: [job],
    beforeTabCreateResolve: () => tabCreateGate
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onAlarm.emit({ name: "pi-agent-paper-download-poll" });
  await flushAsyncWork();

  releaseTabCreate();
  await flushAsyncWork();
  await flushAsyncWork();

  assert.equal(messagesOf(fakeChrome, "poll_jobs").length >= 2, true);
  assert.deepEqual(fakeChrome.createdTabs.map((tab) => tab.url), [job.articleUrl]);
});
