import test from "node:test";
import assert from "node:assert/strict";
import { findQuote, quoteWindow } from "../../benchmark/lib.mjs";

// Units are the crux of this suite: mK vs MK and mHz vs MHz differ only in case,
// and the adversarial verifier judges "gold misstates units, uncertainty, or
// value relative to the evidence" from the window text this module returns.
const COLD_CHAIN_DOC =
  "The mixing chamber plate sits at 15 mK while the readout drive is 6.785 GHz. " +
  "The cold finger attenuators are anchored at 4 K.";

test("quoteWindow keeps the document's original unit casing", () => {
  const window = quoteWindow("mixing chamber plate sits at 15 mK", COLD_CHAIN_DOC);
  assert.notEqual(window, undefined);
  // the evidence window must show millikelvin as written, not folded to "mk"
  assert.ok(window.includes("15 mK"), `window must contain "15 mK": ${window}`);
  assert.equal(window.includes("15 mk"), false);
  assert.ok(window.includes("4 K"));
});

test("quoteWindow keeps milli-hertz distinguishable from mega-hertz", () => {
  const doc = "The shim line runs at 15 mHz, far below the qubit drive at 6.785 GHz.";
  const window = quoteWindow("shim line runs at 15 mHz", doc);
  assert.notEqual(window, undefined);
  assert.ok(window.includes("15 mHz"));
  assert.equal(window.includes("15 mhz"), false);
  assert.equal(window.includes("15 MHz"), false);
});

test("matching stays case-insensitive while the window shows the document's casing", () => {
  // a mis-cased quote still matches...
  const window = quoteWindow("MIXING CHAMBER PLATE SITS AT 15 MK", COLD_CHAIN_DOC);
  assert.notEqual(window, undefined);
  // ...but the window reports what the source actually says
  assert.ok(window.includes("15 mK"));
  assert.equal(window.includes("15 MK"), false);
});

test("findQuote addresses the case-preserving document", () => {
  const quote = "readout drive is 6.785 GHz";
  const { found, index, length, normalizedDoc } = findQuote(quote, COLD_CHAIN_DOC);
  assert.equal(found, true);
  assert.equal(normalizedDoc, COLD_CHAIN_DOC);
  const matched = normalizedDoc.slice(index, index + length);
  assert.equal(matched, "readout drive is 6.785 GHz");
  assert.equal(matched.toLowerCase(), quote.toLowerCase());
});

test("windows are exact document slices when lowercase folding expands a code unit", () => {
  // "İ" lowercases to two code units ("i" + combining dot above), shifting every
  // later offset in the lowercased text by one; window boundaries must stay on
  // the original text's offsets.
  const doc = "İstanbul-fabricated junctions report T1 = 92 μs at 15 mK for the auxiliary transmon.";
  const quote = "report T1 = 92 μs at 15 mK";
  const start = doc.indexOf(quote);
  const end = start + quote.length;
  const radius = 12;
  assert.equal(
    quoteWindow(quote, doc, radius),
    doc.slice(Math.max(0, start - radius), Math.min(doc.length, end + radius))
  );
});

test("a quote spelled with the expanded lowercase still maps onto the original code unit", () => {
  const doc = "Cryostat İ-grade wiring holds at 15 mK for the readout chain.";
  const combining = "̇"; // combining dot above: the second unit of lowered "İ"
  const quote = `i${combining}-grade wiring holds at 15 mK`;
  const { found, index, length, normalizedDoc } = findQuote(quote, doc);
  assert.equal(found, true);
  // the doc-side span is the single "İ" code unit, not the two-unit spelling
  assert.equal(normalizedDoc.slice(index, index + length), "İ-grade wiring holds at 15 mK");
  const radius = 10;
  const start = doc.indexOf("İ-grade");
  const end = start + "İ-grade wiring holds at 15 mK".length;
  assert.equal(
    quoteWindow(quote, doc, radius),
    doc.slice(Math.max(0, start - radius), Math.min(doc.length, end + radius))
  );
});

test("whitespace flattening and miss/short-quote behavior are unchanged", () => {
  const wrapped = "The mixing chamber plate\nsits at 15 mK while the readout drive\nis 6.785 GHz.";
  const window = quoteWindow("chamber plate sits at 15 mK", wrapped, 8);
  assert.notEqual(window, undefined);
  assert.ok(window.includes("chamber plate sits at 15 mK")); // line wraps flattened to spaces
  assert.equal(quoteWindow("15 mK", wrapped), undefined); // below the 10-char minimum
  assert.equal(quoteWindow("this sentence exists nowhere in the document", wrapped), undefined);
  assert.equal(findQuote("15 mK", wrapped).found, false);
});

test("a match ending inside a lowercase expansion includes the complete source character", () => {
  assert.equal(quoteWindow("abcdefghii", "Abcdefghiİ", 0), "Abcdefghiİ");
});
