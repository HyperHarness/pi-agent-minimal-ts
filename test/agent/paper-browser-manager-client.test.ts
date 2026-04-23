import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createPaperBrowserManagerClient } from "../../src/agent/paper-browser-manager-client.js";

test("paper browser manager client reuses a healthy stored endpoint", async () => {
  const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
  const client = createPaperBrowserManagerClient({
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    readMetadata: async () => ({
      pid: 4242,
      startedAt: "2026-04-23T12:00:00.000Z",
      endpoint: "http://127.0.0.1:43123",
      profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
    }),
    writeMetadata: async () => {
      throw new Error("should not rewrite healthy metadata");
    },
    clearMetadata: async () => {
      throw new Error("should not clear healthy metadata");
    },
    isMetadataStale: async () => false,
    fetchJson: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        browserConnected: true,
        profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
      };
    },
    spawnManager: async () => {
      throw new Error("should not spawn a healthy manager");
    }
  });

  const endpoint = await client.ensureManagerEndpoint();

  assert.equal(endpoint, "http://127.0.0.1:43123");
  assert.deepEqual(calls, [{ url: "http://127.0.0.1:43123/health", init: undefined }]);
});

test("paper browser manager client clears stale metadata and persists the spawned manager metadata", async () => {
  const calls: string[] = [];
  const writtenMetadata: Array<{
    pid: number;
    startedAt: string;
    endpoint: string;
    profileDir: string;
  }> = [];
  const client = createPaperBrowserManagerClient({
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    readMetadata: async () => ({
      pid: 999999,
      startedAt: "2026-04-23T12:00:00.000Z",
      endpoint: "http://127.0.0.1:43123",
      profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
    }),
    clearMetadata: async () => {
      calls.push("clear");
    },
    writeMetadata: async (options) => {
      calls.push("write");
      writtenMetadata.push(options.metadata);
    },
    isMetadataStale: async () => false,
    fetchJson: async (url) => {
      calls.push(url);
      if (url.endsWith("/health")) {
        throw new Error("connect ECONNREFUSED");
      }

      throw new Error(`unexpected request: ${url}`);
    },
    spawnManager: async () => {
      calls.push("spawn");
      return {
        pid: 4343,
        startedAt: "2026-04-23T12:05:00.000Z",
        endpoint: "http://127.0.0.1:43124",
        profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
      };
    }
  });

  const endpoint = await client.ensureManagerEndpoint();

  assert.equal(endpoint, "http://127.0.0.1:43124");
  assert.deepEqual(calls, ["http://127.0.0.1:43123/health", "clear", "spawn", "write"]);
  assert.deepEqual(writtenMetadata, [
    {
      pid: 4343,
      startedAt: "2026-04-23T12:05:00.000Z",
      endpoint: "http://127.0.0.1:43124",
      profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
    }
  ]);
});

test("paper browser manager client clears metadata marked stale by discovery before spawning a fresh manager", async () => {
  const calls: string[] = [];
  const client = createPaperBrowserManagerClient({
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    readMetadata: async () => ({
      pid: 4242,
      startedAt: "2026-04-23T12:00:00.000Z",
      endpoint: "http://127.0.0.1:43123",
      profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
    }),
    isMetadataStale: async ({ metadata }) => {
      calls.push(`stale:${metadata.pid}`);
      return true;
    },
    clearMetadata: async () => {
      calls.push("clear");
    },
    writeMetadata: async () => {
      calls.push("write");
    },
    fetchJson: async (url) => {
      calls.push(url);
      throw new Error(`unexpected request: ${url}`);
    },
    spawnManager: async () => {
      calls.push("spawn");
      return {
        pid: 4343,
        startedAt: "2026-04-23T12:05:00.000Z",
        endpoint: "http://127.0.0.1:43124",
        profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
      };
    }
  });

  const endpoint = await client.ensureManagerEndpoint();

  assert.equal(endpoint, "http://127.0.0.1:43124");
  assert.deepEqual(calls, ["stale:4242", "clear", "spawn", "write"]);
});

test("paper browser manager client forwards openArticle and downloadPaperPdf requests", async () => {
  const requests: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
  const spawned: string[] = [];
  const client = createPaperBrowserManagerClient({
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    readMetadata: async () => null,
    writeMetadata: async () => {},
    clearMetadata: async () => {},
    fetchJson: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/health")) {
        return {
          ok: true,
          browserConnected: true,
          profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
        };
      }

      if (url.endsWith("/open-article")) {
        return {
          openedUrl: "https://www.science.org/doi/10.1126/science.adz8659"
        };
      }

      if (url.endsWith("/download-pdf")) {
        return {
          status: "downloaded",
          path: "D:\\Codex\\pi-agent-minimal-ts\\downloads\\papers\\science-10.1126-science.adz8659.pdf",
          publisher: "science",
          articleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
          finalArticleUrl: "https://www.science.org/doi/10.1126/science.adz8659",
          finalPdfUrl: "https://www.science.org/doi/pdf/10.1126/science.adz8659"
        };
      }

      throw new Error(`unexpected request: ${url}`);
    },
    spawnManager: async () => ({
      pid: spawned.push("spawned"),
      startedAt: "2026-04-23T12:01:00.000Z",
      endpoint: "http://127.0.0.1:43125",
      profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
    })
  });

  const openResult = await client.openArticle({
    url: "https://www.science.org/doi/10.1126/science.adz8659"
  });
  const downloadResult = await client.downloadPaperPdf({
    url: "https://www.science.org/doi/10.1126/science.adz8659",
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts"
  });

  assert.deepEqual(openResult, {
    openedUrl: "https://www.science.org/doi/10.1126/science.adz8659",
    profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
  });
  assert.equal(downloadResult.status, "downloaded");
  assert.equal(spawned.length, 1);
  assert.deepEqual(requests.map((request) => request.url), [
    "http://127.0.0.1:43125/open-article",
    "http://127.0.0.1:43125/download-pdf"
  ]);
  assert.deepEqual(requests[0]?.init, {
    method: "POST",
    body: JSON.stringify({
      url: "https://www.science.org/doi/10.1126/science.adz8659"
    })
  });
  assert.deepEqual(requests[1]?.init, {
    method: "POST",
    body: JSON.stringify({
      url: "https://www.science.org/doi/10.1126/science.adz8659",
      workspaceDir: "D:\\Codex\\pi-agent-minimal-ts"
    })
  });
});

test("paper browser manager client close is idempotent", async () => {
  let closeCalls = 0;
  const client = createPaperBrowserManagerClient({
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    readMetadata: async () => null,
    writeMetadata: async () => {},
    clearMetadata: async () => {},
    fetchJson: async (url) => {
      if (url.endsWith("/health")) {
        return {
          ok: true,
          browserConnected: true,
          profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
        };
      }

      throw new Error(`unexpected request: ${url}`);
    },
    spawnManager: async () => ({
      pid: 4244,
      startedAt: "2026-04-23T12:02:00.000Z",
      endpoint: "http://127.0.0.1:43126",
      profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
    }),
    disposeManager: async () => {
      closeCalls += 1;
    }
  });

  await client.ensureManagerEndpoint();
  await client.close();
  await client.close();

  assert.equal(closeCalls, 1);
});

test("paper browser manager client preserves typed manager errors across the HTTP boundary", async () => {
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          browserConnected: true,
          profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
        })
      );
      return;
    }

    if (request.method === "POST" && request.url === "/download-pdf") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: false,
          error: {
            code: "manual_login_required",
            message: "Manual login required for this publisher."
          }
        })
      );
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: { message: "not found" } }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;

  const client = createPaperBrowserManagerClient({
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    readMetadata: async () => ({
      pid: 4242,
      startedAt: "2026-04-23T12:00:00.000Z",
      endpoint,
      profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
    }),
    writeMetadata: async () => {},
    clearMetadata: async () => {},
    isMetadataStale: async () => false
  });

  try {
    await assert.rejects(
      () =>
        client.downloadPaperPdf({
          url: "https://www.science.org/doi/10.1126/science.adz8659",
          workspaceDir: "D:\\Codex\\pi-agent-minimal-ts"
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: string }).code, "manual_login_required");
        assert.equal(error.message, "Manual login required for this publisher.");
        return true;
      }
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("paper browser manager client retries after a failed endpoint resolution and closes a reopened manager", async () => {
  let spawnCalls = 0;
  let disposeCalls = 0;
  const client = createPaperBrowserManagerClient({
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    readMetadata: async () => null,
    writeMetadata: async () => {},
    clearMetadata: async () => {},
    fetchJson: async (url) => {
      if (url.endsWith("/health")) {
        return {
          ok: true,
          browserConnected: true,
          profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
        };
      }

      throw new Error(`unexpected request: ${url}`);
    },
    spawnManager: async () => {
      spawnCalls += 1;
      if (spawnCalls === 1) {
        throw new Error("first spawn failed");
      }

      return {
        pid: 5000 + spawnCalls,
        startedAt: "2026-04-23T12:10:00.000Z",
        endpoint: `http://127.0.0.1:4313${spawnCalls}`,
        profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
      };
    },
    disposeManager: async () => {
      disposeCalls += 1;
    }
  });

  await assert.rejects(client.ensureManagerEndpoint(), /first spawn failed/);
  assert.equal(await client.ensureManagerEndpoint(), "http://127.0.0.1:43132");
  await client.close();
  assert.equal(await client.ensureManagerEndpoint(), "http://127.0.0.1:43133");
  await client.close();

  assert.equal(spawnCalls, 3);
  assert.equal(disposeCalls, 2);
});

test("paper browser manager client closes a spawned manager when metadata persistence fails", async () => {
  let disposeCalls = 0;
  const client = createPaperBrowserManagerClient({
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    readMetadata: async () => null,
    writeMetadata: async () => {
      throw new Error("disk full");
    },
    clearMetadata: async () => {},
    spawnManager: async () => ({
      pid: 4343,
      startedAt: "2026-04-23T12:05:00.000Z",
      endpoint: "http://127.0.0.1:43124",
      profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
    }),
    disposeManager: async () => {
      disposeCalls += 1;
    }
  });

  await assert.rejects(() => client.ensureManagerEndpoint(), /disk full/);

  assert.equal(disposeCalls, 1);
});

test("paper browser manager client uses the spawned manager dispose hook for client close", async () => {
  let returnedDisposeCalls = 0;
  let fallbackDisposeCalls = 0;
  const client = createPaperBrowserManagerClient({
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    readMetadata: async () => null,
    writeMetadata: async () => {},
    clearMetadata: async () => {},
    spawnManager: async () => ({
      metadata: {
        pid: 4245,
        startedAt: "2026-04-23T12:03:00.000Z",
        endpoint: "http://127.0.0.1:43127",
        profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
      },
      dispose: async () => {
        returnedDisposeCalls += 1;
      }
    }),
    disposeManager: async () => {
      fallbackDisposeCalls += 1;
    }
  });

  assert.equal(await client.ensureManagerEndpoint(), "http://127.0.0.1:43127");
  await client.close();
  await client.close();

  assert.equal(returnedDisposeCalls, 1);
  assert.equal(fallbackDisposeCalls, 0);
});

test("paper browser manager client prefers the spawned manager dispose hook when metadata persistence fails", async () => {
  let returnedDisposeCalls = 0;
  let fallbackDisposeCalls = 0;
  const client = createPaperBrowserManagerClient({
    workspaceDir: "D:\\Codex\\pi-agent-minimal-ts",
    readMetadata: async () => null,
    writeMetadata: async () => {
      throw new Error("disk full");
    },
    clearMetadata: async () => {},
    spawnManager: async () => ({
      metadata: {
        pid: 4344,
        startedAt: "2026-04-23T12:06:00.000Z",
        endpoint: "http://127.0.0.1:43128",
        profileDir: "D:\\Codex\\pi-agent-minimal-ts\\.browser-profile\\paper-access"
      },
      close: async () => {
        returnedDisposeCalls += 1;
      }
    }),
    disposeManager: async () => {
      fallbackDisposeCalls += 1;
    }
  });

  await assert.rejects(() => client.ensureManagerEndpoint(), /disk full/);

  assert.equal(returnedDisposeCalls, 1);
  assert.equal(fallbackDisposeCalls, 0);
});
