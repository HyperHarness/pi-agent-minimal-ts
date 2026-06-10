import test from "node:test";
import assert from "node:assert/strict";
import {
  buildArxivHtmlFallbackUrl,
  buildArxivHtmlUrl,
  buildArxivHtmlUrls,
  buildArxivPdfUrl,
  downloadArxivPdf,
  parseArxivLocator,
  searchArxiv
} from "../../src/agent/paper/acquisition/arxiv.js";

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
  const observedUrls: string[] = [];

  const results = await searchArxiv({
    query: "agent memory",
    maxResults: 2,
    fetchImpl: async (input: RequestInfo | URL) => {
      observedUrls.push(String(input));
      return new Response(sampleFeed, {
        status: 200,
        headers: { "content-type": "application/atom+xml" }
      });
    }
  });

  assert.match(observedUrls[0] ?? "", /export\.arxiv\.org\/api\/query/);
  assert.match(observedUrls[0] ?? "", /search_query=all%3Aagent%20memory/);
  assert.match(observedUrls[0] ?? "", /max_results=2/);
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

test("searchArxiv falls back to title token queries for long exact titles", async () => {
  const observedQueries: string[] = [];

  const results = await searchArxiv({
    query: "SQuADDS: A Validated Design Database and Simulation Workflow for Superconducting Qubit Design",
    maxResults: 3,
    fetchImpl: async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      observedQueries.push(url.searchParams.get("search_query") ?? "");
      if (observedQueries.length === 1) {
        return new Response("<feed></feed>", {
          status: 200,
          headers: { "content-type": "application/atom+xml" }
        });
      }

      return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2312.13483v1</id>
    <title>SQuADDS: A Validated Design Database and Simulation Workflow for Superconducting Qubit Design</title>
    <summary>Superconducting qubit design database.</summary>
    <author><name>Alice Example</name></author>
  </entry>
</feed>`, {
        status: 200,
        headers: { "content-type": "application/atom+xml" }
      });
    }
  });

  assert.equal(observedQueries[0], "all:SQuADDS: A Validated Design Database and Simulation Workflow for Superconducting Qubit Design");
  assert.match(observedQueries[1] ?? "", /^ti:SQuADDS AND ti:Validated AND ti:Design/);
  assert.deepEqual(results, [
    {
      id: "2312.13483",
      title: "SQuADDS: A Validated Design Database and Simulation Workflow for Superconducting Qubit Design",
      authors: ["Alice Example"],
      summary: "Superconducting qubit design database.",
      absUrl: "https://arxiv.org/abs/2312.13483",
      pdfUrl: "https://arxiv.org/pdf/2312.13483.pdf"
    }
  ]);
});

test("buildArxivPdfUrl accepts legacy identifiers", () => {
  assert.equal(
    buildArxivPdfUrl("hep-th/9901001"),
    "https://arxiv.org/pdf/hep-th/9901001.pdf"
  );
});

test("buildArxivHtmlUrl accepts modern identifiers", () => {
  assert.equal(
    buildArxivHtmlUrl("2601.00425v1"),
    "https://arxiv.org/html/2601.00425v1"
  );
});

test("buildArxivHtmlUrls returns arxiv.org before ar5iv labs fallback", () => {
  assert.deepEqual(buildArxivHtmlUrls("2411.15039v1"), [
    "https://arxiv.org/html/2411.15039v1",
    "https://ar5iv.labs.arxiv.org/html/2411.15039v1"
  ]);
  assert.equal(
    buildArxivHtmlFallbackUrl("2411.15039v1"),
    "https://ar5iv.labs.arxiv.org/html/2411.15039v1"
  );
});

test("buildArxivPdfUrl rejects malformed identifiers", () => {
  assert.throws(() => buildArxivPdfUrl("not an arxiv id"), /arXiv/i);
});

test("parseArxivLocator canonicalizes arXiv PDF URLs", () => {
  assert.deepEqual(parseArxivLocator("https://arxiv.org/pdf/2401.01234.pdf"), {
    id: "2401.01234",
    absUrl: "https://arxiv.org/abs/2401.01234",
    htmlUrl: "https://arxiv.org/html/2401.01234",
    pdfUrl: "https://arxiv.org/pdf/2401.01234.pdf"
  });
});

test("parseArxivLocator strips arXiv version suffixes from abs URLs", () => {
  assert.deepEqual(parseArxivLocator("https://arxiv.org/abs/2401.01234v2"), {
    id: "2401.01234",
    absUrl: "https://arxiv.org/abs/2401.01234",
    htmlUrl: "https://arxiv.org/html/2401.01234",
    pdfUrl: "https://arxiv.org/pdf/2401.01234.pdf"
  });
});

test("parseArxivLocator canonicalizes arXiv HTML URLs", () => {
  assert.deepEqual(parseArxivLocator("https://arxiv.org/html/2601.00425v1"), {
    id: "2601.00425",
    absUrl: "https://arxiv.org/abs/2601.00425",
    htmlUrl: "https://arxiv.org/html/2601.00425",
    pdfUrl: "https://arxiv.org/pdf/2601.00425.pdf"
  });
});

test("downloadArxivPdf rejects non-PDF bodies", async () => {
  await assert.rejects(
    () =>
      downloadArxivPdf({
        input: "2401.01234",
        fetchImpl: async () =>
          new Response("<html>not a pdf</html>", {
            status: 200,
            headers: { "content-type": "text/html" }
          })
      }),
    /pdf/i
  );
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
