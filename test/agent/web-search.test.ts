import test from "node:test";
import assert from "node:assert/strict";
import { searchWeb } from "../../src/agent/web-search.js";

type FetchRequest = {
  url: string;
  init?: RequestInit;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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

test("searchWeb normalizes the provider request", async () => {
  const requests: FetchRequest[] = [];
  const fetchImpl: FetchLike = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return createJsonResponse(200, {
      results: [{ title: "Example", url: "https://example.test", snippet: "hello" }]
    });
  };

  const result = await searchWeb(
    {
      query: "  latest ai news  ",
      maxResults: 12
    },
    {
      env: { PI_SEARCH_API_URL: "https://search.example.test/search" },
      fetch: fetchImpl
    }
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://search.example.test/search");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(requests[0]?.init?.headers instanceof Headers, true);
  const sentBody = JSON.parse(String(requests[0]?.init?.body));
  assert.deepEqual(sentBody, { query: "latest ai news", maxResults: 10 });
  assert.deepEqual(result, {
    results: [{ title: "Example", url: "https://example.test", snippet: "hello" }]
  });
});

test("searchWeb throws when PI_SEARCH_API_URL is missing", async () => {
  await assert.rejects(
    () =>
      searchWeb(
        { query: "latest ai news" },
        {
          env: {},
          fetch: async () => createJsonResponse(200, { results: [] })
        }
      ),
    /PI_SEARCH_API_URL/i
  );
});

test("searchWeb surfaces upstream HTTP failures", async () => {
  await assert.rejects(
    () =>
      searchWeb(
        { query: "latest ai news" },
        {
          env: { PI_SEARCH_API_URL: "https://search.example.test/search" },
          fetch: async () => createJsonResponse(503, { error: "temporarily unavailable" })
        }
      ),
    /503/i
  );
});
