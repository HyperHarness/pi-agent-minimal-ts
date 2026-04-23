import assert from "node:assert/strict";
import test from "node:test";
import { createAttachedPaperBrowserSession } from "../../src/agent/browser-session.js";
import {
  createPaperBrowserManagerServer,
  startPaperBrowserManagerHttpServer,
  type PaperBrowserController
} from "../../src/agent/paper-browser-manager-server.js";
import type {
  DownloadPdfRequest,
  DownloadPdfResponse,
  OpenArticleRequest,
  OpenArticleResponse
} from "../../src/agent/paper-browser-manager-types.js";

function createControllerStub(overrides: Partial<PaperBrowserController> = {}): PaperBrowserController {
  return {
    async ensureBrowser(): Promise<void> {},
    async health() {
      return {
        browserConnected: true,
        profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
      };
    },
    async openArticle(request: OpenArticleRequest): Promise<OpenArticleResponse> {
      return {
        openedUrl: request.url
      };
    },
    async downloadPaperPdf(request: DownloadPdfRequest): Promise<DownloadPdfResponse> {
      return {
        status: "downloaded",
        path: "D:\\Codex\\pi-agent-minimal-ts\\downloads\\papers\\nature-s41586-019-1666-5.pdf",
        publisher: "nature",
        articleUrl: request.url,
        finalArticleUrl: request.url,
        finalPdfUrl: `${request.url}.pdf`
      };
    },
    async close(): Promise<void> {},
    ...overrides
  };
}

test("manager health reports browser connection state after ensuring the browser", async () => {
  const callOrder: string[] = [];
  const manager = createPaperBrowserManagerServer({
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    browserController: createControllerStub({
      async ensureBrowser(): Promise<void> {
        callOrder.push("ensureBrowser");
      },
      async health() {
        callOrder.push("health");
        return {
          browserConnected: true,
          profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
        };
      }
    })
  });

  const health = await manager.handleHealth();

  assert.deepEqual(callOrder, ["ensureBrowser", "health"]);
  assert.deepEqual(health, {
    ok: true,
    browserConnected: true,
    profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
  });
});

test("manager openArticle delegates to the shared browser controller after ensuring the browser", async () => {
  const callOrder: string[] = [];
  const request = {
    url: "https://www.science.org/doi/10.1126/science.adz8659"
  };
  const manager = createPaperBrowserManagerServer({
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    browserController: createControllerStub({
      async ensureBrowser(): Promise<void> {
        callOrder.push("ensureBrowser");
      },
      async openArticle(input: OpenArticleRequest): Promise<OpenArticleResponse> {
        callOrder.push(`openArticle:${input.url}`);
        return {
          openedUrl: input.url
        };
      }
    })
  });

  const response = await manager.handleOpenArticle(request);

  assert.deepEqual(callOrder, [
    "ensureBrowser",
    "openArticle:https://www.science.org/doi/10.1126/science.adz8659"
  ]);
  assert.deepEqual(response, {
    openedUrl: "https://www.science.org/doi/10.1126/science.adz8659"
  });
});

test("manager download delegates to the shared browser controller after ensuring the browser", async () => {
  const callOrder: string[] = [];
  const request = {
    url: "https://www.nature.com/articles/s41586-019-1666-5",
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts"
  };
  const manager = createPaperBrowserManagerServer({
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    browserController: createControllerStub({
      async ensureBrowser(): Promise<void> {
        callOrder.push("ensureBrowser");
      },
      async downloadPaperPdf(input: DownloadPdfRequest): Promise<DownloadPdfResponse> {
        callOrder.push(`downloadPaperPdf:${input.url}`);
        return {
          status: "downloaded",
          path: "D:\\Codex\\pi-agent-minimal-ts\\downloads\\papers\\nature-s41586-019-1666-5.pdf",
          publisher: "nature",
          articleUrl: input.url,
          finalArticleUrl: input.url,
          finalPdfUrl: `${input.url}.pdf`
        };
      }
    })
  });

  const response = await manager.handleDownloadPdf(request);

  assert.deepEqual(callOrder, [
    "ensureBrowser",
    "downloadPaperPdf:https://www.nature.com/articles/s41586-019-1666-5"
  ]);
  assert.equal(response.status, "downloaded");
  assert.equal(
    response.path,
    "D:\\Codex\\pi-agent-minimal-ts\\downloads\\papers\\nature-s41586-019-1666-5.pdf"
  );
});

test("createAttachedPaperBrowserSession opens a manual login page against an attached context", async () => {
  let gotoCalls = 0;
  let bringToFrontCalls = 0;
  let closeCalls = 0;
  const session = createAttachedPaperBrowserSession({
    context: {
      async newPage() {
        return {
          async goto() {
            gotoCalls += 1;
            return null;
          },
          async waitForTimeout() {},
          async content() {
            return "<html></html>";
          },
          url() {
            return "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601";
          },
          async bringToFront() {
            bringToFrontCalls += 1;
          },
          async close() {
            closeCalls += 1;
          }
        };
      }
    }
  });

  const response = await session.openPageForManualLogin(
    "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601"
  );

  assert.deepEqual(response, {
    openedUrl: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601"
  });
  assert.equal(gotoCalls, 1);
  assert.equal(bringToFrontCalls, 1);
  assert.equal(closeCalls, 0);
});

test("manager HTTP server exposes JSON health, open-article, and download-pdf endpoints", async () => {
  const manager = createPaperBrowserManagerServer({
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    browserController: createControllerStub()
  });
  const server = await startPaperBrowserManagerHttpServer({
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    manager
  });

  try {
    const healthResponse = await fetch(`${server.endpoint}/health`);
    assert.equal(healthResponse.status, 200);
    assert.equal(healthResponse.headers.get("content-type"), "application/json");
    assert.deepEqual(await healthResponse.json(), {
      ok: true,
      browserConnected: true,
      profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
    });

    const openArticleResponse = await fetch(`${server.endpoint}/open-article`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        url: "https://www.science.org/doi/10.1126/science.adz8659"
      } satisfies OpenArticleRequest)
    });
    assert.equal(openArticleResponse.status, 200);
    assert.equal(openArticleResponse.headers.get("content-type"), "application/json");
    assert.deepEqual(await openArticleResponse.json(), {
      openedUrl: "https://www.science.org/doi/10.1126/science.adz8659"
    });

    const downloadResponse = await fetch(`${server.endpoint}/download-pdf`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        url: "https://www.nature.com/articles/s41586-019-1666-5",
        workspaceDir: "D:\\Codex\\pi-agent-minimal-ts"
      } satisfies DownloadPdfRequest)
    });
    assert.equal(downloadResponse.status, 200);
    assert.equal(downloadResponse.headers.get("content-type"), "application/json");
    assert.deepEqual(await downloadResponse.json(), {
      status: "downloaded",
      path: "D:\\Codex\\pi-agent-minimal-ts\\downloads\\papers\\nature-s41586-019-1666-5.pdf",
      publisher: "nature",
      articleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
      finalArticleUrl: "https://www.nature.com/articles/s41586-019-1666-5",
      finalPdfUrl: "https://www.nature.com/articles/s41586-019-1666-5.pdf"
    });
  } finally {
    await server.close();
  }
});
