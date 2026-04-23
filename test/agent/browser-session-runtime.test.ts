import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import {
  PaperBrowserSessionError,
  classifyArticleAuthorization,
  resolveDefaultPaperBrowserSessionFactory
} from "../../src/agent/browser-session.js";

test("classifyArticleAuthorization marks publisher login walls as authorization_failed", () => {
  const result = classifyArticleAuthorization({
    finalUrl: "https://www.science.org/action/showLogin",
    html: "<html><body>Access through your institution</body></html>"
  });

  assert.equal(result.authorized, false);
  assert.equal(result.failureCode, "authorization_failed");
});

test("classifyArticleAuthorization keeps normal article pages authorized", () => {
  const result = classifyArticleAuthorization({
    finalUrl: "https://example.com/articles/quantum-networks",
    html: "<html><body><header>Sign in</header><article>Quantum networks improve routing.</article></body></html>"
  });

  assert.equal(result.authorized, true);
  assert.equal(result.failureCode, undefined);
});

test("classifyArticleAuthorization marks anti-bot challenge pages as authorization_failed", () => {
  const result = classifyArticleAuthorization({
    finalUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
    html: "<html><body>This website uses a security service to protect itself from malicious automated programs. During verification that you are not an automated program, this page will be shown.</body></html>"
  });

  assert.equal(result.authorized, false);
  assert.equal(result.failureCode, "authorization_failed");
});

test("resolveDefaultPaperBrowserSessionFactory returns a callable session factory", () => {
  const factory = resolveDefaultPaperBrowserSessionFactory({
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts"
  });

  assert.equal(typeof factory, "function");
});

test("resolveDefaultPaperBrowserSessionFactory does not launch a browser until invoked", () => {
  let launchCalls = 0;
  const originalLaunchPersistentContext = chromium.launchPersistentContext.bind(chromium);

  chromium.launchPersistentContext = (async (...args: Parameters<typeof chromium.launchPersistentContext>) => {
    launchCalls += 1;
    return originalLaunchPersistentContext(...args);
  }) as typeof chromium.launchPersistentContext;

  try {
    const factory = resolveDefaultPaperBrowserSessionFactory({
      workspaceDir: "D:\\Codex\\pi-agent-minimal-ts"
    });

    assert.equal(typeof factory, "function");
    assert.equal(launchCalls, 0);
  } finally {
    chromium.launchPersistentContext = originalLaunchPersistentContext;
  }
});

test("PaperBrowserSessionError preserves the explicit code", () => {
  const error = new PaperBrowserSessionError("browser_session_unavailable", "Chrome launch failed");

  assert.equal(error.code, "browser_session_unavailable");
  assert.equal(error.message, "Chrome launch failed");
});

test("resolveDefaultPaperBrowserSessionFactory explains when the shared profile is already in use", async () => {
  const originalLaunchPersistentContext = chromium.launchPersistentContext.bind(chromium);
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-browser-profile-in-use-"));
  const profileDir = path.join(workspaceDir, ".browser-profile", "paper-access");
  await mkdir(path.join(profileDir, "Default"), { recursive: true });
  await writeFile(path.join(profileDir, "lockfile"), "");
  await writeFile(path.join(profileDir, "Default", "LOCK"), "");

  chromium.launchPersistentContext = (async () => {
    throw new Error("browserType.launchPersistentContext: Target page, context or browser has been closed");
  }) as typeof chromium.launchPersistentContext;

  try {
    const factory = resolveDefaultPaperBrowserSessionFactory({ workspaceDir });

    await assert.rejects(
      () => factory(),
      (error: unknown) => {
        assert.ok(error instanceof PaperBrowserSessionError);
        assert.equal(error.code, "browser_session_unavailable");
        assert.match(error.message, /already open/i);
        assert.match(error.message, /close/i);
        return true;
      }
    );
  } finally {
    chromium.launchPersistentContext = originalLaunchPersistentContext;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("openArticlePage waits for an anti-bot challenge page to clear before returning", async () => {
  const originalLaunchPersistentContext = chromium.launchPersistentContext.bind(chromium);
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-browser-challenge-"));
  const pageStates = [
    {
      url: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
      html: "<html><body>This website uses a security service to protect itself from malicious automated programs. During verification that you are not an automated program, this page will be shown.</body></html>"
    },
    {
      url: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601",
      html: '<html><body><a href="/prl/pdf/10.1103/PhysRevLett.134.090601">PDF</a></body></html>'
    }
  ];
  let stateIndex = 0;
  let waitCalls = 0;

  chromium.launchPersistentContext = (async () => ({
    newPage: async () =>
      ({
        goto: async () => null,
        waitForLoadState: async () => {},
        waitForTimeout: async () => {
          waitCalls += 1;
          stateIndex = Math.min(stateIndex + 1, pageStates.length - 1);
        },
        url: () => pageStates[stateIndex]?.url ?? pageStates[pageStates.length - 1]!.url,
        content: async () => pageStates[stateIndex]?.html ?? pageStates[pageStates.length - 1]!.html,
        close: async () => {}
      }) as never,
    close: async () => {}
  })) as unknown as typeof chromium.launchPersistentContext;

  try {
    const factory = resolveDefaultPaperBrowserSessionFactory({ workspaceDir });
    const session = await factory();

    const result = await session.openArticlePage(
      "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601"
    );

    assert.equal(result.authorized, true);
    assert.match(result.html, /\/prl\/pdf\//i);
    assert.ok(waitCalls >= 1);
  } finally {
    chromium.launchPersistentContext = originalLaunchPersistentContext;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("openPageForManualLogin opens a visible page without inspecting or closing it", async () => {
  const originalLaunchPersistentContext = chromium.launchPersistentContext.bind(chromium);
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-browser-manual-open-"));
  let gotoCalls = 0;
  let contentCalls = 0;
  let closeCalls = 0;
  let bringToFrontCalls = 0;

  chromium.launchPersistentContext = (async () => ({
    newPage: async () =>
      ({
        goto: async () => {
          gotoCalls += 1;
          return null;
        },
        url: () => "https://www.science.org/doi/10.1126/science.adz8659",
        content: async () => {
          contentCalls += 1;
          return "<html></html>";
        },
        bringToFront: async () => {
          bringToFrontCalls += 1;
        },
        close: async () => {
          closeCalls += 1;
        }
      }) as never,
    close: async () => {}
  })) as unknown as typeof chromium.launchPersistentContext;

  try {
    const factory = resolveDefaultPaperBrowserSessionFactory({ workspaceDir });
    const session = await factory();

    const result = await session.openPageForManualLogin(
      "https://www.science.org/doi/10.1126/science.adz8659"
    );

    assert.deepEqual(result, {
      openedUrl: "https://www.science.org/doi/10.1126/science.adz8659"
    });
    assert.equal(gotoCalls, 1);
    assert.equal(contentCalls, 0);
    assert.equal(closeCalls, 0);
    assert.equal(bringToFrontCalls, 1);
  } finally {
    chromium.launchPersistentContext = originalLaunchPersistentContext;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("default paper browser session reports alive when the browser context can open a probe page", async () => {
  const originalLaunchPersistentContext = chromium.launchPersistentContext.bind(chromium);
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-browser-alive-"));
  let newPageCalls = 0;
  let probeCloseCalls = 0;

  chromium.launchPersistentContext = (async () => ({
    newPage: async () => {
      newPageCalls += 1;
      return ({
        close: async () => {
          probeCloseCalls += 1;
        }
      }) as never;
    },
    close: async () => {}
  })) as unknown as typeof chromium.launchPersistentContext;

  try {
    const factory = resolveDefaultPaperBrowserSessionFactory({ workspaceDir });
    const session = await factory();

    assert.equal(typeof session.isAlive, "function");
    assert.equal(await session.isAlive?.(), true);
    assert.equal(newPageCalls, 1);
    assert.equal(probeCloseCalls, 1);
  } finally {
    chromium.launchPersistentContext = originalLaunchPersistentContext;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("default paper browser session reports not alive after the browser context has closed", async () => {
  const originalLaunchPersistentContext = chromium.launchPersistentContext.bind(chromium);
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-browser-dead-"));
  let browserClosed = false;

  chromium.launchPersistentContext = (async () => ({
    newPage: async () => {
      if (browserClosed) {
        throw new Error("browserType.launchPersistentContext: Target page, context or browser has been closed");
      }

      return ({
        close: async () => {}
      }) as never;
    },
    close: async () => {}
  })) as unknown as typeof chromium.launchPersistentContext;

  try {
    const factory = resolveDefaultPaperBrowserSessionFactory({ workspaceDir });
    const session = await factory();
    browserClosed = true;

    assert.equal(typeof session.isAlive, "function");
    assert.equal(await session.isAlive?.(), false);
  } finally {
    chromium.launchPersistentContext = originalLaunchPersistentContext;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPdf saves an inline PDF response when no download event fires", async () => {
  const originalLaunchPersistentContext = chromium.launchPersistentContext.bind(chromium);
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-browser-inline-"));
  const destinationPath = path.join(workspaceDir, "inline.pdf");
  const pdfBytes = Buffer.from("%PDF-inline-test");

  chromium.launchPersistentContext = (async () => ({
    newPage: async () =>
      ({
        once() {},
        goto: async () => ({
          headers: () => ({ "content-type": "application/pdf" }),
          body: async () => pdfBytes
        }),
        close: async () => {}
      }) as never,
    close: async () => {}
  })) as unknown as typeof chromium.launchPersistentContext;

  try {
    const factory = resolveDefaultPaperBrowserSessionFactory({ workspaceDir });
    const session = await factory();

    await session.downloadPdf("https://example.com/paper.pdf", destinationPath);

    const writtenBytes = await readFile(destinationPath);
    assert.deepEqual(writtenBytes, pdfBytes);
  } finally {
    chromium.launchPersistentContext = originalLaunchPersistentContext;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPdf falls back to the request API when Chrome navigation returns PDF viewer HTML", async () => {
  const originalLaunchPersistentContext = chromium.launchPersistentContext.bind(chromium);
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-browser-pdf-viewer-"));
  const destinationPath = path.join(workspaceDir, "nature.pdf");
  const htmlBytes = Buffer.from("<!doctype html><html><body>viewer</body></html>");
  const pdfBytes = Buffer.from("%PDF-nature-test");

  chromium.launchPersistentContext = (async () => ({
    newPage: async () =>
      ({
        once() {},
        waitForEvent: async () => null,
        goto: async () => ({
          headers: () => ({ "content-type": "application/pdf" }),
          body: async () => htmlBytes
        }),
        request: {
          get: async () => ({
            headers: () => ({ "content-type": "application/pdf" }),
            body: async () => pdfBytes
          })
        },
        close: async () => {}
      }) as never,
    close: async () => {}
  })) as unknown as typeof chromium.launchPersistentContext;

  try {
    const factory = resolveDefaultPaperBrowserSessionFactory({ workspaceDir });
    const session = await factory();

    await session.downloadPdf("https://www.nature.com/articles/s41586-019-1666-5.pdf", destinationPath);

    const writtenBytes = await readFile(destinationPath);
    assert.deepEqual(writtenBytes, pdfBytes);
  } finally {
    chromium.launchPersistentContext = originalLaunchPersistentContext;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPdf waits for an anti-bot challenge page to clear before saving the PDF", async () => {
  const originalLaunchPersistentContext = chromium.launchPersistentContext.bind(chromium);
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-browser-pdf-challenge-"));
  const destinationPath = path.join(workspaceDir, "aps.pdf");
  const pdfBytes = Buffer.from("%PDF-aps-test");
  const responses = [
    {
      headers: () => ({ "content-type": "text/html; charset=utf-8" }),
      body: async () =>
        Buffer.from(
          "This website uses a security service to protect itself from malicious automated programs. During verification that you are not an automated program, this page will be shown."
        )
    },
    {
      headers: () => ({ "content-type": "application/pdf" }),
      body: async () => pdfBytes
    }
  ];
  let responseIndex = 0;
  let waitCalls = 0;

  chromium.launchPersistentContext = (async () => ({
    newPage: async () =>
      ({
        goto: async () => responses[responseIndex] ?? responses[responses.length - 1],
        content: async () =>
          responseIndex === 0
            ? "<html><body>This website uses a security service to protect itself from malicious automated programs. During verification that you are not an automated program, this page will be shown.</body></html>"
            : "<html><body></body></html>",
        waitForTimeout: async () => {
          waitCalls += 1;
          responseIndex = Math.min(responseIndex + 1, responses.length - 1);
        },
        close: async () => {}
      }) as never,
    close: async () => {}
  })) as unknown as typeof chromium.launchPersistentContext;

  try {
    const factory = resolveDefaultPaperBrowserSessionFactory({ workspaceDir });
    const session = await factory();

    await session.downloadPdf(
      "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.134.090601",
      destinationPath
    );

    const writtenBytes = await readFile(destinationPath);
    assert.deepEqual(writtenBytes, pdfBytes);
    assert.ok(waitCalls >= 1);
  } finally {
    chromium.launchPersistentContext = originalLaunchPersistentContext;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("downloadPdf reports manual verification when the anti-bot challenge never clears", async () => {
  const originalLaunchPersistentContext = chromium.launchPersistentContext.bind(chromium);
  const originalDateNow = Date.now;
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paper-browser-pdf-blocked-"));
  const destinationPath = path.join(workspaceDir, "aps.pdf");
  const challengeHtml =
    "<html><body>This website uses a security service to protect itself from malicious automated programs. During verification that you are not an automated program, this page will be shown.</body></html>";
  let now = 0;

  chromium.launchPersistentContext = (async () => ({
    newPage: async () =>
      ({
        goto: async () => ({
          headers: () => ({ "content-type": "text/html; charset=utf-8" }),
          body: async () => Buffer.from(challengeHtml)
        }),
        content: async () => challengeHtml,
        waitForTimeout: async () => {
          now += 301_000;
        },
        close: async () => {}
      }) as never,
    close: async () => {}
  })) as unknown as typeof chromium.launchPersistentContext;
  Date.now = () => now;

  try {
    const factory = resolveDefaultPaperBrowserSessionFactory({ workspaceDir });
    const session = await factory();

    await assert.rejects(
      () =>
        session.downloadPdf(
          "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.134.090601",
          destinationPath
        ),
      (error: unknown) => {
        assert.ok(error instanceof PaperBrowserSessionError);
        assert.equal(error.code, "authorization_failed");
        assert.match(error.message, /verification/i);
        return true;
      }
    );
  } finally {
    Date.now = originalDateNow;
    chromium.launchPersistentContext = originalLaunchPersistentContext;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
