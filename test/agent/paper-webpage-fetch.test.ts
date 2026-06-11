import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  diagnosePaperWebPageHtml,
  fetchPaperWebPage,
  parsePaperWebPageHtml,
  parsePaperWebPageHtmlWithPandoc
} from "../../src/agent/paper/acquisition/paper-webpage-fetch.js";
import { savePaperWebPageParse } from "../../src/agent/paper/reading/engines/webpage.js";
import {
  inspectPaper,
  readPaperSection,
  searchPaperText
} from "../../src/agent/paper/reading/paper-reader.js";

function createHtmlResponse(status: number, body: string, contentType = "text/html; charset=utf-8") {
  return new Response(body, {
    status,
    headers: { "content-type": contentType }
  });
}

async function writeExecutableScript(workspace: string, filename: string, source: string): Promise<string> {
  const scriptPath = path.join(workspace, filename);
  await writeFile(scriptPath, source, "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
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

test("parsePaperWebPageHtml preserves rendered MathJax formula text", () => {
  const formula = "\\Gamma=\\Gamma_{1,D}/2+\\Gamma_{\\phi,D}+\\Gamma_{1,Q}/2+\\Gamma_{\\phi,Q}";
  const extraction = parsePaperWebPageHtml({
    url: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    html: `
      <html>
        <head>
          <meta name="citation_title" content="APS Formula Article">
          <meta name="citation_doi" content="10.1103/PhysRevLett.111.080502">
        </head>
        <body>
          <main data-track-component="article body">
            <h1>APS Formula Article</h1>
            <section>
              <h2>Article Text</h2>
              <p>
                with detuning
                <span class="inline-formula">
                  <mjx-container>
                    <mjx-assistive-mml>
                      <math><semantics><annotation encoding="application/x-tex">\\Delta</annotation></semantics></math>
                    </mjx-assistive-mml>
                  </mjx-container>
                </span>,
                and
                <span class="inline-formula">
                  <mjx-container>
                    <mjx-assistive-mml>
                      <math><semantics><annotation encoding="application/x-tex">${formula}</annotation></semantics></math>
                    </mjx-assistive-mml>
                  </mjx-container>
                </span>.
              </p>
            </section>
          </main>
        </body>
      </html>
    `
  });

  assert.match(extraction.markdown, /with detuning[\s\S]*\$\\Delta\$[\s\S]*and[\s\S]*\$\\Gamma=\\Gamma_\{1,D\}/);
  assert.match(extraction.snapshotHtml ?? "", /<span class="math-formula" data-math-format="latex">\$\\Delta\$<\/span>/);
  assert.match(extraction.snapshotHtml ?? "", /\\Gamma_\{\\phi,D\}/);
  assert.match(extraction.snapshotHtml ?? "", /cdn\.jsdelivr\.net\/npm\/katex@/);
  assert.match(extraction.snapshotHtml ?? "", /renderMathInElement\(document\.body/);
  assert.doesNotMatch(extraction.snapshotHtml ?? "", /mjx-lazy/);
});

test("parsePaperWebPageHtml preserves APS MathJax semantic speech formulas", () => {
  const extraction = parsePaperWebPageHtml({
    url: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    html: `
      <html>
        <head>
          <meta name="citation_title" content="APS Semantic Formula Article">
          <meta name="citation_doi" content="10.1103/PhysRevLett.111.080502">
        </head>
        <body>
          <main data-track-component="article body">
            <h1>APS Semantic Formula Article</h1>
            <section>
              <h2>Article Text</h2>
              <p>
                with detuning
                <span class="inline-formula">
                  <mjx-container class="MathJax" data-semantic-speech-none="Delta">
                    <mjx-math><mjx-mi><mjx-c>𝛥</mjx-c></mjx-mi></mjx-math>
                    <mjx-speech aria-label="Delta, math" role="img"></mjx-speech>
                  </mjx-container>
                </span>,
                and
                <span class="inline-formula">
                  <mjx-container class="MathJax" data-semantic-speech-none="Gamma equals Gamma sub 1 comma D divided by 2 plus Gamma sub phi comma D plus Gamma sub 1 comma Q divided by 2 plus Gamma sub phi comma Q">
                    <mjx-math><mjx-mi><mjx-c>𝛤</mjx-c></mjx-mi></mjx-math>
                    <mjx-speech aria-label="Gamma equals Gamma sub 1 comma D divided by 2 plus Gamma sub phi comma D plus Gamma sub 1 comma Q divided by 2 plus Gamma sub phi comma Q, math" role="img"></mjx-speech>
                  </mjx-container>
                </span>.
              </p>
            </section>
          </main>
        </body>
      </html>
    `
  });

  assert.match(
    extraction.markdown,
    /with detuning[\s\S]*\$\\Delta\$[\s\S]*and[\s\S]*\$\\Gamma = \\Gamma_\{1,D\}\/2 \+ \\Gamma_\{\\phi,D\} \+ \\Gamma_\{1,Q\}\/2 \+ \\Gamma_\{\\phi,Q\}\$/
  );
  assert.doesNotMatch(extraction.markdown, /data-semantic|speech-attached|braille-attached/);
  assert.match(
    extraction.snapshotHtml ?? "",
    /<span class="math-formula" data-math-format="latex" data-math-speech="Delta">\$\\Delta\$<\/span>/
  );
  assert.match(
    extraction.snapshotHtml ?? "",
    /\$\\Gamma = \\Gamma_\{1,D\}\/2 \+ \\Gamma_\{\\phi,D\} \+ \\Gamma_\{1,Q\}\/2 \+ \\Gamma_\{\\phi,Q\}\$/
  );
  assert.match(extraction.snapshotHtml ?? "", /data-math-speech="Gamma equals Gamma sub 1 comma D divided by 2/);
});

test("parsePaperWebPageHtml upgrades saved math-formula speech spans to LaTeX", () => {
  const extraction = parsePaperWebPageHtml({
    url: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    html: `
      <html>
        <head><meta name="citation_title" content="APS Saved Formula Article"></head>
        <body>
          <main data-track-component="article body">
            <h1>APS Saved Formula Article</h1>
            <p>
              with detuning
              <span class="inline-formula"><span class="math-formula">triangle</span></span>,
              and
              <span class="inline-formula"><span class="math-formula">Gamma equals Gamma sub 1 comma D divided by 2 plus Gamma sub phi comma D plus Gamma sub 1 comma Q divided by 2 plus Gamma sub phi comma Q</span></span>.
            </p>
          </main>
        </body>
      </html>
    `
  });

  assert.match(extraction.markdown, /\$\\Delta\$/);
  assert.match(extraction.markdown, /\$\\Gamma = \\Gamma_\{1,D\}\/2 \+ \\Gamma_\{\\phi,D\}/);
  assert.match(extraction.snapshotHtml ?? "", /data-math-speech="triangle"/);
});

test("parsePaperWebPageHtml converts MathML formulas before semantic speech fallback", () => {
  const extraction = parsePaperWebPageHtml({
    url: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    html: `
      <html>
        <head><meta name="citation_title" content="APS MathML Formula Article"></head>
        <body>
          <main data-track-component="article body">
            <h1>APS MathML Formula Article</h1>
            <p>
              The distribution is
              <span class="inline-formula">
                <mjx-container class="MathJax" data-semantic-speech-none="rho sub 0 the square root of 1 minus p squared divided by p sub max squared divided by p">
                  <mjx-assistive-mml>
                    <math xmlns="http://www.w3.org/1998/Math/MathML" display="inline">
                      <mrow>
                        <msub><mi>&#x3C1;</mi><mn>0</mn></msub>
                        <mo>&#x2062;</mo>
                        <msqrt>
                          <mrow>
                            <mn>1</mn>
                            <mo>-</mo>
                            <mrow>
                              <msup><mi>p</mi><mn>2</mn></msup>
                              <mo>/</mo>
                              <msubsup>
                                <mi>p</mi>
                                <mrow><mi>max</mi><mo>&#x2061;</mo></mrow>
                                <mn>2</mn>
                              </msubsup>
                            </mrow>
                          </mrow>
                        </msqrt>
                      </mrow>
                      <mo>/</mo>
                      <mi>p</mi>
                    </math>
                  </mjx-assistive-mml>
                </mjx-container>
              </span>.
            </p>
          </main>
        </body>
      </html>
    `
  });

  assert.match(extraction.markdown, /\$\\rho_\{0\} \\sqrt\{1 - p\^\{2\}\/p_\{max\}\^\{2\}\}\/p\$/);
  assert.doesNotMatch(extraction.markdown, /rho sub 0 the square root/);
  assert.match(extraction.snapshotHtml ?? "", /data-math-format="mathml"/);
  assert.match(extraction.snapshotHtml ?? "", /<math\b/);
});

test("parsePaperWebPageHtml keeps MathML formulas renderable in HTML snapshots", () => {
  const extraction = parsePaperWebPageHtml({
    url: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    html: `
      <html>
        <head><meta name="citation_title" content="APS Native MathML Article"></head>
        <body>
          <main data-track-component="article body">
            <h1>APS Native MathML Article</h1>
            <p>
              Energy
              <span class="inline-formula">
                <mjx-container class="MathJax" data-semantic-speech-none="E equals B divided by the square root of x">
                  <mjx-assistive-mml>
                    <math xmlns="http://www.w3.org/1998/Math/MathML" display="inline">
                      <mi>E</mi>
                      <mo>=</mo>
                      <mfrac>
                        <mi>B</mi>
                        <msqrt><mi>x</mi></msqrt>
                      </mfrac>
                    </math>
                  </mjx-assistive-mml>
                </mjx-container>
              </span>
            </p>
          </main>
        </body>
      </html>
    `
  });

  assert.match(extraction.markdown, /\$E\s*=\s*\\frac\{B\}\{\\sqrt\{x\}\}\$/);
  assert.match(extraction.snapshotHtml ?? "", /<math\b[^>]*display="inline"/);
  assert.match(extraction.snapshotHtml ?? "", /<mfrac>/);
  assert.match(extraction.snapshotHtml ?? "", /data-math-format="mathml"/);
  assert.match(extraction.snapshotHtml ?? "", /data-latex="\$E\s*=\s*\\frac\{B\}\{\\sqrt\{x\}\}\$"/);
  assert.doesNotMatch(extraction.snapshotHtml ?? "", /<span class="math-formula" data-math-format="latex">\$E=\\frac/);
});

test("parsePaperWebPageHtml converts negative speech token to a minus sign", () => {
  const extraction = parsePaperWebPageHtml({
    url: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    html: `
      <html>
        <head><meta name="citation_title" content="APS Negative Formula Article"></head>
        <body>
          <main data-track-component="article body">
            <h1>APS Negative Formula Article</h1>
            <p>
              pulse
              <span class="inline-formula">
                <mjx-container class="MathJax" data-semantic-speech-none="X sub negative pi divided by 2"></mjx-container>
              </span>
            </p>
          </main>
        </body>
      </html>
    `
  });

  assert.match(extraction.markdown, /\$X_\{-\\pi\}\/2\$/);
  assert.doesNotMatch(extraction.markdown, /negative/);
});

test("parsePaperWebPageHtml converts complex APS semantic speech formulas to LaTeX", () => {
  const extraction = parsePaperWebPageHtml({
    url: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
    html: `
      <html>
        <head><meta name="citation_title" content="APS Complex Speech Formula Article"></head>
        <body>
          <main data-track-component="article body">
            <h1>APS Complex Speech Formula Article</h1>
            <p>
              distribution
              <span class="inline-formula">
                <mjx-container class="MathJax" data-semantic-speech-none="rho sub 0 the square root of 1 minus p squared divided by p sub max squared divided by p"></mjx-container>
              </span>
              and count
              <span class="inline-formula">
                <mjx-container class="MathJax" display="true" data-semantic-speech-none="N equals the double integral of rho sub 0 the fraction with numerator the square root of 1 minus p squared divided by p sub max squared and denominator p Theta times open bracket p times the absolute value of E of open paren r right arrow close paren minus g sub min close bracket d p d r right arrow comma"></mjx-container>
              </span>.
            </p>
          </main>
        </body>
      </html>
    `
  });

  assert.match(extraction.markdown, /\$\\rho_\{0\}\\sqrt\{1 - p\^2\/p_\{max\}\^2\}\/p\$/);
  assert.match(
    extraction.markdown,
    /\$\$N = \\iint \\rho_\{0\}\\frac\{\\sqrt\{1 - p\^2\/p_\{max\}\^2\}\}\{p\}\\Theta\[p\|E\(\\vec\{r\}\)\| - g_\{min\}\]\\,dp\\,d\\vec\{r\},\$\$/
  );
  assert.doesNotMatch(extraction.markdown, /square root|double integral|right arrow/);
  assert.match(extraction.snapshotHtml ?? "", /data-math-speech="rho sub 0 the square root/);
  assert.match(extraction.snapshotHtml ?? "", /data-math-format="latex"/);
});

test("parsePaperWebPageHtmlWithPandoc converts filtered article HTML through pandoc", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-webpage-pandoc-"));
  const pandocInputPath = path.join(workspace, "pandoc-input.html");
  try {
    const pandocBin = await writeExecutableScript(workspace, "fake-pandoc", `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output") + 1];
const input = args[args.length - 1];
const html = fs.readFileSync(input, "utf8");
fs.writeFileSync(${JSON.stringify(pandocInputPath)}, html);
fs.writeFileSync(output, [
  "# Pandoc Article",
  "",
  "Pandoc preserved [citation link](https://doi.org/10.1234/example).",
  "",
  "| Col A | Col B |",
  "| --- | --- |",
  "| alpha | beta |"
].join("\\n"));
`);
    const extraction = await parsePaperWebPageHtmlWithPandoc({
      url: "https://journals.aps.org/prl/abstract/10.1103/example",
      html: `
        <html>
          <head>
            <meta name="citation_title" content="Pandoc Article">
            <meta name="citation_doi" content="10.1103/example">
          </head>
          <body>
            <header>Skip to main content</header>
            <article>
              <h1>Pandoc Article</h1>
              <aside class="related">Related articles</aside>
              <table><tr><th>Col A</th><th>Col B</th></tr><tr><td>alpha</td><td>beta</td></tr></table>
            </article>
          </body>
        </html>
      `,
      pandocBin
    });

    assert.match(extraction.markdown, /# Pandoc Article/);
    assert.match(extraction.markdown, /\| Col A \| Col B \|/);
    assert.match(extraction.markdown, /citation link/);
    assert.doesNotMatch(extraction.markdown, /Related articles/);
    assert.doesNotMatch(await readFile(pandocInputPath, "utf8"), /Related articles|Skip to main content/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("parsePaperWebPageHtmlWithPandoc restores math placeholders after pandoc conversion", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-webpage-pandoc-math-"));
  const pandocInputPath = path.join(workspace, "pandoc-input.html");
  try {
    const pandocBin = await writeExecutableScript(workspace, "fake-pandoc", `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output") + 1];
const input = args[args.length - 1];
const html = fs.readFileSync(input, "utf8");
fs.writeFileSync(${JSON.stringify(pandocInputPath)}, html);
fs.writeFileSync(output, "Formula PIAGENTMATH0 and PIAGENTMATH1.");
`);
    const extraction = await parsePaperWebPageHtmlWithPandoc({
      url: "https://journals.aps.org/prl/abstract/10.1103/example",
      html: `
        <html>
          <head><meta name="citation_title" content="Pandoc Math Article"></head>
          <body>
            <article>
              <h1>Pandoc Math Article</h1>
              <p>
                Formula
                <span class="math-formula" data-math-format="latex">$T_{2}^{*}$</span>
                and
                <span class="math-formula" data-math-format="latex">$\\rho_{0}\\sqrt{1 - p^2/p_{max}^2}/p$</span>.
              </p>
            </article>
          </body>
        </html>
      `,
      pandocBin
    });

    assert.match(await readFile(pandocInputPath, "utf8"), /PIAGENTMATH0/);
    assert.doesNotMatch(await readFile(pandocInputPath, "utf8"), /\$T_\{2\}/);
    assert.equal(
      extraction.markdown,
      "Formula $T_{2}^{*}$ and $\\rho_{0}\\sqrt{1 - p^2/p_{max}^2}/p$."
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("parsePaperWebPageHtmlWithPandoc cleans arXiv LaTeXML raw HTML left by pandoc", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-webpage-arxiv-latexml-"));
  try {
    const pandocBin = await writeExecutableScript(workspace, "fake-pandoc", `#!/usr/bin/env node
const fs = require("node:fs");
const output = process.argv[process.argv.indexOf("--output") + 1];
fs.writeFileSync(output, [
  "<div class=\\"ltx_page_main\\">",
  "# arXiv LaTeXML Paper",
  "",
  "## <span class=\\"ltx_tag ltx_tag_section\\">I </span>Introduction",
  "",
  "A <span class=\\"ltx_text ltx_font_italic\\">good</span> result [<a class=\\"ltx_ref\\" href=\\"#bib.bib1\\">1</a>].",
  "",
  "<figure class=\\"ltx_figure\\"><img src=\\"/html/2507.09690v3/Fig1.png\\" alt=\\"Figure 1\\" /><figcaption><span class=\\"ltx_tag\\">Figure 1: </span>Caption.</figcaption></figure>",
  "</div>"
].join("\\n"));
`);
    const extraction = await parsePaperWebPageHtmlWithPandoc({
      url: "https://arxiv.org/html/2507.09690",
      html: `
        <html>
          <body>
            <article class="ltx_document">
              <h1>arXiv LaTeXML Paper</h1>
              <section class="ltx_section"><h2>Introduction</h2></section>
            </article>
          </body>
        </html>
      `,
      pandocBin
    });

    assert.match(extraction.markdown, /# arXiv LaTeXML Paper/);
    assert.match(extraction.markdown, /## I Introduction/);
    assert.match(extraction.markdown, /A good result \[1\]\./);
    assert.match(extraction.markdown, /!\[Figure 1]\(\/html\/2507\.09690v3\/Fig1\.png\)/);
    assert.doesNotMatch(extraction.markdown, /<span|<div|<a\b|ltx_/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
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

test("fetchPaperWebPage downloads direct HTML image assets", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-webpage-direct-assets-"));
  const requestedUrls: string[] = [];
  try {
    const extraction = await fetchPaperWebPage({
      url: "https://arxiv.org/html/2601.00425",
      fetchImpl: async (input) => {
        const url = input.toString();
        requestedUrls.push(url);
        if (url === "https://arxiv.org/html/2601.00425") {
          return createHtmlResponse(
            200,
            `
              <html>
                <head><meta name="citation_title" content="arXiv image article"></head>
                <body>
                  <article>
                    <h1>arXiv image article</h1>
                    <p>${"Article body. ".repeat(200)}</p>
                    <figure>
                      <img src="x1.png" alt="Figure 1">
                      <figcaption>Figure 1: Local figure.</figcaption>
                    </figure>
                  </article>
                </body>
              </html>
            `
          );
        }
        if (url === "https://arxiv.org/html/2601.00425/x1.png") {
          return new Response(Buffer.from("png-bytes"), {
            status: 200,
            headers: { "content-type": "image/png" }
          });
        }
        if (url === "https://arxiv.org/abs/2601.00425") {
          return createHtmlResponse(
            200,
            `
              <html>
                <body>
                  <table>
                    <tr>
                      <td class="tablecell label">Comments:</td>
                      <td class="tablecell comments">12 pages, 1 figure</td>
                    </tr>
                  </table>
                </body>
              </html>
            `
          );
        }
        return new Response("missing", { status: 404 });
      }
    });

    assert.equal(extraction.assets?.length, 1);
    assert.equal(extraction.assets?.[0]?.filename, "x1.png");
    assert.equal(extraction.metadata.comments, "12 pages, 1 figure");
    assert.equal(extraction.metadata.expectedFigureCount, 1);
    assert.ok(requestedUrls.includes("https://arxiv.org/html/2601.00425/x1.png"));

    const result = await savePaperWebPageParse({
      workspaceDir: workspace,
      extraction,
      paperKey: "arxiv-2601.00425"
    });
    const markdown = await readFile(result.artifacts.markdownPath, "utf8");
    assert.match(markdown, /assets\/x1\.png/);
    assert.doesNotMatch(markdown, /assets\/assets\//);
    const assetPath = path.join(
      workspace,
      "knowledge-base", "sources",
      "arxiv-2601.00425",
      "parses",
      "webpage",
      "assets",
      "x1.png"
    );
    assert.equal(await readFile(assetPath, "utf8"), "png-bytes");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("savePaperWebPageParse rewrites root-relative arXiv asset links to local assets", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-webpage-arxiv-root-assets-"));
  try {
    const extraction = parsePaperWebPageHtml({
      url: "https://arxiv.org/html/2203.11451",
      html: `
        <html>
          <head><meta name="citation_title" content="arXiv root-relative assets"></head>
          <body>
            <article>
              <h1>arXiv root-relative assets</h1>
              <p>${"Article body. ".repeat(200)}</p>
              <figure>
                <img src="/html/2203.11451/assets/x5.png" alt="Figure 5">
                <figcaption>Figure 5: Root-relative figure.</figcaption>
              </figure>
            </article>
          </body>
        </html>
      `
    });

    const result = await savePaperWebPageParse({
      workspaceDir: workspace,
      paperKey: "arxiv-2203.11451",
      extraction: {
        ...extraction,
        metadata: {
          ...extraction.metadata,
          comments: "14 pages, 1 figure",
          expectedFigureCount: 1
        },
        assets: [
          {
            url: "https://arxiv.org/html/2203.11451/assets/x5.png",
            originalUrl: "/html/2203.11451/assets/x5.png",
            filename: "x5.png",
            mimeType: "image/png",
            dataBase64: Buffer.from("png-5").toString("base64")
          }
        ]
      }
    });

    const markdown = await readFile(result.artifacts.markdownPath, "utf8");
    const html = await readFile(path.join(path.dirname(result.artifacts.markdownPath), "document.html"), "utf8");
    assert.match(markdown, /!\[[^\]]*]\(assets\/x5\.png\)/);
    assert.doesNotMatch(markdown, /\/html\/2203\.11451\/assets\/x5\.png/);
    assert.match(html, /src="assets\/x5\.png"/);
    assert.equal(result.quality.status, "good");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("savePaperWebPageParse rewrites bare arXiv image links to local assets", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-webpage-arxiv-bare-assets-"));
  try {
    const extraction = parsePaperWebPageHtml({
      url: "https://arxiv.org/html/2409.04967",
      html: `
        <html>
          <head><meta name="citation_title" content="arXiv bare assets"></head>
          <body>
            <article>
              <h1>arXiv bare assets</h1>
              <p>${"Article body. ".repeat(200)}</p>
              <figure>
                <img src="x8.png" alt="Figure A1">
                <figcaption>Figure A1: Bare figure.</figcaption>
              </figure>
            </article>
          </body>
        </html>
      `
    });

    const result = await savePaperWebPageParse({
      workspaceDir: workspace,
      paperKey: "arxiv-2409.04967",
      extraction: {
        ...extraction,
        metadata: {
          ...extraction.metadata,
          comments: "27 pages, 1 figure",
          expectedFigureCount: 1
        },
        assets: [
          {
            url: "https://arxiv.org/html/2409.04967/x8.png",
            originalUrl: "x8.png",
            filename: "x8.png",
            mimeType: "image/png",
            dataBase64: Buffer.from("png-8").toString("base64")
          }
        ]
      }
    });

    const markdown = await readFile(result.artifacts.markdownPath, "utf8");
    const html = await readFile(path.join(path.dirname(result.artifacts.markdownPath), "document.html"), "utf8");
    assert.match(markdown, /!\[[^\]]*]\(assets\/x8\.png\)/);
    assert.doesNotMatch(markdown, /\(x8\.png\)/);
    assert.match(html, /src="assets\/x8\.png"/);
    assert.equal(result.quality.status, "good");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fetchPaperWebPage does not let one slow arXiv image prevent later image assets", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-webpage-arxiv-assets-timeout-"));
  const requestedUrls: string[] = [];
  try {
    const extraction = await fetchPaperWebPage({
      url: "https://arxiv.org/html/2601.00425v1",
      env: {
        ...process.env,
        PI_FETCH_TIMEOUT_MS: "30"
      },
      fetchImpl: async (input, init) => {
        const url = input.toString();
        requestedUrls.push(url);
        if (url === "https://arxiv.org/html/2601.00425v1") {
          return createHtmlResponse(
            200,
            `
              <html>
                <head><meta name="citation_title" content="arXiv image article"></head>
                <body>
                  <article>
                    <h1>arXiv image article</h1>
                    <p>${"Article body. ".repeat(200)}</p>
                    ${Array.from({ length: 8 }, (_value, index) => `
                      <figure>
                        <img src="x${index + 1}.png" alt="Figure ${index + 1}">
                        <figcaption>Figure ${index + 1}: Local figure.</figcaption>
                      </figure>
                    `).join("\n")}
                  </article>
                </body>
              </html>
            `
          );
        }
        if (url === "https://arxiv.org/abs/2601.00425") {
          return createHtmlResponse(200, `<td class="tablecell comments">12 pages, 8 figures</td>`);
        }
        if (url === "https://arxiv.org/html/2601.00425v1/x1.png") {
          const signal = init?.signal as AbortSignal | undefined;
          return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          });
        }
        const imageMatch = url.match(/^https:\/\/arxiv\.org\/html\/2601\.00425v1\/x([2-8])\.png$/);
        if (imageMatch?.[1]) {
          return new Response(Buffer.from(`png-${imageMatch[1]}`), {
            status: 200,
            headers: { "content-type": "image/png" }
          });
        }
        return new Response("missing", { status: 404 });
      }
    });

    assert.equal(extraction.assets?.length, 7);
    for (let index = 1; index <= 8; index += 1) {
      assert.ok(requestedUrls.includes(`https://arxiv.org/html/2601.00425v1/x${index}.png`));
    }

    const result = await savePaperWebPageParse({
      workspaceDir: workspace,
      extraction,
      paperKey: "arxiv-2601.00425"
    });
    const assetDir = path.join(path.dirname(result.artifacts.markdownPath), "assets");
    assert.deepEqual(await readdir(assetDir), [
      "x2.png",
      "x3.png",
      "x4.png",
      "x5.png",
      "x6.png",
      "x7.png",
      "x8.png"
    ]);
    const markdown = await readFile(result.artifacts.markdownPath, "utf8");
    assert.match(markdown, /assets\/x8\.png/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("savePaperWebPageParse warns when arXiv comments report missing figures", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-webpage-arxiv-figure-warning-"));
  try {
    const extraction = parsePaperWebPageHtml({
      url: "https://arxiv.org/html/2507.09690",
      html: `
        <html>
          <head><meta name="citation_title" content="arXiv figure check"></head>
          <body>
            <article>
              <h1>arXiv figure check</h1>
              <h2>Introduction</h2>
              <p>${"Article body. ".repeat(200)}</p>
              <p>Figure 1: First figure.</p>
            </article>
          </body>
        </html>
      `
    });

    const result = await savePaperWebPageParse({
      workspaceDir: workspace,
      paperKey: "arxiv-2507.09690",
      extraction: {
        ...extraction,
        metadata: {
          ...extraction.metadata,
          comments: "16 pages, 8 figures",
          expectedFigureCount: 8
        },
        assets: [
          {
            url: "https://arxiv.org/html/2507.09690/x1.png",
            filename: "x1.png",
            mimeType: "image/png",
            dataBase64: Buffer.from("png-bytes").toString("base64")
          }
        ]
      }
    });

    assert.equal(result.quality.status, "needs_hybrid");
    assert.ok(result.quality.score < 0.7);
    assert.ok(
      result.quality.warnings.some((warning) =>
        warning.includes("arXiv comments report 8 figures")
      )
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("savePaperWebPageParse downgrades webpage markdown with substantial raw HTML", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-webpage-raw-html-quality-"));
  try {
    const result = await savePaperWebPageParse({
      workspaceDir: workspace,
      paperKey: "arxiv-raw-html",
      extraction: {
        url: "https://arxiv.org/html/2507.09690",
        title: "Raw HTML paper",
        markdown: [
          "# Raw HTML paper",
          "",
          "## Introduction",
          "",
          `${'<span class="ltx_text">raw</span> '.repeat(30)}${"article body ".repeat(250)}`
        ].join("\n"),
        metadata: {
          title: "Raw HTML paper",
          authors: []
        },
        access: {
          status: "full_text",
          signals: []
        },
        stats: {
          chars: 5000,
          wordsApprox: 800,
          navigationLinesRemoved: 0,
          extractedFrom: "article"
        }
      }
    });

    assert.equal(result.quality.status, "needs_hybrid");
    assert.ok(result.quality.score < 0.7);
    assert.ok(
      result.quality.warnings.some((warning) =>
        warning.includes("substantial raw HTML markup")
      )
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("savePaperWebPageParse downgrades APS snapshots with unresolved lazy MathJax", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-webpage-aps-lazy-mathjax-"));
  try {
    const articleBody = "Superconducting qubit coherence and control are discussed with experimental evidence. ".repeat(180);
    const result = await savePaperWebPageParse({
      workspaceDir: workspace,
      paperKey: "aps-10.1103-PhysRevLett.111.080502",
      extraction: {
        url: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502#fulltext",
        title: "Coherent Josephson Qubit Suitable for Scalable Quantum Integrated Circuits",
        snapshotHtml: `
          <main>
            <h1>Coherent Josephson Qubit Suitable for Scalable Quantum Integrated Circuits</h1>
            <section><h2>Article Text</h2><p>with detuning <mjx-container><mjx-lazy data-mjx-lazy="115"></mjx-lazy></mjx-container>, and <mjx-container><mjx-lazy data-mjx-lazy="116"></mjx-lazy></mjx-container>.</p></section>
          </main>
        `,
        markdown: [
          "# Coherent Josephson Qubit Suitable for Scalable Quantum Integrated Circuits",
          "",
          "## Article Text",
          "",
          articleBody,
          "",
          "with detuning, and. Hence, each uncorrelated defect adds a single Lorentzian.",
          "",
          "## References",
          "",
          "1. Reference."
        ].join("\n"),
        metadata: {
          title: "Coherent Josephson Qubit Suitable for Scalable Quantum Integrated Circuits",
          doi: "10.1103/PhysRevLett.111.080502",
          authors: []
        },
        access: {
          status: "full_text",
          signals: []
        },
        stats: {
          chars: articleBody.length,
          wordsApprox: 1600,
          navigationLinesRemoved: 0,
          extractedFrom: "article"
        }
      }
    });

    assert.equal(result.quality.status, "needs_hybrid");
    assert.ok(result.quality.score < 0.7);
    assert.ok(
      result.quality.warnings.some((warning) =>
        warning.includes("unresolved MathJax lazy placeholders")
      )
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("savePaperWebPageParse strips publisher raw HTML wrappers before quality scoring", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-webpage-nature-html-cleanup-"));
  try {
    const body = "Subharmonic drives support fast superconducting qubit control while limiting cryostat heating. ".repeat(180);
    const result = await savePaperWebPageParse({
      workspaceDir: workspace,
      paperKey: "nature-s41467-025-67766-6",
      extraction: {
        url: "https://www.nature.com/articles/s41467-025-67766-6",
        title: "Fast superconducting qubit control with subharmonic drives",
        markdown: [
          '<div class="c-article-main-column" role="main">',
          "",
          "## Abstract",
          "",
          '<div class="c-article-section__content">',
          `${body}<sup><a href="#ref-CR1" title="Reference">1</a></sup>`,
          "</div>",
          "",
          "## Introduction",
          "",
          '<span class="mathjax-tex">\\eta^3</span>',
          `${body}<a href="/articles/s41467-025-67766-6/figures/1"><span>Full size image</span></a>`,
          "",
          "## Results",
          "",
          `${body}<figcaption><strong>Fig. 1:</strong> Subharmonic driving schematic.</figcaption>`,
          "</div>"
        ].join("\n"),
        metadata: {
          title: "Fast superconducting qubit control with subharmonic drives",
          doi: "10.1038/s41467-025-67766-6",
          authors: []
        },
        access: {
          status: "full_text",
          signals: []
        },
        stats: {
          chars: body.length * 3,
          wordsApprox: 2200,
          navigationLinesRemoved: 0,
          extractedFrom: "article"
        }
      }
    });

    assert.equal(result.quality.status, "good");
    assert.ok(result.quality.score >= 0.7);
    assert.ok(
      !result.quality.warnings.some((warning) =>
        warning.includes("substantial raw HTML markup")
      )
    );
    const markdown = await readFile(result.artifacts.markdownPath, "utf8");
    assert.doesNotMatch(markdown, /<\/?(?:div|span|sup|a|figcaption)\b/i);
    assert.match(markdown, /Subharmonic drives support fast superconducting qubit control/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
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

    assert.ok(["poor", "needs_hybrid"].includes(result.quality.status));
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

test("APS webpage parsing can diagnose body-level article text outside the default main panel", () => {
  const fullText = `
    <section id="article-text" class="article-text">
      <h2>Article Text</h2>
      <p>We present an explicit construction of a relativistic quantum computing architecture.</p>
      <p>${"The relativistic qubit trajectory supplies a tunable gate parameter. ".repeat(130)}</p>
      <h2>Conclusion</h2>
      <p>The architecture forms a universal gate set in the full article text.</p>
    </section>
  `;
  const html = `
    <html>
      <head>
        <meta name="citation_title" content="Universal Quantum Computer from Relativistic Motion">
        <meta name="citation_doi" content="10.1103/PhysRevLett.134.190601">
        <meta name="citation_journal_title" content="Physical Review Letters">
      </head>
      <body>
        <header>Physical Review Letters Search Subscribe</header>
        <main>
          <h1>Universal Quantum Computer from Relativistic Motion</h1>
          <h2>Abstract</h2>
          <p>We present an explicit construction using relativistic quantum motion.</p>
          <h2>Article Text</h2>
          <h2>Supplemental Material</h2>
          <h2>References (53)</h2>
          <p>M. A. Nielsen and I. L. Chuang, Quantum Computation and Quantum Information.</p>
        </main>
        ${fullText}
        <footer>Published by the American Physical Society</footer>
      </body>
    </html>
  `;

  const diagnostic = diagnosePaperWebPageHtml({
    url: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.190601",
    html
  });
  const extraction = parsePaperWebPageHtml({
    url: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.190601",
    html
  });

  assert.equal(diagnostic.selected.selector, "body");
  assert.ok(diagnostic.candidates.some((candidate) => candidate.selector === "main"));
  assert.equal(extraction.stats.extractedFrom, "body");
  assert.match(extraction.markdown, /## Article Text/);
  assert.match(extraction.markdown, /relativistic qubit trajectory supplies a tunable gate parameter/);
  assert.match(extraction.markdown, /## Conclusion/);
  assert.doesNotMatch(extraction.markdown, /Search Subscribe/);
});

test("APS webpage parsing flags authorization-required pages as access-limited", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-aps-access-"));
  try {
    const extraction = parsePaperWebPageHtml({
      url: "https://journals.aps.org/prl/abstract/10.1103/rqkg-dw31#fulltext",
      html: `
        <html>
          <head>
            <meta name="citation_title" content="Experimental Quantum Error Correction below the Surface Code Threshold via All-Microwave Leakage Suppression">
            <meta name="citation_doi" content="10.1103/rqkg-dw31">
            <meta name="citation_journal_title" content="Physical Review Letters">
          </head>
          <body>
            <main>
              <h1>Experimental Quantum Error Correction below the Surface Code Threshold via All-Microwave Leakage Suppression</h1>
              <h2>Abstract</h2>
              <p>Quantum error correction enables practical quantum computing.</p>
              <h2>Article Text</h2>
              <h1>Authorization Required</h1>
              <p>We need you to provide your credentials before accessing this content.</p>
              <p>APS Member Log In</p>
              <h2>Other Options</h2>
              <ul>
                <li>Buy Article</li>
                <li>Log in with APS Journals Account</li>
                <li>Log in with username/password provided by your institution</li>
              </ul>
              <h2>Supplemental Material (Subscription Required)</h2>
              <h2>References (Subscription Required)</h2>
            </main>
          </body>
        </html>
      `
    });

    assert.equal(extraction.access.status, "access_limited");
    assert.ok(extraction.access.signals.includes("aps_authorization_required"));
    assert.ok(extraction.access.signals.includes("aps_credentials_required"));
    assert.ok(extraction.access.signals.includes("aps_subscription_required"));
    assert.match(extraction.access.message ?? "", /log in/i);

    const result = await savePaperWebPageParse({
      workspaceDir: workspace,
      extraction
    });

    assert.ok(["poor", "needs_hybrid"].includes(result.quality.status));
    assert.ok(
      result.quality.warnings.some((warning) =>
        warning.includes("Ask the user to log in")
      )
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Nature webpage parsing flags subscription previews as access-limited", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-nature-access-"));
  try {
    const extraction = parsePaperWebPageHtml({
      url: "https://www.nature.com/articles/s41567-022-01591-2",
      html: `
        <html>
          <head>
            <meta name="citation_title" content="Parity measurement in the strong dispersive regime of circuit quantum acoustodynamics">
            <meta name="citation_doi" content="10.1038/s41567-022-01591-2">
            <meta name="citation_journal_title" content="Nature Physics">
          </head>
          <body>
            <article>
              <h1>Parity measurement in the strong dispersive regime of circuit quantum acoustodynamics</h1>
              <h2>Abstract</h2>
              <p>Mechanical resonators are emerging as an important new platform for quantum science and technologies.</p>
              <p>Access through your institution</p>
              <p>Buy or subscribe</p>
              <p>This is a preview of subscription content, access via your institution</p>
              <h2>Access options</h2>
              <p>Access Nature and 54 other Nature Portfolio journals</p>
              <h3>Buy this article</h3>
              <p>Purchase on SpringerLink</p>
              <p>Instant access to the full article PDF.</p>
              <h2>Data availability</h2>
              <p>Source data are provided with this paper.</p>
              <h2>References</h2>
              <p>${"Reference metadata ".repeat(180)}</p>
            </article>
          </body>
        </html>
      `
    });

    assert.equal(extraction.access.status, "access_limited");
    assert.ok(extraction.access.signals.includes("nature_preview_subscription"));
    assert.ok(extraction.access.signals.includes("nature_institution_access"));
    assert.ok(extraction.access.signals.includes("nature_springerlink_purchase"));

    const result = await savePaperWebPageParse({
      workspaceDir: workspace,
      extraction
    });

    assert.ok(["poor", "needs_hybrid"].includes(result.quality.status));
    assert.ok(
      result.quality.warnings.some((warning) =>
        warning.includes("Ask the user to log in")
      )
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Nature unedited manuscript webpage without body is not treated as full-quality text", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-nature-unedited-"));
  try {
    const extraction = parsePaperWebPageHtml({
      url: "https://www.nature.com/articles/s41534-026-01233-y",
      html: `
        <html>
          <head>
            <meta name="citation_title" content="Fusion-based implementation of qLDPC codes with quantum emitters">
            <meta name="citation_doi" content="10.1038/s41534-026-01233-y">
            <meta name="citation_journal_title" content="npj Quantum Information">
          </head>
          <body>
            <article>
              <h1>Fusion-based implementation of qLDPC codes with quantum emitters</h1>
              <p>We are providing an unedited version of this manuscript to give early access to its findings. Before final publication, the manuscript will undergo further editing. Please note there may be errors present which affect the content, and all legal disclaimers apply.</p>
              <h2>Abstract</h2>
              <p>Quantum low-density parity check codes offer higher encoding rate than topological codes.</p>
              <h2>Data availability</h2>
              <p>The code and data generated for this article are openly available.</p>
              <h2>Code availability</h2>
              <p>The code written for this article is openly available.</p>
              <h2>References</h2>
              <p>${"Reference metadata ".repeat(220)}</p>
              <h2>Acknowledgements</h2>
              <p>We thank collaborators.</p>
              <h2>Author information</h2>
              <p>Authors and affiliations.</p>
            </article>
          </body>
        </html>
      `
    });

    const result = await savePaperWebPageParse({
      workspaceDir: workspace,
      extraction
    });

    assert.equal(result.paperKey, "nature-s41534-026-01233-y");
    assert.ok(["poor", "needs_hybrid"].includes(result.quality.status));
    assert.ok(result.quality.score < 0.7);
    assert.ok(
      result.quality.warnings.some((warning) =>
        warning.includes("No main body sections were detected")
      )
    );
    assert.ok(
      result.quality.warnings.some((warning) =>
        warning.includes("Prefer PDF parsing")
      )
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Nature webpage parsing removes institution access entitlement messages", () => {
  const extraction = parsePaperWebPageHtml({
    url: "https://www.nature.com/articles/nature14270",
    html: `
      <html>
        <head>
          <meta name="citation_title" content="State preservation by repetitive error detection">
          <meta name="citation_doi" content="10.1038/nature14270">
        </head>
        <body>
          <main data-track-component="article body">
            <h1>State preservation by repetitive error detection</h1>
            <section>
              <h2>Abstract</h2>
              <p>Quantum computing becomes viable when a quantum state can be protected.</p>
            </section>
            <div class="c-nature-box c-nature-box--side" data-test="entitlement-box">
              <p class="c-nature-box__text" data-test="access-message">
                You have full access to this article via
                <strong>University of Science and Technology of China</strong>.
              </p>
            </div>
            <section>
              <h2>Article Text</h2>
              <p>The repetition code detects bit-flip errors through parity measurements.</p>
            </section>
          </main>
        </body>
      </html>
    `
  });

  assert.match(extraction.markdown, /Quantum computing becomes viable/);
  assert.match(extraction.markdown, /The repetition code detects bit-flip errors/);
  assert.doesNotMatch(extraction.markdown, /You have full access to this article/i);
  assert.doesNotMatch(extraction.markdown, /University of Science and Technology of China/i);
  assert.doesNotMatch(extraction.snapshotHtml ?? "", /You have full access to this article/i);
  assert.doesNotMatch(extraction.snapshotHtml ?? "", /data-test="entitlement-box"/i);
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
    assert.match(result.artifacts.markdownPath, /knowledge-base\/sources\/nature-s41467-025-59778-z\/parses\/webpage\/document\.md$/);
    assert.match(result.artifacts.sourcePath ?? "", /knowledge-base\/sources\/nature-s41467-025-59778-z\/parses\/webpage\/document\.html$/);
    assert.match(result.artifacts.parsePath, /knowledge-base\/sources\/nature-s41467-025-59778-z\/parses\/webpage\/parse\.json$/);
    assert.match(result.artifacts.chunksPath, /knowledge-base\/sources\/nature-s41467-025-59778-z\/parses\/webpage\/chunks\.jsonl$/);

    const html = await readFile(result.artifacts.sourcePath!, "utf8");
    assert.match(html, /<main data-track-component="article body">/);
    const markdown = await readFile(result.artifacts.markdownPath, "utf8");
    assert.match(markdown, /## Methods/);
    const metadata = JSON.parse(
      await readFile(path.join(workspace, "knowledge-base/sources/nature-s41467-025-59778-z/metadata.json"), "utf8")
    ) as {
      artifacts: Array<{ kind: string; path: string; engine?: string }>;
    };
    assert.ok(metadata.artifacts.some((artifact) =>
      artifact.kind === "snapshot" &&
      artifact.engine === "webpage" &&
      artifact.path === "knowledge-base/sources/nature-s41467-025-59778-z/parses/webpage/document.html"
    ));
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

test("savePaperWebPageParse uses AIP source keys for AIP article slug pages with citation DOI metadata", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-aip-webpage-"));

  try {
    const extraction = parsePaperWebPageHtml({
      url: "https://pubs.aip.org/aip/apr/article/6/2/021318/570326/A-quantum-engineer-s-guide-to-superconducting",
      html: `
        <html>
          <head>
            <meta name="citation_title" content="A quantum engineer's guide to superconducting qubits">
            <meta name="citation_doi" content="10.1063/1.5089550">
            <meta name="citation_journal_title" content="Applied Physics Reviews">
          </head>
          <body>
            <main>
              <h1>A quantum engineer's guide to superconducting qubits</h1>
              <h2>Abstract</h2>
              <p>The aim of this review is to provide quantum engineers with an introductory guide.</p>
              <h2>Introduction</h2>
              <p>${"Superconducting quantum circuits provide engineered artificial atoms. ".repeat(400)}</p>
            </main>
          </body>
        </html>
      `
    });

    const result = await savePaperWebPageParse({
      workspaceDir: workspace,
      extraction
    });

    assert.equal(result.paperKey, "aip-10.1063-1.5089550");
    assert.match(result.artifacts.markdownPath, /knowledge-base\/sources\/aip-10\.1063-1\.5089550\/parses\/webpage\/document\.md$/);
    await assert.rejects(
      () => readFile(path.join(workspace, "knowledge-base", "sources", "doi-10.1063-1.5089550", "metadata.json"), "utf8"),
      /ENOENT/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("savePaperWebPageParse writes filtered article HTML snapshot", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-webpage-filtered-html-"));
  try {
    const extraction = parsePaperWebPageHtml({
      url: "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.111.080502",
      html: `
        <!doctype html>
        <html>
          <head>
            <title>Coherent Josephson Qubit Suitable for Scalable Quantum Integrated Circuits</title>
            <script src="https://www.googletagmanager.com/gtm.js"></script>
            <link rel="stylesheet" href="https://cdn.journals.aps.org/site.css">
            <meta name="citation_title" content="Coherent Josephson Qubit Suitable for Scalable Quantum Integrated Circuits">
            <meta name="citation_doi" content="10.1103/PhysRevLett.111.080502">
          </head>
          <body>
            <nav>PDF Share Metrics</nav>
            <main data-track-component="article body">
              <div class="osano-cm-window">Cookie preferences</div>
              <ul class="labels">
                <li class="article-feature-tag">Access by University of Science &amp; Technology of China</li>
              </ul>
              <h1>Coherent Josephson Qubit Suitable for Scalable Quantum Integrated Circuits</h1>
              <section>
                <h2>Abstract</h2>
                <p>We demonstrate a planar, tunable superconducting qubit.</p>
              </section>
              <aside class="article-sidebar">Picked up by 2 news outlets</aside>
              <div class="altmetric-embed">Picked up by 2 news outlets</div>
              <div class="dimensions-wrapper"><span>CITATIONS</span></div>
              <img src="https://badge.dimensions.ai/badge?count=762" class="__dimensions_png" alt="762 total citations on Dimensions.">
              <a class="link-to-altmetric-details-tab" href="https://www.altmetric.com/details.php">Blogged by 2</a>
              <div class="share-toolbar">Share this paper</div>
              <section>
                <h2>Article Text</h2>
                <p>The Xmon qubit combines connectivity, control, and long coherence.</p>
                <figure>
                  <img src="assets/figure-1.png" alt="Xmon qubit">
                  <figcaption>Figure 1. Optical micrograph of the planar Xmon qubit.</figcaption>
                </figure>
              </section>
              <section class="article-info" id="info-panel">
                <p>&copy; 2013 American Physical Society</p>
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

    const html = await readFile(result.artifacts.sourcePath!, "utf8");
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /<main data-track-component="article body">/);
    assert.match(html, /<h2>Article Text<\/h2>/);
    assert.match(html, /<figure>/);
    assert.doesNotMatch(html, /googletagmanager/i);
    assert.doesNotMatch(html, /cdn\.journals\.aps\.org/i);
    assert.doesNotMatch(html, /<script\b/i);
    assert.doesNotMatch(html, /<link\b/i);
    assert.doesNotMatch(html, /<nav\b/i);
    assert.doesNotMatch(html, /osano/i);
    assert.doesNotMatch(html, /altmetric/i);
    assert.doesNotMatch(html, /dimensions/i);
    assert.doesNotMatch(html, /CITATIONS/i);
    assert.doesNotMatch(html, /article-sidebar/i);
    assert.doesNotMatch(html, /share-toolbar/i);
    assert.doesNotMatch(html, /Access by University of Science/i);
    assert.doesNotMatch(html, /American Physical Society/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("savePaperWebPageParse writes extension-captured webpage images as local assets", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-webpage-assets-"));
  try {
    const extraction = parsePaperWebPageHtml({
      url: "https://www.nature.com/articles/s41567-022-01591-2",
      html: `
        <html>
          <head><meta name="citation_title" content="Nature Physics article"></head>
          <body>
            <main data-track-component="article body">
              <h1>Nature Physics article</h1>
              <section><h2>Results</h2><p>Figure text.</p></section>
              <figure>
                <img src="/cms/asset/figure-1.png" alt="Figure 1">
                <figcaption>Fig. 1 | Device schematic.</figcaption>
              </figure>
            </main>
          </body>
        </html>
      `
    });

    const result = await savePaperWebPageParse({
      workspaceDir: workspace,
      extraction: {
        ...extraction,
        markdown: [
          "# Nature Physics article",
          "",
          "## Results",
          "",
          "Figure text.",
          "",
          "![Figure 1](https://www.nature.com/cms/asset/figure-1.png)",
          "![Inline icon](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)",
          "",
          "Fig. 1 | Device schematic."
        ].join("\n"),
        assets: [
          {
            url: "https://www.nature.com/cms/asset/figure-1.png",
            originalUrl: "/cms/asset/figure-1.png",
            filename: "figure-1.png",
            mimeType: "image/png",
            dataBase64: Buffer.from("png-bytes").toString("base64"),
            alt: "Figure 1"
          },
          {
            url: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
            originalUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
            filename: "svg+xml;base64,PHN2Zz48L3N2Zz4=.svg",
            mimeType: "image/svg+xml",
            dataBase64: "PHN2Zz48L3N2Zz4=",
            alt: "Inline icon"
          }
        ]
      }
    });

    assert.equal(result.status, "parsed");
    const markdown = await readFile(result.artifacts.markdownPath, "utf8");
    assert.match(markdown, /!\[Figure 1]\(assets\/figure-1\.png\)/);
    assert.match(markdown, /!\[Inline icon]\(assets\/asset-002\.svg\)/);
    const html = await readFile(result.artifacts.sourcePath!, "utf8");
    assert.match(html, /<img src="assets\/figure-1\.png" alt="Figure 1">/);
    assert.doesNotMatch(html, /\/cms\/asset\/figure-1\.png/);
    const assetPath = path.join(
      workspace,
      "knowledge-base", "sources",
      "nature-s41567-022-01591-2",
      "parses",
      "webpage",
      "assets",
      "figure-1.png"
    );
    assert.equal(await readFile(assetPath, "utf8"), "png-bytes");
    const dataAssetPath = path.join(path.dirname(assetPath), "asset-002.svg");
    assert.equal(await readFile(dataAssetPath, "utf8"), "<svg></svg>");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("savePaperWebPageParse rewrites Nature picture sources to local image assets", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-webpage-picture-assets-"));
  try {
    const extraction = parsePaperWebPageHtml({
      url: "https://www.nature.com/articles/nature14270",
      html: `
        <html>
          <head><meta name="citation_title" content="Nature article"></head>
          <body>
            <main data-track-component="article body">
              <h1>Nature article</h1>
              <figure>
                <picture>
                  <source
                    type="image/webp"
                    srcset="//media.springernature.com/lw685/springer-static/image/art%3A10.1038%2Fnature14270/MediaObjects/41586_2015_BFnature14270_Fig1_HTML.jpg?as=webp"
                  >
                  <img
                    src="//media.springernature.com/lw685/springer-static/image/art%3A10.1038%2Fnature14270/MediaObjects/41586_2015_BFnature14270_Fig1_HTML.jpg"
                    alt="Figure 1"
                  >
                </picture>
                <figcaption>Fig. 1 | Device schematic.</figcaption>
              </figure>
            </main>
          </body>
        </html>
      `
    });

    const result = await savePaperWebPageParse({
      workspaceDir: workspace,
      extraction: {
        ...extraction,
        assets: [
          {
            url: "https://media.springernature.com/lw685/springer-static/image/art%3A10.1038%2Fnature14270/MediaObjects/41586_2015_BFnature14270_Fig1_HTML.jpg",
            originalUrl: "//media.springernature.com/lw685/springer-static/image/art%3A10.1038%2Fnature14270/MediaObjects/41586_2015_BFnature14270_Fig1_HTML.jpg",
            filename: "41586_2015_BFnature14270_Fig1_HTML.jpg",
            mimeType: "image/jpeg",
            dataBase64: Buffer.from("jpg-bytes").toString("base64"),
            alt: "Figure 1"
          }
        ]
      }
    });

    const html = await readFile(result.artifacts.sourcePath!, "utf8");
    assert.match(html, /<img[^>]+src="assets\/41586_2015_BFnature14270_Fig1_HTML\.jpg"/);
    assert.doesNotMatch(html, /srcset="\/\/media\.springernature\.com/);
    assert.doesNotMatch(html, /srcset='\/\/media\.springernature\.com/);
    assert.match(html, /<source\s+type="image\/jpeg"\s+srcset="assets\/41586_2015_BFnature14270_Fig1_HTML\.jpg"/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("savePaperWebPageParse inserts Nature figure asset links when Pandoc keeps only captions", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-webpage-nature-assets-"));
  try {
    const extraction = parsePaperWebPageHtml({
      url: "https://www.nature.com/articles/s41567-022-01591-2",
      html: `
        <html>
          <head><meta name="citation_title" content="Nature Physics article"></head>
          <body>
            <main data-track-component="article body">
              <h1>Nature Physics article</h1>
              <p>Article body.</p>
              <p>Figure: Fig. 1: Characterization of the device.</p>
            </main>
          </body>
        </html>
      `
    });

    const result = await savePaperWebPageParse({
      workspaceDir: workspace,
      extraction: {
        ...extraction,
        markdown: [
          "# Nature Physics article",
          "",
          "Article body.",
          "",
          "Figure: Fig. 1: Characterization of the device."
        ].join("\n"),
        assets: [
          {
            url: "https://media.springernature.com/w700/springer-static/image/art%3A10.1038%2Fs41567-022-01591-2/MediaObjects/41567_2022_1591_Fig1_HTML.png",
            filename: "41567_2022_1591_Fig1_HTML.png",
            mimeType: "image/png",
            dataBase64: Buffer.from("main-figure").toString("base64")
          },
          {
            url: "https://media.springernature.com/w215h120/springer-static/image/art%3A10.1038%2Fs41586-022-04500-y/MediaObjects/41586_2022_4500_Fig1_HTML.png",
            filename: "41586_2022_4500_Fig1_HTML.png",
            mimeType: "image/png",
            dataBase64: Buffer.from("related-figure").toString("base64")
          }
        ]
      }
    });

    const markdown = await readFile(result.artifacts.markdownPath, "utf8");
    assert.match(markdown, /!\[Fig\. 1]\(assets\/41567_2022_1591_Fig1_HTML\.png\)/);
    assert.doesNotMatch(markdown, /41586_2022_4500_Fig1_HTML/);

    const assetDir = path.join(path.dirname(result.artifacts.markdownPath), "assets");
    assert.deepEqual(await readdir(assetDir), ["41567_2022_1591_Fig1_HTML.png"]);
    assert.equal(
      await readFile(path.join(assetDir, "41567_2022_1591_Fig1_HTML.png"), "utf8"),
      "main-figure"
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("arXiv HTML webpage parses under canonical arxiv key and keeps inline citation links", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "pi-paper-webpage-arxiv-"));
  try {
    const extraction = parsePaperWebPageHtml({
      url: "https://arxiv.org/html/2601.00425v1",
      html: `
        <html>
          <head>
            <meta name="citation_title" content="Chip-scale superconducting quantum gravimeter">
            <meta name="citation_author" content="Alice Example">
          </head>
          <body>
            <article>
              <h1>Chip-scale superconducting quantum gravimeter</h1>
              <h6>Abstract</h6>
              <p>${"Long arXiv article body with inline citations and author-specific structure. ".repeat(140)}</p>
              <p>
                Prior work is cited directly inline
                <a href="https://doi.org/10.1103/PhysRevLett.134.190601">Phys. Rev. Lett. 134, 190601</a>
                instead of in a References section.
              </p>
            </article>
          </body>
        </html>
      `
    });

    assert.equal(extraction.metadata.referenceLinks?.[0]?.kind, "doi");
    assert.match(extraction.metadata.referenceSummary ?? "", /linked citation/);

    const result = await savePaperWebPageParse({
      workspaceDir: workspace,
      extraction
    });

    assert.equal(result.paperKey, "arxiv-2601.00425");
    assert.equal(result.quality.status, "good");
    assert.ok(
      !result.quality.warnings.some((warning) =>
        warning.includes("No main body sections were detected")
      )
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
