import test from "node:test";
import assert from "node:assert/strict";
import { searchWeb } from "../../src/agent/web-search.js";
import { parseJsonResponse, resolveFetchTimeoutMs } from "../../src/agent/network.js";

type FetchRequest = {
  url: string;
  init?: RequestInit;
};

function createJsonResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-type": "application/json" }),
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    }
  } as Response;
}

test("resolveFetchTimeoutMs throws for invalid PI_FETCH_TIMEOUT_MS", () => {
  assert.throws(
    () => resolveFetchTimeoutMs({ PI_FETCH_TIMEOUT_MS: "not-a-number" }),
    /PI_FETCH_TIMEOUT_MS/i
  );
});

test("resolveFetchTimeoutMs throws when PI_FETCH_TIMEOUT_MS floors to zero", () => {
  assert.throws(
    () => resolveFetchTimeoutMs({ PI_FETCH_TIMEOUT_MS: "0.5" }),
    /PI_FETCH_TIMEOUT_MS/i
  );
});

test("resolveFetchTimeoutMs returns the default when PI_FETCH_TIMEOUT_MS is missing or blank", () => {
  assert.equal(resolveFetchTimeoutMs({}), 10_000);
  assert.equal(resolveFetchTimeoutMs({ PI_FETCH_TIMEOUT_MS: "   " }), 10_000);
});

test("parseJsonResponse rejects non-JSON content types", async () => {
  const response = new Response("plain text", {
    status: 200,
    headers: { "content-type": "text/plain" }
  });

  await assert.rejects(() => parseJsonResponse(response), /content-type/i);
});

test("searchWeb normalizes the provider request", async () => {
  const requests: FetchRequest[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return createJsonResponse(200, {
      results: [{ title: "Example", url: "https://example.test", snippet: "hello" }]
    });
  };

  const result = await searchWeb(
    {
      query: "  latest ai news  ",
      maxResults: 12,
      env: {
        PI_SEARCH_API_URL: "https://search.example.test/search",
        PI_SEARCH_API_KEY: "search-secret"
      },
      fetchImpl
    }
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://search.example.test/search");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(requests[0]?.init?.headers instanceof Headers, true);
  assert.equal((requests[0]?.init?.headers as Headers).get("authorization"), "Bearer search-secret");
  const sentBody = JSON.parse(String(requests[0]?.init?.body));
  assert.deepEqual(sentBody, { query: "latest ai news", maxResults: 12 });
  assert.deepEqual(result, [{ title: "Example", url: "https://example.test", snippet: "hello" }]);
});

test("searchWeb accepts Tavily-style results that use content instead of snippet", async () => {
  const result = await searchWeb({
    query: "gold price today usd per ounce",
    env: { PI_SEARCH_API_URL: "https://search.example.test/search" },
    fetchImpl: async () =>
      createJsonResponse(200, {
        results: [
          {
            title: "Gold Price Today",
            url: "https://example.test/gold",
            content: "Gold Price Per Ounce. $4,783.30 USD."
          }
        ]
      })
  });

  assert.deepEqual(result, [
    {
      title: "Gold Price Today",
      url: "https://example.test/gold",
      snippet: "Gold Price Per Ounce. $4,783.30 USD."
    }
  ]);
});

test("searchWeb uses max_results for Tavily endpoints", async () => {
  const requests: FetchRequest[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return createJsonResponse(200, { results: [] });
  };

  await searchWeb({
    query: "gold price today usd per ounce",
    maxResults: 3,
    env: { PI_SEARCH_API_URL: "https://api.tavily.com/search" },
    fetchImpl
  });

  const sentBody = JSON.parse(String(requests[0]?.init?.body));
  assert.equal(sentBody.query, "gold price today usd per ounce");
  assert.equal(sentBody.max_results, 3);
  assert.equal("maxResults" in sentBody, false);
});

test("searchWeb rejects non-integer maxResults values", async () => {
  await assert.rejects(
    () =>
      searchWeb({
        query: "latest ai news",
        maxResults: 1.5,
        env: { PI_SEARCH_API_URL: "https://search.example.test/search" },
        fetchImpl: async () => createJsonResponse(200, { results: [] })
      }),
    /maxResults/i
  );
});

test("searchWeb rejects non-positive maxResults values", async () => {
  await assert.rejects(
    () =>
      searchWeb({
        query: "latest ai news",
        maxResults: 0,
        env: { PI_SEARCH_API_URL: "https://search.example.test/search" },
        fetchImpl: async () => createJsonResponse(200, { results: [] })
      }),
    /maxResults/i
  );
});

test("searchWeb propagates fetch transport failures", async () => {
  await assert.rejects(
    () =>
      searchWeb({
        query: "latest ai news",
        env: { PI_SEARCH_API_URL: "https://search.example.test/search" },
        fetchImpl: async () => {
          throw new Error("socket hang up");
        }
      }),
    /socket hang up/i
  );
});

test("searchWeb surfaces timeout-triggered fetch aborts", async () => {
  let sawAbort = false;

  await assert.rejects(
    () =>
      searchWeb({
        query: "latest ai news",
        env: {
          PI_SEARCH_API_URL: "https://search.example.test/search",
          PI_FETCH_TIMEOUT_MS: "1"
        },
        fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                sawAbort = true;
                reject(new DOMException("The operation was aborted", "AbortError"));
              },
              { once: true }
            );
          })
      }),
    (error: unknown) => {
      assert.equal(sawAbort, true);
      assert.equal(error instanceof DOMException, true);
      assert.equal((error as DOMException).name, "AbortError");
      return true;
    }
  );
});

test("searchWeb throws when PI_SEARCH_API_URL is missing", async () => {
  await assert.rejects(
    () =>
      searchWeb({
        query: "latest ai news",
        env: {},
        fetchImpl: async () => createJsonResponse(200, { results: [] })
      }),
    /PI_SEARCH_API_URL/i
  );
});

test("searchWeb surfaces upstream HTTP failures", async () => {
  await assert.rejects(
    () =>
      searchWeb({
        query: "latest ai news",
        env: { PI_SEARCH_API_URL: "https://search.example.test/search" },
        fetchImpl: async () => createJsonResponse(503, { error: "temporarily unavailable" })
      }),
    /503/i
  );
});
