import test from "node:test";
import assert from "node:assert/strict";
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
