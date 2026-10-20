import test from "node:test";
import assert from "node:assert/strict";
import { fetchWebPage as fetchWithPolicy, type FetchWebPageOptions } from "../../src/agent/web-fetch.js";

const fetchWebPage = (options: FetchWebPageOptions) => fetchWithPolicy({
  env: {}, resolveHostname: async () => [{ address: "8.8.8.8", family: 4 }], ...options,
});

function createHtmlResponse(status: number, body: string, contentType = "text/html; charset=utf-8") {
  return new Response(body, {
    status,
    headers: { "content-type": contentType }
  });
}

test("fetchWebPage rejects non-http URLs", async () => {
  await assert.rejects(
    () =>
      fetchWebPage({
        url: "ftp://example.test/page",
        fetchImpl: async () => createHtmlResponse(200, "<html></html>")
      }),
    /http/i
  );
});

test("fetchWebPage removes scripts and returns cleaned text", async () => {
  const result = await fetchWebPage({
    url: "https://example.test/page",
    fetchImpl: async () =>
      createHtmlResponse(
        200,
        "<html><head><title>Test</title><script>ignore()</script><style>body{}</style></head><body><h1>Hello</h1><noscript>nope</noscript><p>World &amp; friends</p></body></html>"
      )
  });

  assert.equal(result, "Test Hello World & friends");
});

test("fetchWebPage rejects non-html responses", async () => {
  await assert.rejects(
    () =>
      fetchWebPage({
        url: "https://example.test/page",
        fetchImpl: async () =>
          createHtmlResponse(200, "{\"ok\":true}", "application/json; charset=utf-8")
      }),
    /html/i
  );
});

test("fetchWebPage rejects misleading non-html content types", async () => {
  await assert.rejects(
    () =>
      fetchWebPage({
        url: "https://example.test/page",
        fetchImpl: async () =>
          createHtmlResponse(200, "{\"ok\":true}", "application/json; charset=utf-8; note=text/html")
      }),
    /html/i
  );
});

test("fetchWebPage truncates very large pages", async () => {
  const result = await fetchWebPage({
    url: "https://example.test/page",
    fetchImpl: async () =>
      createHtmlResponse(200, `<html><body>${"a".repeat(13_000)}</body></html>`)
  });

  assert.equal(result.length, 12_000);
  assert.equal(result, "a".repeat(12_000));
});

test("fetchWebPage cancels bodies rejected for status or content type", async () => {
  for (const [status, contentType] of [[403, "text/html"], [200, "application/json"]] as const) {
    let canceled = false;
    await assert.rejects(fetchWebPage({
      url: "https://example.test/page",
      fetchImpl: async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), {
        status, headers: { "content-type": contentType }
      })
    }));
    assert.equal(canceled, true);
  }
});

test("fetchWebPage stops an unbounded HTML stream before buffering the whole response", async () => {
  let reads = 0;
  let canceled = false;
  await assert.rejects(fetchWebPage({
    url: "https://example.test/page",
    fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { canceled = true; }
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/html" } })
  }), /byte limit/);
  assert.equal(reads, 3);
  assert.equal(canceled, true);
});
