import test from "node:test";
import assert from "node:assert/strict";
import { buildArxivPdfUrl, searchArxiv } from "../../src/agent/arxiv.js";

const sampleFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2501.01234v1</id>
    <title> Example Paper Title </title>
    <summary> Example summary text. </summary>
    <author><name>Alice Example</name></author>
    <author><name>Bob Example</name></author>
  </entry>
</feed>`;

test("searchArxiv parses the Atom response into compact result objects", async () => {
  let observedUrl = "";

  const results = await searchArxiv({
    query: "agent memory",
    maxResults: 2,
    fetchImpl: async (input: RequestInfo | URL) => {
      observedUrl = String(input);
      return new Response(sampleFeed, {
        status: 200,
        headers: { "content-type": "application/atom+xml" }
      });
    }
  });

  assert.match(observedUrl, /export\.arxiv\.org\/api\/query/);
  assert.match(observedUrl, /search_query=all%3Aagent%20memory/);
  assert.match(observedUrl, /max_results=2/);
  assert.deepEqual(results, [
    {
      id: "2501.01234",
      title: "Example Paper Title",
      authors: ["Alice Example", "Bob Example"],
      summary: "Example summary text.",
      absUrl: "https://arxiv.org/abs/2501.01234",
      pdfUrl: "https://arxiv.org/pdf/2501.01234.pdf"
    }
  ]);
});

test("buildArxivPdfUrl accepts legacy identifiers", () => {
  assert.equal(
    buildArxivPdfUrl("hep-th/9901001"),
    "https://arxiv.org/pdf/hep-th/9901001.pdf"
  );
});

test("buildArxivPdfUrl rejects malformed identifiers", () => {
  assert.throws(() => buildArxivPdfUrl("not an arxiv id"), /arXiv/i);
});

test("searchArxiv rejects queries that were mangled into question marks before hitting arXiv", async () => {
  let fetchCalled = false;

  await assert.rejects(
    () =>
      searchArxiv({
        query: "??????????????",
        fetchImpl: async () => {
          fetchCalled = true;
          return new Response(sampleFeed, {
            status: 200,
            headers: { "content-type": "application/atom+xml" }
          });
        }
      }),
    /encoding|english|utf-8/i
  );

  assert.equal(fetchCalled, false);
});
