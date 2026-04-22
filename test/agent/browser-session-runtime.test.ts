import test from "node:test";
import assert from "node:assert/strict";
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

test("resolveDefaultPaperBrowserSessionFactory returns a callable session factory", () => {
  const factory = resolveDefaultPaperBrowserSessionFactory({
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts"
  });

  assert.equal(typeof factory, "function");
});

test("PaperBrowserSessionError preserves the explicit code", () => {
  const error = new PaperBrowserSessionError("browser_session_unavailable", "Chrome launch failed");

  assert.equal(error.code, "browser_session_unavailable");
  assert.equal(error.message, "Chrome launch failed");
});
