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
await import(pathToFileURL(path.join(contentDir, "aip.js")).href);

const { classifyPage, findPdfCandidate, findSupplementalMaterialCandidates } = globalThis.PiAgentPaperCommon;
const { findNaturePdfCandidate, findNatureSupplementalMaterialCandidates } = globalThis.PiAgentPaperNature;
const { findSciencePdfCandidate } = globalThis.PiAgentPaperScience;
const { findApsPdfCandidate, findApsSupplementalMaterialCandidates } = globalThis.PiAgentPaperAps;
const { findAipPdfCandidate } = globalThis.PiAgentPaperAip;

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
          recordPath: "knowledge-base/sources/paper/acquisition.json",
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
  assert.equal(typeof findSupplementalMaterialCandidates, "function");
  assert.equal(typeof findNaturePdfCandidate, "function");
  assert.equal(typeof findNatureSupplementalMaterialCandidates, "function");
  assert.equal(typeof findSciencePdfCandidate, "function");
  assert.equal(typeof findApsPdfCandidate, "function");
  assert.equal(typeof findApsSupplementalMaterialCandidates, "function");
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

test("AIP helper derives PDF URL from citation DOI metadata on article slug pages", () => {
  const document = {
    querySelectorAll(selector) {
      if (selector === "a[href]") {
        return [];
      }
      if (selector === "meta[name='citation_doi']") {
        return [
          {
            textContent: "",
            getAttribute(name) {
              return name === "content" ? "10.1063/1.5089550" : null;
            }
          }
        ];
      }
      return [];
    }
  };

  assert.equal(
    findAipPdfCandidate({
      document,
      baseUrl:
        "https://pubs.aip.org/aip/apr/article/6/2/021318/570326/A-quantum-engineer-s-guide-to-superconducting"
    }),
    "https://pubs.aip.org/doi/pdf/10.1063/1.5089550"
  );
});

test("AIP helper prefers DOI metadata over misleading article HTML download links", () => {
  const document = {
    querySelectorAll(selector) {
      if (selector === "a[href]") {
        return [
          {
            textContent: "Download PDF",
            getAttribute(name) {
              return name === "href"
                ? "/aip/apl/article/118/6/064002/40060/Simplified-Josephson-junction-fabrication-process?download=true"
                : null;
            }
          }
        ];
      }
      if (selector === "meta[name='citation_doi']") {
        return [
          {
            textContent: "",
            getAttribute(name) {
              return name === "content" ? "10.1063/5.0037093" : null;
            }
          }
        ];
      }
      return [];
    }
  };

  assert.equal(
    findAipPdfCandidate({
      document,
      baseUrl:
        "https://pubs.aip.org/aip/apl/article/118/6/064002/40060/Simplified-Josephson-junction-fabrication-process"
    }),
    "https://pubs.aip.org/doi/pdf/10.1063/5.0037093"
  );
});

test("AIP helper uses citation PDF URL metadata before anchor scanning", () => {
  const document = {
    querySelectorAll(selector) {
      if (selector === "a[href]") {
        return [
          {
            textContent: "Download PDF",
            getAttribute(name) {
              return name === "href"
                ? "/aip/apl/article/118/6/064002/40060/Simplified-Josephson-junction-fabrication-process?download=true"
                : null;
            }
          }
        ];
      }
      if (selector === "meta[name='citation_pdf_url']") {
        return [
          {
            textContent: "",
            getAttribute(name) {
              return name === "content" ? "/doi/pdf/10.1063/5.0037093?download=true" : null;
            }
          }
        ];
      }
      return [];
    }
  };

  assert.equal(
    findAipPdfCandidate({
      document,
      baseUrl:
        "https://pubs.aip.org/aip/apl/article/118/6/064002/40060/Simplified-Josephson-junction-fabrication-process"
    }),
    "https://pubs.aip.org/doi/pdf/10.1063/5.0037093"
  );
});

test("runner uses Nature ESM supplemental links instead of the main article PDF", async () => {
  const sentMessages = [];
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const supplementUrl =
    "https://static-content.springer.com/esm/art%3A10.1038%2Fnature14270/MediaObjects/41586_2015_BFnature14270_MOESM299_ESM.pdf";

  globalThis.chrome = {
    runtime: {
      sendMessage(message) {
        sentMessages.push(message);
      }
    }
  };
  globalThis.location = {
    href: "https://www.nature.com/articles/nature14270",
    hostname: "www.nature.com"
  };
  globalThis.document = {
    title: "Nature article",
    body: {
      innerText: "Full article text."
    },
    querySelectorAll(selector) {
      assert.equal(selector, "a[href]");
      return [
        {
          textContent: "Supplementary information",
          getAttribute(name) {
            return name === "href" ? "/articles/nature14270.pdf" : null;
          }
        },
        {
          textContent: "Supplementary information",
          getAttribute(name) {
            return name === "href" ? supplementUrl : null;
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

  assert.deepEqual(sentMessages[0].supplementalMaterials, [
    {
      url: supplementUrl,
      title: "Supplementary information"
    }
  ]);
  assert.equal(sentMessages[0].pdfUrl, "https://www.nature.com/articles/nature14270.pdf");
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

test("runner waits for APS lazy MathJax formulas before sending the webpage snapshot", async () => {
  const sentMessages = [];
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousSetTimeout = globalThis.setTimeout;
  let formulasRendered = false;

  globalThis.chrome = {
    runtime: {
      sendMessage(message) {
        sentMessages.push(message);
      }
    }
  };
  globalThis.location = {
    href: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502#fulltext",
    hostname: "journals.aps.org"
  };
  globalThis.setTimeout = (callback) => {
    queueMicrotask(callback);
    return 1;
  };
  const lazyFormula = {
    scrollIntoView() {
      formulasRendered = true;
    },
    closest() {
      return this;
    }
  };
  const body = {
    innerText: `Article Text ${"superconducting qubit ".repeat(130)} References`,
    get outerHTML() {
      return formulasRendered
        ? `<body><main><h1>APS paper</h1><p>with detuning <mjx-container><mjx-assistive-mml><math><semantics><annotation encoding="application/x-tex">\\Delta</annotation></semantics></math></mjx-assistive-mml></mjx-container>.</p><a href="/prl/pdf/10.1103/PhysRevLett.111.080502">PDF</a></main></body>`
        : `<body><main><h1>APS paper</h1><p>with detuning <mjx-container><mjx-lazy data-mjx-lazy="1"></mjx-lazy></mjx-container>.</p><a href="/prl/pdf/10.1103/PhysRevLett.111.080502">PDF</a></main></body>`;
    },
    querySelectorAll(selector) {
      if (selector === "img") {
        return [];
      }
      if (selector === "mjx-lazy") {
        return formulasRendered ? [] : [lazyFormula];
      }
      return [];
    }
  };
  globalThis.document = {
    title: "APS paper",
    head: {
      innerHTML: ""
    },
    body,
    documentElement: {
      innerHTML: body.outerHTML,
      outerHTML: body.outerHTML
    },
    location: globalThis.location,
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "mjx-lazy") {
        return body.querySelectorAll(selector);
      }
      if (selector === "a[href]") {
        return [
          {
            textContent: "PDF",
            getAttribute(name) {
              return name === "href" ? "/prl/pdf/10.1103/PhysRevLett.111.080502" : null;
            }
          }
        ];
      }
      if (selector === "a, button, [role='tab'], [role='button']") {
        return [];
      }
      return body.querySelectorAll(selector);
    }
  };

  try {
    await import(
      `${pathToFileURL(path.join(contentDir, "runner.js")).href}?case=${Date.now()}-${Math.random()}`
    );
    await flushAsyncWork();
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
    globalThis.setTimeout = previousSetTimeout;
  }

  assert.equal(sentMessages.length, 1);
  assert.equal(formulasRendered, true);
  assert.match(sentMessages[0].html, /application\/x-tex/);
  assert.doesNotMatch(sentMessages[0].html, /mjx-lazy/);
});

test("runner waits for APS lazy MathJax even when the article text label is absent from visible text", async () => {
  const sentMessages = [];
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousSetTimeout = globalThis.setTimeout;
  let formulasRendered = false;

  globalThis.chrome = {
    runtime: {
      sendMessage(message) {
        sentMessages.push(message);
      }
    }
  };
  globalThis.location = {
    href: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502#fulltext",
    hostname: "journals.aps.org"
  };
  globalThis.setTimeout = (callback) => {
    queueMicrotask(callback);
    return 1;
  };
  const lazyFormula = {
    scrollIntoView() {
      formulasRendered = true;
    },
    closest() {
      return this;
    }
  };
  const body = {
    innerText: `${"superconducting qubit coherence control ".repeat(140)} References`,
    get outerHTML() {
      return formulasRendered
        ? `<body><main><p>with detuning <mjx-container><mjx-assistive-mml><math><semantics><annotation encoding="application/x-tex">\\Delta</annotation></semantics></math></mjx-assistive-mml></mjx-container>.</p><a href="/prl/pdf/10.1103/PhysRevLett.111.080502">PDF</a></main></body>`
        : `<body><main><p>with detuning <mjx-container><mjx-lazy data-mjx-lazy="1"></mjx-lazy></mjx-container>.</p><a href="/prl/pdf/10.1103/PhysRevLett.111.080502">PDF</a></main></body>`;
    },
    querySelectorAll(selector) {
      if (selector === "img") {
        return [];
      }
      if (selector === "mjx-lazy") {
        return formulasRendered ? [] : [lazyFormula];
      }
      return [];
    }
  };
  globalThis.document = {
    title: "APS paper",
    head: {
      innerHTML: ""
    },
    body,
    documentElement: {
      innerHTML: body.outerHTML,
      outerHTML: body.outerHTML
    },
    location: globalThis.location,
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "mjx-lazy") {
        return body.querySelectorAll(selector);
      }
      if (selector === "a[href]") {
        return [
          {
            textContent: "PDF",
            getAttribute(name) {
              return name === "href" ? "/prl/pdf/10.1103/PhysRevLett.111.080502" : null;
            }
          }
        ];
      }
      if (selector === "a, button, [role='tab'], [role='button']") {
        return [];
      }
      return body.querySelectorAll(selector);
    }
  };

  try {
    await import(
      `${pathToFileURL(path.join(contentDir, "runner.js")).href}?case=${Date.now()}-${Math.random()}`
    );
    await flushAsyncWork();
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
    globalThis.setTimeout = previousSetTimeout;
  }

  assert.equal(sentMessages.length, 1);
  assert.equal(formulasRendered, true);
  assert.match(sentMessages[0].html, /application\/x-tex/);
  assert.doesNotMatch(sentMessages[0].html, /mjx-lazy/);
});

test("runner scrolls APS lazy MathJax formulas one viewport at a time", async () => {
  const sentMessages = [];
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousSetTimeout = globalThis.setTimeout;
  const previousDateNow = Date.now;
  const rendered = new Set();
  let pendingRender = null;
  let returnedTopBeforeComplete = false;
  let now = 0;

  globalThis.chrome = {
    runtime: {
      sendMessage(message) {
        sentMessages.push(message);
      }
    }
  };
  globalThis.location = {
    href: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502#fulltext",
    hostname: "journals.aps.org"
  };
  Date.now = () => now;
  globalThis.setTimeout = (callback) => {
    now += 500;
    if (pendingRender) {
      rendered.add(pendingRender);
      pendingRender = null;
    }
    queueMicrotask(callback);
    return 1;
  };

  function lazyFormula(id) {
    return {
      id,
      scrollIntoView() {
        pendingRender = id;
      },
      closest() {
        return this;
      }
    };
  }

  const formulas = [lazyFormula("delta"), lazyFormula("gamma")];
  const body = {
    innerText: `Article Text ${"superconducting qubit coherence control ".repeat(140)} References`,
    get outerHTML() {
      const delta = rendered.has("delta")
        ? `<mjx-container><mjx-assistive-mml><math><semantics><annotation encoding="application/x-tex">\\Delta</annotation></semantics></math></mjx-assistive-mml></mjx-container>`
        : `<mjx-container><mjx-lazy data-mjx-lazy="delta"></mjx-lazy></mjx-container>`;
      const gamma = rendered.has("gamma")
        ? `<mjx-container><mjx-assistive-mml><math><semantics><annotation encoding="application/x-tex">\\Gamma</annotation></semantics></math></mjx-assistive-mml></mjx-container>`
        : `<mjx-container><mjx-lazy data-mjx-lazy="gamma"></mjx-lazy></mjx-container>`;
      return `<body><main><p>with detuning ${delta}, and ${gamma}.</p><a href="/prl/pdf/10.1103/PhysRevLett.111.080502">PDF</a></main></body>`;
    },
    querySelectorAll(selector) {
      if (selector === "img") {
        return [];
      }
      if (selector === "mjx-lazy") {
        return formulas.filter((formula) => !rendered.has(formula.id));
      }
      return [];
    }
  };
  globalThis.scrollTo = () => {
    if (body.querySelectorAll("mjx-lazy").length > 0) {
      returnedTopBeforeComplete = true;
    }
    pendingRender = null;
  };
  globalThis.document = {
    title: "APS paper",
    head: {
      innerHTML: ""
    },
    body,
    documentElement: {
      innerHTML: body.outerHTML,
      outerHTML: body.outerHTML
    },
    location: globalThis.location,
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "mjx-lazy") {
        return body.querySelectorAll(selector);
      }
      if (selector === "a[href]") {
        return [
          {
            textContent: "PDF",
            getAttribute(name) {
              return name === "href" ? "/prl/pdf/10.1103/PhysRevLett.111.080502" : null;
            }
          }
        ];
      }
      if (selector === "a, button, [role='tab'], [role='button']") {
        return [];
      }
      return body.querySelectorAll(selector);
    }
  };

  try {
    await import(
      `${pathToFileURL(path.join(contentDir, "runner.js")).href}?case=${Date.now()}-${Math.random()}`
    );
    for (let index = 0; index < 40 && sentMessages.length === 0; index += 1) {
      await flushAsyncWork();
    }
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
    globalThis.setTimeout = previousSetTimeout;
    Date.now = previousDateNow;
  }

  assert.equal(sentMessages.length, 1);
  assert.equal(returnedTopBeforeComplete, false);
  assert.match(sentMessages[0].html, /\\Delta/);
  assert.match(sentMessages[0].html, /\\Gamma/);
  assert.doesNotMatch(sentMessages[0].html, /mjx-lazy/);
});

test("runner uses window scrolling to trigger APS lazy MathJax rendering", async () => {
  const sentMessages = [];
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousSetTimeout = globalThis.setTimeout;
  const previousDateNow = Date.now;
  const previousScrollTo = globalThis.scrollTo;
  const rendered = new Set();
  let now = 0;

  globalThis.chrome = {
    runtime: {
      sendMessage(message) {
        sentMessages.push(message);
      }
    }
  };
  globalThis.location = {
    href: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502#fulltext",
    hostname: "journals.aps.org"
  };
  globalThis.innerHeight = 800;
  globalThis.pageYOffset = 0;
  Date.now = () => now;
  globalThis.setTimeout = (callback) => {
    now += 500;
    queueMicrotask(callback);
    return 1;
  };

  function lazyFormula(id, top) {
    return {
      id,
      scrollIntoView() {
        // APS' lazy rendering is driven by viewport scroll events in this regression.
      },
      closest() {
        return this;
      },
      getBoundingClientRect() {
        return { top: top - globalThis.pageYOffset };
      }
    };
  }

  const formulas = [lazyFormula("delta", 1800), lazyFormula("gamma", 2600)];
  globalThis.scrollTo = (_x, y) => {
    globalThis.pageYOffset = y;
    for (const formula of formulas) {
      if (Math.abs(formula.getBoundingClientRect().top - globalThis.innerHeight / 2) <= 20) {
        rendered.add(formula.id);
      }
    }
  };

  const body = {
    innerText: `Article Text ${"superconducting qubit coherence control ".repeat(140)} References`,
    get outerHTML() {
      const delta = rendered.has("delta")
        ? `<mjx-container><mjx-assistive-mml><math><semantics><annotation encoding="application/x-tex">\\Delta</annotation></semantics></math></mjx-assistive-mml></mjx-container>`
        : `<mjx-container><mjx-lazy data-mjx-lazy="delta"></mjx-lazy></mjx-container>`;
      const gamma = rendered.has("gamma")
        ? `<mjx-container><mjx-assistive-mml><math><semantics><annotation encoding="application/x-tex">\\Gamma</annotation></semantics></math></mjx-assistive-mml></mjx-container>`
        : `<mjx-container><mjx-lazy data-mjx-lazy="gamma"></mjx-lazy></mjx-container>`;
      return `<body><main><p>with detuning ${delta}, and ${gamma}.</p><a href="/prl/pdf/10.1103/PhysRevLett.111.080502">PDF</a></main></body>`;
    },
    querySelectorAll(selector) {
      if (selector === "img") {
        return [];
      }
      if (selector === "mjx-lazy") {
        return formulas.filter((formula) => !rendered.has(formula.id));
      }
      return [];
    }
  };
  globalThis.document = {
    title: "APS paper",
    head: {
      innerHTML: ""
    },
    body,
    documentElement: {
      innerHTML: body.outerHTML,
      outerHTML: body.outerHTML,
      scrollHeight: 3200
    },
    scrollingElement: {
      scrollHeight: 3200
    },
    location: globalThis.location,
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "mjx-lazy") {
        return body.querySelectorAll(selector);
      }
      if (selector === "a[href]") {
        return [
          {
            textContent: "PDF",
            getAttribute(name) {
              return name === "href" ? "/prl/pdf/10.1103/PhysRevLett.111.080502" : null;
            }
          }
        ];
      }
      if (selector === "a, button, [role='tab'], [role='button']") {
        return [];
      }
      return body.querySelectorAll(selector);
    }
  };

  try {
    await import(
      `${pathToFileURL(path.join(contentDir, "runner.js")).href}?case=${Date.now()}-${Math.random()}`
    );
    for (let index = 0; index < 40 && sentMessages.length === 0; index += 1) {
      await flushAsyncWork();
    }
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
    globalThis.setTimeout = previousSetTimeout;
    globalThis.scrollTo = previousScrollTo;
    delete globalThis.innerHeight;
    delete globalThis.pageYOffset;
    Date.now = previousDateNow;
  }

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].html, /\\Delta/);
  assert.match(sentMessages[0].html, /\\Gamma/);
  assert.doesNotMatch(sentMessages[0].html, /mjx-lazy/);
});

test("runner scrolls the APS article container when the MathJax placeholder has no useful viewport target", async () => {
  const sentMessages = [];
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousSetTimeout = globalThis.setTimeout;
  const previousDateNow = Date.now;
  const previousScrollTo = globalThis.scrollTo;
  let now = 0;
  let formulaRendered = false;

  globalThis.chrome = {
    runtime: {
      sendMessage(message) {
        sentMessages.push(message);
      }
    }
  };
  globalThis.location = {
    href: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502#fulltext",
    hostname: "journals.aps.org"
  };
  globalThis.innerHeight = 800;
  globalThis.pageYOffset = 0;
  Date.now = () => now;
  globalThis.setTimeout = (callback) => {
    now += 5000;
    queueMicrotask(callback);
    return 1;
  };
  globalThis.scrollTo = (_x, y) => {
    globalThis.pageYOffset = y;
  };

  const articleParagraph = {
    scrollIntoView() {
      formulaRendered = true;
    },
    getBoundingClientRect() {
      return { top: 1800 - globalThis.pageYOffset };
    }
  };
  const mathContainer = {
    scrollIntoView() {
      // The empty MathJax container itself does not trigger APS lazy rendering.
    },
    getBoundingClientRect() {
      return { top: 0 };
    }
  };
  const lazyFormula = {
    closest(selector) {
      if (selector === "mjx-container") {
        return mathContainer;
      }
      if (String(selector).includes(".article-fulltext-paragraph")) {
        return articleParagraph;
      }
      return null;
    },
    getBoundingClientRect() {
      return { top: 0 };
    }
  };

  const body = {
    innerText: `Article Text ${"superconducting qubit coherence control ".repeat(140)} References`,
    get outerHTML() {
      const delta = formulaRendered
        ? `<mjx-container><mjx-assistive-mml><math><semantics><annotation encoding="application/x-tex">\\Delta</annotation></semantics></math></mjx-assistive-mml></mjx-container>`
        : `<mjx-container><mjx-lazy data-mjx-lazy="delta"></mjx-lazy></mjx-container>`;
      return `<body><main><p class="article-fulltext-paragraph">with detuning ${delta}.</p><a href="/prl/pdf/10.1103/PhysRevLett.111.080502">PDF</a></main></body>`;
    },
    querySelectorAll(selector) {
      if (selector === "img") {
        return [];
      }
      if (selector === "mjx-lazy") {
        return formulaRendered ? [] : [lazyFormula];
      }
      return [];
    }
  };
  globalThis.document = {
    title: "APS paper",
    head: {
      innerHTML: ""
    },
    body,
    documentElement: {
      innerHTML: body.outerHTML,
      outerHTML: body.outerHTML,
      scrollHeight: 3200
    },
    scrollingElement: {
      scrollHeight: 3200
    },
    location: globalThis.location,
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "mjx-lazy") {
        return body.querySelectorAll(selector);
      }
      if (selector === "a[href]") {
        return [
          {
            textContent: "PDF",
            getAttribute(name) {
              return name === "href" ? "/prl/pdf/10.1103/PhysRevLett.111.080502" : null;
            }
          }
        ];
      }
      if (selector === "a, button, [role='tab'], [role='button']") {
        return [];
      }
      return body.querySelectorAll(selector);
    }
  };

  try {
    await import(
      `${pathToFileURL(path.join(contentDir, "runner.js")).href}?case=${Date.now()}-${Math.random()}`
    );
    for (let index = 0; index < 40 && sentMessages.length === 0; index += 1) {
      await flushAsyncWork();
    }
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
    globalThis.setTimeout = previousSetTimeout;
    globalThis.scrollTo = previousScrollTo;
    delete globalThis.innerHeight;
    delete globalThis.pageYOffset;
    Date.now = previousDateNow;
  }

  assert.equal(sentMessages.length, 1);
  assert.equal(formulaRendered, true);
  assert.match(sentMessages[0].html, /\\Delta/);
  assert.doesNotMatch(sentMessages[0].html, /mjx-lazy/);
});

test("runner recovers APS lazy MathJax formulas from the MathJax document before snapshotting", async () => {
  const sentMessages = [];
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousSetTimeout = globalThis.setTimeout;
  const previousDateNow = Date.now;
  const previousMathJax = globalThis.MathJax;
  let now = 0;
  let formulaRecovered = false;

  globalThis.chrome = {
    runtime: {
      sendMessage(message) {
        sentMessages.push(message);
      }
    }
  };
  globalThis.location = {
    href: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502#fulltext",
    hostname: "journals.aps.org"
  };
  Date.now = () => now;
  globalThis.setTimeout = (callback) => {
    now += 65000;
    queueMicrotask(callback);
    return 1;
  };

  const lazyFormula = {
    closest() {
      return mathContainer;
    }
  };
  const replacementParent = {
    replaceChild(replacement, node) {
      assert.equal(node, mathContainer);
      assert.equal(replacement.textContent, "\\Delta");
      formulaRecovered = true;
    }
  };
  const mathContainer = {
    parentNode: replacementParent,
    querySelector(selector) {
      return selector === "mjx-lazy" && !formulaRecovered ? lazyFormula : null;
    },
    scrollIntoView() {
      // This regression only succeeds when the MathJax document source is used.
    },
    getBoundingClientRect() {
      return { top: 0 };
    }
  };
  globalThis.MathJax = {
    startup: {
      document: {
        math: [
          {
            math: "\\Delta",
            display: false,
            typesetRoot: mathContainer
          }
        ]
      }
    }
  };

  const body = {
    innerText: `Article Text ${"superconducting qubit coherence control ".repeat(140)} References`,
    get outerHTML() {
      const delta = formulaRecovered
        ? `<span class="math-formula">\\Delta</span>`
        : `<mjx-container><mjx-lazy data-mjx-lazy="delta"></mjx-lazy></mjx-container>`;
      return `<body><main><p class="article-fulltext-paragraph">with detuning ${delta}.</p><a href="/prl/pdf/10.1103/PhysRevLett.111.080502">PDF</a></main></body>`;
    },
    querySelectorAll(selector) {
      if (selector === "img") {
        return [];
      }
      if (selector === "mjx-lazy") {
        return formulaRecovered ? [] : [lazyFormula];
      }
      return [];
    }
  };
  globalThis.document = {
    title: "APS paper",
    head: {
      innerHTML: ""
    },
    body,
    documentElement: {
      innerHTML: body.outerHTML,
      outerHTML: body.outerHTML
    },
    location: globalThis.location,
    createElement(tagName) {
      return {
        tagName,
        className: "",
        textContent: ""
      };
    },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "mjx-lazy") {
        return body.querySelectorAll(selector);
      }
      if (selector === "a[href]") {
        return [
          {
            textContent: "PDF",
            getAttribute(name) {
              return name === "href" ? "/prl/pdf/10.1103/PhysRevLett.111.080502" : null;
            }
          }
        ];
      }
      if (selector === "a, button, [role='tab'], [role='button']") {
        return [];
      }
      return body.querySelectorAll(selector);
    }
  };

  try {
    await import(
      `${pathToFileURL(path.join(contentDir, "runner.js")).href}?case=${Date.now()}-${Math.random()}`
    );
    for (let index = 0; index < 10 && sentMessages.length === 0; index += 1) {
      await flushAsyncWork();
    }
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
    globalThis.setTimeout = previousSetTimeout;
    globalThis.MathJax = previousMathJax;
    Date.now = previousDateNow;
  }

  assert.equal(sentMessages.length, 1);
  assert.equal(formulaRecovered, true);
  assert.match(sentMessages[0].html, /\\Delta/);
  assert.doesNotMatch(sentMessages[0].html, /mjx-lazy/);
});

test("runner injects the APS MathJax bridge into the page world before snapshotting", async () => {
  const sentMessages = [];
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousSetTimeout = globalThis.setTimeout;
  const previousDateNow = Date.now;
  const previousCustomEvent = globalThis.CustomEvent;
  let now = 0;
  let formulaRecovered = false;
  let injectedScriptSrc = "";
  const documentListeners = new Map();
  const documentAttributes = new Map();

  globalThis.chrome = {
    runtime: {
      getURL(pathname) {
        return `chrome-extension://pi-agent/${pathname}`;
      },
      sendMessage(message) {
        sentMessages.push(message);
      }
    }
  };
  globalThis.location = {
    href: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502#fulltext",
    hostname: "journals.aps.org"
  };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type) {
      this.type = type;
    }
  };
  Date.now = () => now;
  globalThis.setTimeout = (callback) => {
    now += 65000;
    queueMicrotask(callback);
    return 1;
  };

  const lazyFormula = {
    closest() {
      return this;
    }
  };
  const body = {
    innerText: `Article Text ${"superconducting qubit coherence control ".repeat(140)} References`,
    get outerHTML() {
      const delta = formulaRecovered
        ? `<span class="math-formula">\\Delta</span>`
        : `<mjx-container><mjx-lazy data-mjx-lazy="delta"></mjx-lazy></mjx-container>`;
      return `<body><main><p class="article-fulltext-paragraph">with detuning ${delta}.</p><a href="/prl/pdf/10.1103/PhysRevLett.111.080502">PDF</a></main></body>`;
    },
    querySelectorAll(selector) {
      if (selector === "img") {
        return [];
      }
      if (selector === "mjx-lazy") {
        return formulaRecovered ? [] : [lazyFormula];
      }
      return [];
    }
  };
  const documentElement = {
    get innerHTML() {
      return body.outerHTML;
    },
    get outerHTML() {
      return body.outerHTML;
    },
    getAttribute(name) {
      return documentAttributes.get(name) ?? null;
    },
    setAttribute(name, value) {
      documentAttributes.set(name, value);
    }
  };
  globalThis.document = {
    title: "APS paper",
    head: {
      appendChild(script) {
        injectedScriptSrc = script.src;
        documentListeners.set("pi-agent-paper-recover-mathjax", () => {
          formulaRecovered = true;
        });
        if (typeof script.onload === "function") {
          script.onload();
        }
      }
    },
    body,
    documentElement,
    location: globalThis.location,
    createElement(tagName) {
      return {
        tagName,
        async: true,
        parentNode: null,
        src: "",
        onload: null
      };
    },
    dispatchEvent(event) {
      const listener = documentListeners.get(event.type);
      if (listener) {
        listener(event);
      }
    },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "mjx-lazy") {
        return body.querySelectorAll(selector);
      }
      if (selector === "a[href]") {
        return [
          {
            textContent: "PDF",
            getAttribute(name) {
              return name === "href" ? "/prl/pdf/10.1103/PhysRevLett.111.080502" : null;
            }
          }
        ];
      }
      if (selector === "a, button, [role='tab'], [role='button']") {
        return [];
      }
      return body.querySelectorAll(selector);
    }
  };

  try {
    await import(
      `${pathToFileURL(path.join(contentDir, "runner.js")).href}?case=${Date.now()}-${Math.random()}`
    );
    for (let index = 0; index < 10 && sentMessages.length === 0; index += 1) {
      await flushAsyncWork();
    }
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
    globalThis.setTimeout = previousSetTimeout;
    globalThis.CustomEvent = previousCustomEvent;
    Date.now = previousDateNow;
  }

  assert.equal(sentMessages.length, 1);
  assert.equal(injectedScriptSrc, "chrome-extension://pi-agent/content/mathjax-bridge.js");
  assert.equal(documentAttributes.get("data-pi-agent-mathjax-bridge-injected"), "true");
  assert.equal(formulaRecovered, true);
  assert.match(sentMessages[0].html, /\\Delta/);
  assert.doesNotMatch(sentMessages[0].html, /mjx-lazy/);
});

test("runner reports APS MathML presence diagnostics with the snapshot", async () => {
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
    href: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502#fulltext",
    hostname: "journals.aps.org"
  };

  const mathElement = {};
  const assistiveMath = {};
  const mathContainer = {};
  const body = {
    innerText: `Article Text ${"superconducting qubit coherence control ".repeat(140)} References`,
    outerHTML: `<body data-pi-agent-mathjax-items="7"><main><p class="article-fulltext-paragraph">with detuning <mjx-container><mjx-assistive-mml><math><mi>\\Delta</mi></math></mjx-assistive-mml></mjx-container>.</p><a href="/prl/pdf/10.1103/PhysRevLett.111.080502">PDF</a></main></body>`,
    getAttribute(name) {
      return name === "data-pi-agent-mathjax-items" ? "7" : null;
    },
    querySelectorAll(selector) {
      if (selector === "img") {
        return [];
      }
      if (selector === "math") {
        return [mathElement];
      }
      if (selector === "mjx-assistive-mml") {
        return [assistiveMath];
      }
      if (selector === "mjx-container") {
        return [mathContainer];
      }
      if (selector === "mjx-lazy") {
        return [];
      }
      return [];
    }
  };
  globalThis.document = {
    title: "APS paper",
    head: {
      innerHTML: ""
    },
    body,
    documentElement: {
      innerHTML: body.outerHTML,
      outerHTML: body.outerHTML,
      getAttribute() {
        return null;
      }
    },
    location: globalThis.location,
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "a[href]") {
        return [
          {
            textContent: "PDF",
            getAttribute(name) {
              return name === "href" ? "/prl/pdf/10.1103/PhysRevLett.111.080502" : null;
            }
          }
        ];
      }
      if (selector === "a, button, [role='tab'], [role='button']") {
        return [];
      }
      return body.querySelectorAll(selector);
    }
  };

  try {
    await import(
      `${pathToFileURL(path.join(contentDir, "runner.js")).href}?case=${Date.now()}-${Math.random()}`
    );
    await flushAsyncWork();
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
  }

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].message, /math diagnostics:/);
  assert.match(sentMessages[0].message, /dom math=1/);
  assert.match(sentMessages[0].message, /dom assistive=1/);
  assert.match(sentMessages[0].message, /snapshot math=1/);
  assert.match(sentMessages[0].message, /bridge items=7/);
});

test("APS MathJax bridge falls back to document-order lazy formula recovery", async () => {
  const previousWindow = globalThis.window;
  const replaced = [];
  const documentAttributes = new Map();

  function lazyContainer(id) {
    return {
      id,
      parentNode: {
        replaceChild(replacement, node) {
          assert.equal(node.id, id);
          replaced.push({ id, className: replacement.className, textContent: replacement.textContent });
        }
      },
      querySelector(selector) {
        return selector === "mjx-lazy" ? { id: `${id}-lazy` } : null;
      }
    };
  }

  const deltaContainer = lazyContainer("delta-container");
  const gammaContainer = lazyContainer("gamma-container");
  const renderedContainer = {
    querySelector() {
      return null;
    },
    parentNode: {
      replaceChild() {
        throw new Error("rendered formulas must not be replaced");
      }
    }
  };
  const listeners = new Map();
  const fakeWindow = {
    __piAgentPaperMathJaxBridgeInstalled: false,
    MathJax: {
      startup: {
        document: {
          math: [
            { math: "already rendered", display: false, typesetRoot: renderedContainer },
            { math: "\\Delta", display: false },
            { math: "\\Gamma = 1", display: true }
          ]
        }
      }
    },
    setInterval() {
      return 1;
    },
    clearInterval() {},
    document: {
      documentElement: {
        setAttribute(name, value) {
          documentAttributes.set(name, value);
        }
      },
      createElement(tagName) {
        return {
          tagName,
          className: "",
          textContent: ""
        };
      },
      querySelectorAll(selector) {
        return selector === "mjx-container" ? [deltaContainer, gammaContainer] : [];
      },
      addEventListener(type, listener) {
        listeners.set(type, listener);
      }
    }
  };

  try {
    globalThis.window = fakeWindow;
    await import(
      `${pathToFileURL(path.join(contentDir, "mathjax-bridge.js")).href}?case=${Date.now()}-${Math.random()}`
    );
  } finally {
    globalThis.window = previousWindow;
  }

  assert.deepEqual(replaced, [
    { id: "delta-container", className: "math-formula", textContent: "\\Delta" },
    { id: "gamma-container", className: "math-formula display", textContent: "\\Gamma = 1" }
  ]);
  assert.equal(documentAttributes.get("data-pi-agent-mathjax-recovered"), "2");
  assert.equal(documentAttributes.get("data-pi-agent-mathjax-items"), "3");
  assert.equal(documentAttributes.get("data-pi-agent-mathjax-pending"), "2");
  assert.equal(documentAttributes.get("data-pi-agent-mathjax-lazy-containers"), "2");
  assert.equal(documentAttributes.get("data-pi-agent-mathjax-bridge"), "ready");
  assert.equal(typeof listeners.get("pi-agent-paper-recover-mathjax"), "function");
});

test("APS MathJax bridge keeps polling until MathJax sources become available", async () => {
  const previousWindow = globalThis.window;
  const replaced = [];
  const intervalCallbacks = [];
  let now = 0;
  let mathItems = [];

  function lazyContainer(id) {
    return {
      id,
      parentNode: {
        replaceChild(replacement, node) {
          assert.equal(node.id, id);
          replaced.push({ id, className: replacement.className, textContent: replacement.textContent });
        }
      },
      querySelector(selector) {
        return selector === "mjx-lazy" && replaced.every((entry) => entry.id !== id)
          ? { id: `${id}-lazy` }
          : null;
      }
    };
  }

  const deltaContainer = lazyContainer("delta-container");
  const fakeWindow = {
    __piAgentPaperMathJaxBridgeInstalled: false,
    Date: globalThis.Date,
    MathJax: {
      startup: {
        document: {
          get math() {
            return mathItems;
          }
        }
      }
    },
    setInterval(callback) {
      intervalCallbacks.push(callback);
      return 1;
    },
    clearInterval() {},
    document: {
      documentElement: {
        setAttribute() {}
      },
      body: {
        setAttribute() {}
      },
      createElement(tagName) {
        return {
          tagName,
          className: "",
          textContent: ""
        };
      },
      querySelectorAll(selector) {
        return selector === "mjx-container" ? [deltaContainer] : [];
      },
      addEventListener() {}
    }
  };
  const previousDateNow = Date.now;
  Date.now = () => now;

  try {
    globalThis.window = fakeWindow;
    await import(
      `${pathToFileURL(path.join(contentDir, "mathjax-bridge.js")).href}?case=${Date.now()}-${Math.random()}`
    );
    assert.deepEqual(replaced, []);
    mathItems = [{ math: "\\Delta", display: false }];
    now += 500;
    intervalCallbacks[0]();
  } finally {
    globalThis.window = previousWindow;
    Date.now = previousDateNow;
  }

  assert.deepEqual(replaced, [
    { id: "delta-container", className: "math-formula", textContent: "\\Delta" }
  ]);
});

test("runner sweeps the APS page when lazy MathJax node coordinates are not useful", async () => {
  const sentMessages = [];
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousSetTimeout = globalThis.setTimeout;
  const previousDateNow = Date.now;
  const previousScrollTo = globalThis.scrollTo;
  const rendered = new Set();
  let now = 0;

  globalThis.chrome = {
    runtime: {
      sendMessage(message) {
        sentMessages.push(message);
      }
    }
  };
  globalThis.location = {
    href: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502#fulltext",
    hostname: "journals.aps.org"
  };
  globalThis.innerHeight = 800;
  globalThis.pageYOffset = 0;
  Date.now = () => now;
  globalThis.setTimeout = (callback) => {
    now += 500;
    queueMicrotask(callback);
    return 1;
  };

  function lazyFormula(id) {
    return {
      id,
      scrollIntoView() {
        // The browser reports an unusable rectangle for these placeholders.
      },
      closest() {
        return this;
      },
      getBoundingClientRect() {
        return { top: 0 };
      }
    };
  }

  const formulas = [lazyFormula("delta"), lazyFormula("gamma")];
  globalThis.scrollTo = (_x, y) => {
    globalThis.pageYOffset = y;
    if (y >= 1200) {
      rendered.add("delta");
    }
    if (y >= 1800) {
      rendered.add("gamma");
    }
  };

  const body = {
    innerText: `Article Text ${"superconducting qubit coherence control ".repeat(140)} References`,
    get outerHTML() {
      const delta = rendered.has("delta")
        ? `<mjx-container><mjx-assistive-mml><math><semantics><annotation encoding="application/x-tex">\\Delta</annotation></semantics></math></mjx-assistive-mml></mjx-container>`
        : `<mjx-container><mjx-lazy data-mjx-lazy="delta"></mjx-lazy></mjx-container>`;
      const gamma = rendered.has("gamma")
        ? `<mjx-container><mjx-assistive-mml><math><semantics><annotation encoding="application/x-tex">\\Gamma</annotation></semantics></math></mjx-assistive-mml></mjx-container>`
        : `<mjx-container><mjx-lazy data-mjx-lazy="gamma"></mjx-lazy></mjx-container>`;
      return `<body><main><p>with detuning ${delta}, and ${gamma}.</p><a href="/prl/pdf/10.1103/PhysRevLett.111.080502">PDF</a></main></body>`;
    },
    querySelectorAll(selector) {
      if (selector === "img") {
        return [];
      }
      if (selector === "mjx-lazy") {
        return formulas.filter((formula) => !rendered.has(formula.id));
      }
      return [];
    }
  };
  globalThis.document = {
    title: "APS paper",
    head: {
      innerHTML: ""
    },
    body,
    documentElement: {
      innerHTML: body.outerHTML,
      outerHTML: body.outerHTML,
      scrollHeight: 3200
    },
    scrollingElement: {
      scrollHeight: 3200
    },
    location: globalThis.location,
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "mjx-lazy") {
        return body.querySelectorAll(selector);
      }
      if (selector === "a[href]") {
        return [
          {
            textContent: "PDF",
            getAttribute(name) {
              return name === "href" ? "/prl/pdf/10.1103/PhysRevLett.111.080502" : null;
            }
          }
        ];
      }
      if (selector === "a, button, [role='tab'], [role='button']") {
        return [];
      }
      return body.querySelectorAll(selector);
    }
  };

  try {
    await import(
      `${pathToFileURL(path.join(contentDir, "runner.js")).href}?case=${Date.now()}-${Math.random()}`
    );
    for (let index = 0; index < 40 && sentMessages.length === 0; index += 1) {
      await flushAsyncWork();
    }
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
    globalThis.setTimeout = previousSetTimeout;
    globalThis.scrollTo = previousScrollTo;
    delete globalThis.innerHeight;
    delete globalThis.pageYOffset;
    Date.now = previousDateNow;
  }

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].html, /\\Delta/);
  assert.match(sentMessages[0].html, /\\Gamma/);
  assert.doesNotMatch(sentMessages[0].html, /mjx-lazy/);
});

test("runner gives APS MathJax a fresh wait window after article text loads", async () => {
  const sentMessages = [];
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousSetTimeout = globalThis.setTimeout;
  const previousDateNow = Date.now;
  let articleLoaded = false;
  let formulasRendered = false;
  let now = 0;
  let timeoutCount = 0;

  globalThis.chrome = {
    runtime: {
      sendMessage(message) {
        sentMessages.push(message);
      }
    }
  };
  globalThis.location = {
    href: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    hostname: "journals.aps.org"
  };
  Date.now = () => now;
  globalThis.setTimeout = (callback) => {
    timeoutCount += 1;
    now += timeoutCount === 1 ? 15100 : 500;
    queueMicrotask(callback);
    return 1;
  };
  const lazyFormula = {
    scrollIntoView() {
      formulasRendered = true;
    },
    closest() {
      return this;
    }
  };
  const body = {
    get innerText() {
      return articleLoaded
        ? `Article Text ${"superconducting qubit coherence ".repeat(130)} References`
        : "Article Text Abstract References";
    },
    get outerHTML() {
      return formulasRendered
        ? `<body><main><p>with detuning <mjx-container><mjx-assistive-mml><math><semantics><annotation encoding="application/x-tex">\\Delta</annotation></semantics></math></mjx-assistive-mml></mjx-container>.</p><a href="/prl/pdf/10.1103/PhysRevLett.111.080502">PDF</a></main></body>`
        : `<body><main><p>with detuning <mjx-container><mjx-lazy data-mjx-lazy="1"></mjx-lazy></mjx-container>.</p><a href="/prl/pdf/10.1103/PhysRevLett.111.080502">PDF</a></main></body>`;
    },
    querySelectorAll(selector) {
      if (selector === "img") {
        return [];
      }
      if (selector === "mjx-lazy") {
        return formulasRendered ? [] : [lazyFormula];
      }
      return [];
    }
  };
  globalThis.document = {
    title: "APS paper",
    head: {
      innerHTML: ""
    },
    body,
    documentElement: {
      innerHTML: body.outerHTML,
      outerHTML: body.outerHTML
    },
    location: globalThis.location,
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "mjx-lazy") {
        return body.querySelectorAll(selector);
      }
      if (selector === "a[href]") {
        return [
          {
            textContent: "PDF",
            getAttribute(name) {
              return name === "href" ? "/prl/pdf/10.1103/PhysRevLett.111.080502" : null;
            }
          }
        ];
      }
      if (selector === "a, button, [role='tab'], [role='button']") {
        return [
          {
            textContent: "Article Text",
            getAttribute() {
              return null;
            },
            click() {
              articleLoaded = true;
            }
          }
        ];
      }
      return body.querySelectorAll(selector);
    }
  };

  try {
    await import(
      `${pathToFileURL(path.join(contentDir, "runner.js")).href}?case=${Date.now()}-${Math.random()}`
    );
    await flushAsyncWork();
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
    globalThis.setTimeout = previousSetTimeout;
    Date.now = previousDateNow;
  }

  assert.equal(sentMessages.length, 1);
  assert.equal(articleLoaded, true);
  assert.equal(formulasRendered, true);
  assert.match(sentMessages[0].html, /application\/x-tex/);
  assert.doesNotMatch(sentMessages[0].html, /mjx-lazy/);
});

test("runner prioritizes APS article figure images over page chrome images", async () => {
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
    href: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502#fulltext",
    hostname: "journals.aps.org"
  };

  const image = (src, alt, className = "") => ({
    currentSrc: src,
    getAttribute(name) {
      if (name === "src") {
        return src;
      }
      if (name === "alt") {
        return alt;
      }
      if (name === "class") {
        return className;
      }
      return null;
    }
  });
  const chromeImages = Array.from({ length: 45 }, (_value, index) =>
    image(`/assets/badge-${index}.png`, `Badge ${index}`, "site-badge")
  );
  const figureImage = image(
    "/prl/article/10.1103/PhysRevLett.111.080502/figures/1/medium",
    "Fig. 1. Xmon qubit",
    "lazy-fulltext"
  );
  const body = {
    innerText: `Article Text ${"superconducting qubit ".repeat(130)} References`,
    outerHTML: `<body><main><figure><img src="/prl/article/10.1103/PhysRevLett.111.080502/figures/1/medium" class="lazy-fulltext" alt="Fig. 1. Xmon qubit"></figure><a href="/prl/pdf/10.1103/PhysRevLett.111.080502">PDF</a></main></body>`,
    querySelectorAll(selector) {
      if (selector === "img") {
        return [...chromeImages, figureImage];
      }
      if (selector === "mjx-lazy") {
        return [];
      }
      return [];
    }
  };
  globalThis.document = {
    title: "APS paper",
    head: {
      innerHTML: ""
    },
    body,
    documentElement: {
      innerHTML: body.outerHTML,
      outerHTML: body.outerHTML
    },
    location: globalThis.location,
    baseURI: globalThis.location.href,
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "a[href]") {
        return [
          {
            textContent: "PDF",
            getAttribute(name) {
              return name === "href" ? "/prl/pdf/10.1103/PhysRevLett.111.080502" : null;
            }
          }
        ];
      }
      if (selector === "a, button, [role='tab'], [role='button']") {
        return [];
      }
      return body.querySelectorAll(selector);
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

  assert.equal(sentMessages.length, 1);
  assert.ok(sentMessages[0].webpageAssets.some((asset) =>
    asset.url === "https://journals.aps.org/prl/article/10.1103/PhysRevLett.111.080502/figures/1/medium"
  ));
});

test("publisher helpers extract Nature, Science, APS, and AIP PDF candidates", () => {
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

  assert.equal(
    findAipPdfCandidate({
      document: doc("<main>No PDF link</main>"),
      baseUrl: "https://pubs.aip.org/doi/10.1063/1.5089550"
    }),
    "https://pubs.aip.org/doi/pdf/10.1063/1.5089550"
  );
});

test("publisher helpers extract supplemental material candidates", () => {
  assert.deepEqual(
    findSupplementalMaterialCandidates({
      document: doc('<a href="/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf">Supplemental Material</a>'),
      baseUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502"
    }),
    [
      {
        url: "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf",
        title: "Supplemental Material"
      }
    ]
  );

  assert.deepEqual(
    findApsSupplementalMaterialCandidates({
      document: doc("<main>No direct links</main>"),
      baseUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502"
    }),
    [
      {
        url: "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502",
        title: "Supplemental Material"
      }
    ]
  );
});

test("Nature helper extracts Springer ESM supplemental PDFs and ignores the main article PDF", () => {
  assert.deepEqual(
    findNatureSupplementalMaterialCandidates({
      document: doc(`
        <a href="/articles/nature14270.pdf">Supplementary information</a>
        <a href="https://static-content.springer.com/esm/art%3A10.1038%2Fnature14270/MediaObjects/41586_2015_BFnature14270_MOESM299_ESM.pdf">Supplementary information</a>
      `),
      baseUrl: "https://www.nature.com/articles/nature14270"
    }),
    [
      {
        url: "https://static-content.springer.com/esm/art%3A10.1038%2Fnature14270/MediaObjects/41586_2015_BFnature14270_MOESM299_ESM.pdf",
        title: "Supplementary information"
      }
    ]
  );
});

test("manifest declares required MV3 extension shell fields", async () => {
  const manifest = JSON.parse(await readFile(path.join(extensionDir, "manifest.json"), "utf8"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Pi Agent Paper Downloader");
  assert.equal(manifest.version, "0.1.28");

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
    "https://static-content.springer.com/*",
    "https://www.science.org/*",
    "https://science.org/*",
    "https://journals.aps.org/*",
    "https://aps.org/*",
    "https://pubs.aip.org/*"
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
    "content/aip.js",
    "content/runner.js"
  ]);
  assert.deepEqual(manifest.web_accessible_resources, [
    {
      resources: ["content/mathjax-bridge.js"],
      matches: ["https://journals.aps.org/*", "https://aps.org/*"]
    }
  ]);
});

test("manifest content scripts do not use import or export syntax", async () => {
  for (const fileName of ["common.js", "nature.js", "science.js", "aps.js", "aip.js", "runner.js", "mathjax-bridge.js"]) {
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
      purpose: "webpage",
      recordPath: "knowledge-base/sources/nature-s41567-022-01591-2/acquisition.json"
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
          },
          {
            url: "https://journals.aps.org/prl/article/10.1103/PhysRevLett.111.080502/figures/1/medium",
            originalUrl: "/prl/article/10.1103/PhysRevLett.111.080502/figures/1/medium",
            filename: "medium",
            alt: "Fig. 1"
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
      },
      {
        url: "https://journals.aps.org/prl/article/10.1103/PhysRevLett.111.080502/figures/1/medium",
        init: { credentials: "include" }
      }
    ]);
    const registerMessage = messagesOf(fakeChrome, "register_webpage_snapshot")[0];
    assert.equal(registerMessage.recordPath, "knowledge-base/sources/nature-s41567-022-01591-2/acquisition.json");
    assert.equal(registerMessage.webpageAssets.length, 3);
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
    assert.deepEqual(registerMessage.webpageAssets[2], {
      url: "https://journals.aps.org/prl/article/10.1103/PhysRevLett.111.080502/figures/1/medium",
      originalUrl: "/prl/article/10.1103/PhysRevLett.111.080502/figures/1/medium",
      filename: "medium.png",
      mimeType: "image/png",
      dataBase64: Buffer.from("image-bytes").toString("base64"),
      alt: "Fig. 1"
    });
    assert.equal(statusMessagesOf(fakeChrome, "webpage_snapshot_ready").length, 1);
    assert.deepEqual(fakeChrome.removedTabs, [100]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("background registers supplemental materials without blocking the main PDF download", async () => {
  const fetchCalls = [];
  const job = {
    jobId: "job-aps-supplement",
    articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    source: "aps",
    title: "APS paper"
  };
  const fakeChrome = createFakeChrome({
    jobs: [job],
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return new Response(Buffer.from("%PDF-1.7\nsupplement pdf\n"), {
        status: 200,
        headers: { "content-type": "application/pdf" }
      });
    }
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onMessage.emit(
    {
      type: "paper_page_classified",
      status: "page_classified",
      pdfUrl: "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.111.080502",
      supplementalMaterials: [
        {
          url: "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf",
          title: "Supplemental Material"
        }
      ]
    },
    { tab: { id: 100 } }
  );
  await flushAsyncWork();

  assert.deepEqual(fetchCalls[0], {
    url: "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf",
    init: { credentials: "include" }
  });
  const supplemental = messagesOf(fakeChrome, "register_supplemental_material")[0];
  assert.equal(
    supplemental.materialUrl,
    "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/SM.pdf"
  );
  assert.equal(supplemental.filename, "SM.pdf");
  assert.equal(messagesOf(fakeChrome, "register_download_bytes").length, 1);
});

test("background ignores non-PDF supplemental responses without blocking the main PDF download", async () => {
  const job = {
    jobId: "job-aps-supplement-html",
    articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    source: "aps",
    title: "APS paper"
  };
  const fakeChrome = createFakeChrome({
    jobs: [job],
    fetchImpl: async (url) => {
      if (String(url).includes("/supplemental/")) {
        return new Response("<html>Supplemental listing</html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      return new Response(Buffer.from("%PDF-1.7\nmain pdf\n"), {
        status: 200,
        headers: { "content-type": "application/pdf" }
      });
    }
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onMessage.emit(
    {
      type: "paper_page_classified",
      status: "page_classified",
      pdfUrl: "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.111.080502",
      supplementalMaterials: [
        {
          url: "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502",
          title: "Supplemental Material"
        }
      ]
    },
    { tab: { id: 100 } }
  );
  await flushAsyncWork();

  assert.equal(messagesOf(fakeChrome, "register_supplemental_material").length, 0);
  assert.equal(messagesOf(fakeChrome, "register_download_bytes").length, 1);
  assert.equal(
    messagesOf(fakeChrome, "job_status").some((message) => message.status === "supplemental_material_failed"),
    true
  );
});

test("background follows APS supplemental listing pages to downloadable PDFs", async () => {
  const fetchCalls = [];
  const job = {
    jobId: "job-aps-supplement-listing",
    articleUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    source: "aps",
    title: "APS paper"
  };
  const listingUrl = "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502";
  const pdfUrl =
    "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/Barends2013supp.pdf";
  const fakeChrome = createFakeChrome({
    jobs: [job],
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      if (String(url) === listingUrl) {
        return new Response(
          `<html><body><a href="/prl/supplemental/10.1103/PhysRevLett.111.080502/Barends2013supp.pdf">Barends2013supp.pdf</a></body></html>`,
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" }
          }
        );
      }
      if (String(url) === pdfUrl) {
        return new Response(Buffer.from("%PDF-1.7\nsupplement pdf\n"), {
          status: 200,
          headers: { "content-type": "application/pdf" }
        });
      }
      if (String(url) === "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.111.080502") {
        return new Response(Buffer.from("%PDF-1.7\nmain pdf\n"), {
          status: 200,
          headers: { "content-type": "application/pdf" }
        });
      }
      return new Response("not found", { status: 404 });
    }
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onMessage.emit(
    {
      type: "paper_page_classified",
      status: "page_classified",
      pdfUrl: "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.111.080502",
      supplementalMaterials: [
        {
          url: listingUrl,
          title: "Supplemental Material"
        }
      ]
    },
    { tab: { id: 100 } }
  );
  await flushAsyncWork();

  assert.deepEqual(
    fetchCalls.map((call) => call.url).slice(0, 2),
    [listingUrl, pdfUrl]
  );
  const supplemental = messagesOf(fakeChrome, "register_supplemental_material")[0];
  assert.equal(supplemental.materialUrl, pdfUrl);
  assert.equal(supplemental.filename, "Barends2013supp.pdf");
  assert.equal(messagesOf(fakeChrome, "register_download_bytes").length, 1);
  assert.equal(statusMessagesOf(fakeChrome, "supplemental_material_failed").length, 0);
});

test("background supplemental-only jobs do not re-download the main PDF", async () => {
  const fetchCalls = [];
  const articleUrl = "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502";
  const supplementalUrl =
    "https://journals.aps.org/prl/supplemental/10.1103/PhysRevLett.111.080502/Barends2013supp.pdf";
  const job = {
    jobId: "job-aps-supplement-only",
    articleUrl,
    source: "aps",
    purpose: "supplemental",
    autoClose: true
  };
  const fakeChrome = createFakeChrome({
    jobs: [job],
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      if (String(url) === supplementalUrl) {
        return new Response(Buffer.from("%PDF-1.7\nsupplement pdf\n"), {
          status: 200,
          headers: { "content-type": "application/pdf" }
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }
  });

  await importBackground(fakeChrome);
  fakeChrome.events.onMessage.emit(
    {
      type: "paper_page_classified",
      status: "page_classified",
      pdfUrl: "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.111.080502",
      supplementalMaterials: [
        {
          url: supplementalUrl,
          title: "Supplemental Material"
        }
      ]
    },
    { tab: { id: 100 } }
  );
  await flushAsyncWork();

  assert.deepEqual(fetchCalls.map((call) => call.url), [supplementalUrl]);
  assert.equal(messagesOf(fakeChrome, "register_supplemental_material").length, 1);
  assert.equal(messagesOf(fakeChrome, "register_download_bytes").length, 0);
  assert.deepEqual(fakeChrome.removedTabs, [100]);
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
          recordPath: "knowledge-base/sources/nature/acquisition.json",
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
          recordPath: "knowledge-base/sources/nature/acquisition.json",
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
        return { type: "registered", jobId: message.jobId, articleUrl: message.articleUrl, downloadPath: message.downloadPath, recordPath: "knowledge-base/sources/science/acquisition.json", fileSha256: "abc123" };
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
