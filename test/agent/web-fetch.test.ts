import test from "node:test";
import assert from "node:assert/strict";
import { fetchWebPage } from "../../src/agent/web-fetch.js";

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
