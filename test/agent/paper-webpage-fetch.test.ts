import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fetchPaperWebPage,
  parsePaperWebPageHtml
} from "../../src/agent/paper-webpage-fetch.js";
import { savePaperWebPageParse } from "../../src/agent/paper-reader/engines/webpage.js";
import {
  inspectPaper,
  readPaperSection,
  searchPaperText
} from "../../src/agent/paper-reader/paper-reader.js";

function createHtmlResponse(status: number, body: string, contentType = "text/html; charset=utf-8") {
  return new Response(body, {
    status,
    headers: { "content-type": contentType }
  });
}

test("parsePaperWebPageHtml extracts article text and filters navigation noise", () => {
  const html = `
    <html>
      <head>
        <title>Browser title</title>
        <meta name="citation_title" content="Cosmic-ray-induced correlated errors">
        <meta name="citation_doi" content="10.1038/s41467-025-59778-z">
        <meta name="citation_journal_title" content="Nature Communications">
        <meta name="citation_author" content="Xuegang Li">
        <meta name="citation_author" content="Junhua Wang">
      </head>
      <body>
        <header>Nature Portfolio Subscribe Log in</header>
        <nav>Skip to main content Subjects Explore content</nav>
        <article>
          <div class="c-article-header">
            <h1>Cosmic-ray-induced correlated errors</h1>
          </div>
          <section>
            <h2>Abstract</h2>
            <p>Muon events and gamma radiation produce correlated quasiparticle poisoning.</p>
          </section>
          <aside class="related">Related articles</aside>
          <section>
            <h2>Results</h2>
            <p>${"A".repeat(13_500)}</p>
          </section>
          <figure>
            <figcaption>Fig. 1 | Correlated errors in a qubit array.</figcaption>
          </figure>
          <section>
            <h2>Data availability</h2>
            <p>All data are available from the corresponding author.</p>
          </section>
        </article>
        <footer>Springer Nature Rights and permissions</footer>
      </body>
    </html>
  `;

  const result = parsePaperWebPageHtml({
    url: "https://www.nature.com/articles/s41467-025-59778-z",
    html
  });

  assert.equal(result.title, "Cosmic-ray-induced correlated errors");
  assert.equal(result.metadata.doi, "10.1038/s41467-025-59778-z");
  assert.equal(result.metadata.journal, "Nature Communications");
  assert.deepEqual(result.metadata.authors, ["Xuegang Li", "Junhua Wang"]);
  assert.equal(result.access.status, "full_text");
  assert.equal(result.stats.extractedFrom, "article");
  assert.match(result.markdown, /# Cosmic-ray-induced correlated errors/);
  assert.match(result.markdown, /## Abstract/);
  assert.match(result.markdown, /## Results/);
  assert.match(result.markdown, /## Data availability/);
  assert.match(result.markdown, /Fig\. 1/);
  assert.ok(result.markdown.includes("A".repeat(13_500)));
  assert.ok(result.markdown.length > 13_500);
  assert.doesNotMatch(result.markdown, /Skip to main content/i);
  assert.doesNotMatch(result.markdown, /Subscribe/i);
  assert.doesNotMatch(result.markdown, /Related articles/i);
  assert.doesNotMatch(result.markdown, /Springer Nature/i);
});

test("fetchPaperWebPage rejects non-html responses", async () => {
  await assert.rejects(
    () =>
      fetchPaperWebPage({
        url: "https://example.test/article",
        fetchImpl: async () =>
          createHtmlResponse(200, "{\"ok\":true}", "application/json; charset=utf-8")
      }),
    /html/i
  );
});

test("Science webpage parsing removes access chrome and flags abstract-only pages", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-science-webpage-"));
  try {
    const extraction = parsePaperWebPageHtml({
      url: "https://www.science.org/doi/10.1126/science.adz8659",
      html: `
        <html>
          <head>
            <meta name="citation_title" content="Challenges and opportunities for quantum information hardware">
            <meta name="citation_doi" content="10.1126/science.adz8659">
          </head>
          <body>
            <main>
              <h2>Abstract</h2>
              <p>Quantum technologies have made impressive progress over the past decade.</p>
              <h2>Access the full article</h2>
              <p>View all access options to continue reading this article.</p>
              <p>CHECK ACCESS</p>
              <h2>Supplementary Materials</h2>
              <p>Supplementary Text</p>
              <h2>References and Notes</h2>
              <p>${"Reference metadata ".repeat(220)}</p>
              <h3>Submit a Response to This Article</h3>
              <h2>(0) eLetters</h2>
              <h3>Information</h3>
              <p>Log in to view the full text</p>
              <h3>Citations</h3>
              <p>Loading...</p>
              <h3>View options</h3>
              <p>PDF format</p>
            </main>
          </body>
        </html>
      `
    });

    assert.match(extraction.markdown, /## Abstract/);
    assert.match(extraction.markdown, /## References and Notes/);
    assert.equal(extraction.access.status, "access_limited");
    assert.ok(extraction.access.signals.includes("access_full_article"));
    assert.match(extraction.access.message ?? "", /log in/i);
    assert.doesNotMatch(extraction.markdown, /Access the full article/i);
    assert.doesNotMatch(extraction.markdown, /CHECK ACCESS/i);
    assert.doesNotMatch(extraction.markdown, /Submit a Response/i);
    assert.doesNotMatch(extraction.markdown, /Log in to view the full text/i);
    assert.doesNotMatch(extraction.markdown, /View options/i);

    const result = await savePaperWebPageParse({
      workspaceDir: workspace,
      extraction
    });

    assert.equal(result.quality.status, "needs_hybrid");
    assert.ok(
      result.quality.warnings.some((warning) =>
        warning.includes("Ask the user to log in")
      )
    );
    assert.ok(
      result.quality.warnings.some((warning) =>
        warning.includes("No main body sections were detected")
      )
    );
    assert.ok(
      result.quality.warnings.some((warning) =>
        warning.includes("References dominate")
      )
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("savePaperWebPageParse writes webpage artifacts under wiki sources", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-webpage-"));
  try {
    const extraction = parsePaperWebPageHtml({
      url: "https://www.nature.com/articles/s41467-025-59778-z",
      html: `
        <html>
          <head>
            <meta name="citation_title" content="Cosmic-ray-induced correlated errors">
            <meta name="citation_doi" content="10.1038/s41467-025-59778-z">
          </head>
          <body>
            <main data-track-component="article body">
              <h1>Cosmic-ray-induced correlated errors</h1>
              <section data-title="Abstract">
                <h2>Abstract</h2>
                <p>Muon bursts can induce correlated qubit errors.</p>
              </section>
              <section data-title="Methods">
                <h2>Methods</h2>
                <p>The webpage parser keeps full article text.</p>
              </section>
              <section data-title="References">
                <h2>References</h2>
                <p>1. Example reference.</p>
              </section>
            </main>
          </body>
        </html>
      `
    });

    const result = await savePaperWebPageParse({
      workspaceDir: workspace,
      extraction
    });

    assert.equal(result.status, "parsed");
    assert.equal(result.paperKey, "nature-s41467-025-59778-z");
    assert.equal(result.engine, "webpage");
    assert.match(result.artifacts.markdownPath, /knowledge-base\/wiki\/sources\/nature-s41467-025-59778-z\/parses\/webpage\/document\.md$/);
    assert.match(result.artifacts.parsePath, /knowledge-base\/wiki\/sources\/nature-s41467-025-59778-z\/parses\/webpage\/parse\.json$/);
    assert.match(result.artifacts.chunksPath, /knowledge-base\/wiki\/sources\/nature-s41467-025-59778-z\/chunks\/webpage\.jsonl$/);

    const markdown = await readFile(result.artifacts.markdownPath, "utf8");
    assert.match(markdown, /## Methods/);
    const parseJson = JSON.parse(await readFile(result.artifacts.parsePath, "utf8")) as {
      engine: string;
      sections: Array<{ title: string }>;
    };
    assert.equal(parseJson.engine, "webpage");
    assert.ok(parseJson.sections.some((section) => section.title === "Methods"));

    const inspection = await inspectPaper({
      workspaceDir: workspace,
      paperKey: result.paperKey
    });
    assert.ok(inspection.parses.some((parse) => parse.engine === "webpage"));

    const section = await readPaperSection({
      workspaceDir: workspace,
      paperKey: result.paperKey,
      engine: "webpage",
      sectionId: "section-methods"
    });
    assert.match(section.text, /webpage parser keeps full article text/);

    const search = await searchPaperText({
      workspaceDir: workspace,
      paperKey: result.paperKey,
      engine: "webpage",
      query: "Muon"
    });
    assert.equal(search.results.length, 1);

    const cached = await savePaperWebPageParse({
      workspaceDir: workspace,
      extraction
    });
    assert.equal(cached.status, "already_parsed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
