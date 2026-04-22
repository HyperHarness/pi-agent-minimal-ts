import test from "node:test";
import assert from "node:assert/strict";
import {
  getPublisherAdapter,
  resolvePdfPathFromHtml
} from "../../../src/agent/publisher-adapters/index.js";

test("getPublisherAdapter selects the science adapter", () => {
  const adapter = getPublisherAdapter("https://www.science.org/doi/10.1126/science.adz8659");

  assert.equal(adapter.id, "science");
});

test("getPublisherAdapter selects the nature adapter", () => {
  const adapter = getPublisherAdapter("https://www.nature.com/articles/s41586-019-1666-5");

  assert.equal(adapter.id, "nature");
});

test("getPublisherAdapter selects the aps adapter", () => {
  const adapter = getPublisherAdapter("https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.134.090601");

  assert.equal(adapter.id, "aps");
});

test("getPublisherAdapter selects the aps adapter for aps.org", () => {
  const adapter = getPublisherAdapter("https://aps.org/prl/abstract/10.1103/PhysRevLett.134.090601");

  assert.equal(adapter.id, "aps");
});

test("resolvePdfPathFromHtml returns a science PDF link from a landing page snippet", () => {
  const pdfPath = resolvePdfPathFromHtml("science", `
    <html><body>
      <a href="/doi/pdf/10.1126/science.adz8659">PDF</a>
    </body></html>
  `);

  assert.equal(pdfPath, "/doi/pdf/10.1126/science.adz8659");
});

test("resolvePdfPathFromHtml returns a nature PDF link from a landing page snippet", () => {
  const pdfPath = resolvePdfPathFromHtml("nature", `
    <html><body>
      <a href="/articles/s41586-019-1666-5.pdf">PDF</a>
    </body></html>
  `);

  assert.equal(pdfPath, "/articles/s41586-019-1666-5.pdf");
});

test("resolvePdfPathFromHtml returns an APS PDF link from a landing page snippet", () => {
  const pdfPath = resolvePdfPathFromHtml("aps", `
    <html><body>
      <a href="/doi/pdf/10.1103/PhysRevLett.134.090601">PDF</a>
    </body></html>
  `);

  assert.equal(pdfPath, "/doi/pdf/10.1103/PhysRevLett.134.090601");
});
