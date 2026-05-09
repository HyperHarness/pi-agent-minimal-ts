# PDF Parser Benchmark: Nature Communications s41467-025-59778-z

Date: 2026-04-28

Benchmark article:

- Title: Cosmic-ray-induced correlated errors in superconducting qubit array
- DOI: 10.1038/s41467-025-59778-z
- Article URL: https://www.nature.com/articles/s41467-025-59778-z
- Local PDF: `knowledge-base/raw/pdfs/nature-s41467-025-59778-z.pdf`
- Record: `knowledge-base/sources/nature-s41467-025-59778-z/acquisition.json`
- Raw benchmark JSON: `/tmp/pi-agent-benchmarks/nature-s41467-025-59778-z-parser-benchmark.json`

## Scope

This benchmark compares five extraction routes on the same difficult Nature article:

1. OpenDataLoader local PDF parser.
2. Docling local PDF parser.
3. Plain text PDF baseline parser.
4. Generic direct extraction from the original Nature article webpage through `src/agent/web-fetch.ts`.
5. Dedicated scientific paper webpage extraction through `src/agent/paper/acquisition/paper-webpage-fetch.ts`.

The goal is not only to check whether text can be extracted, but whether the output is suitable as a source layer for the planned LLM wiki and downstream retrieval.

## Summary

| Route | Status | Time | Extracted text | Structure | Key content coverage | Noise | Verdict |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
| OpenDataLoader local PDF | Failed | 67.2 s | N/A | N/A | N/A | N/A | Not usable on this PDF without further memory/font handling. |
| Docling local PDF | Succeeded | 17.8 s | 44,762 chars | Best: title, sections, captions, page content preserved | Complete benchmark markers found | No PDF-object/base64/navigation noise detected | Best canonical source for LLM wiki. |
| Plain text baseline PDF | Succeeded | 1.5 s | 44,474 chars | Weak: mostly flat text, only one heading detected | Complete benchmark markers found | No PDF-object/base64/navigation noise detected | Good emergency fallback and search text, weak for semantic reading. |
| Generic Nature webpage fetch | Succeeded | 2.2 s | 12,000 chars cap | Weak: cleaned page text with site chrome | Partial: misses Data availability and References under current cap | Some navigation/site text | Useful auxiliary source, not primary source. |
| Dedicated paper webpage fetch | Succeeded | 2.8 s | 48,102 chars | Strong: article body selected from `main`, markdown headings preserved | Complete benchmark markers found | No tested navigation/recommendation noise detected | Best webpage route; strong companion or alternative to PDF parsing. |

## OpenDataLoader Local PDF

OpenDataLoader failed on this specific PDF after about 67 seconds.

Observed failure pattern:

- Repeated glyph width warnings, for example missing glyph width in embedded font `HKHIKA+AdvOT89719618`.
- Repeated Unicode mapping failures.
- Final Java heap failure: `java.lang.OutOfMemoryError: Java heap space`.

This is consistent with a PDF/A-converted Springer/Nature file whose embedded font mappings are difficult for the Java parser. For this article, OpenDataLoader should not be treated as a reliable single parser. It can remain the first parser in the automatic pipeline if it performs well on other papers, but this benchmark confirms that a fallback is required.

## Docling Local PDF

Docling successfully parsed the PDF and produced the best source document for reading and retrieval.

Measured output:

- Time: 17.8 seconds.
- Markdown size: 44,982 bytes.
- Extracted text: 44,762 characters.
- Approximate words: 7,561.
- Pages detected: 8.
- Headings detected: 20.
- Figure or caption markers detected: 8.
- Empty pages: 0.
- Quality score: 1.0, `good`.

Coverage checks:

- Title found.
- `Results` found.
- `Methods` found.
- `Data availability` found.
- `References` found.
- `Fig. 1` found.
- Domain terms found: `muon`, gamma symbol, `QEC`.

Noise checks:

- PDF object tokens: 0.
- Base64 image tokens: 0.
- Navigation tokens: 0.

Docling is slower than the plain text baseline, but it preserves much more semantic structure. For the LLM wiki design, this is the best canonical source for `knowledge-base/sources/...`.

## Plain Text Baseline PDF

The baseline parser also successfully extracted the paper text and was the fastest local PDF parser.

Measured output:

- Time: 1.5 seconds.
- Markdown size: 44,594 bytes.
- Extracted text: 44,474 characters.
- Approximate words: 7,296.
- Pages detected: 8.
- Headings detected: 1.
- Figure or caption markers detected: 0.
- Empty pages: 0.
- Quality score: 1.0, `good`.

Coverage checks:

- Title found.
- `Results` found.
- `Methods` found.
- `Data availability` found.
- `References` found.
- `Fig. 1` found.
- Domain terms found: `muon`, gamma symbol, `QEC`.

Noise checks:

- PDF object tokens: 0.
- Base64 image tokens: 0.
- Navigation tokens: 0.

The baseline output is surprisingly useful for full-text search, but it has much weaker document structure. It should be retained as an emergency fallback and as a cheap searchable text source, not as the preferred source for high-quality reading or section-aware summarization.

## Original Webpage Extraction

Generic direct webpage extraction succeeded through `src/agent/web-fetch.ts`, but the implementation is intentionally generic:

- It runs a general HTML cleaning pass.
- It caps text at 12,000 characters.
- It does not perform Nature-specific article body extraction.

Measured output:

- Time: 2.2 seconds.
- Extracted text: 12,000 characters.
- Approximate words: 1,934.
- Title found.
- `Results` found.
- `Methods` found.
- `Fig. 1` found.
- Domain terms found: `muon`, gamma symbol, `QEC`.
- `Data availability` not found.
- `References` not found.
- Navigation/site tokens detected: 4.

The webpage path is useful for metadata checks, quick previews, and possibly supplementing missing PDF metadata. It is not a replacement for PDF parsing in its current form because the cap removes late sections and the generic extractor includes Nature site chrome.

The current generic webpage fetcher should not be used as the canonical LLM wiki source for papers. It remains useful for normal webpages and quick checks.

## Dedicated Paper Webpage Extraction

The dedicated paper webpage extractor succeeded through `src/agent/paper/acquisition/paper-webpage-fetch.ts` and removed the main limitation of the generic webpage route.

Measured output:

- Time: 2.8 seconds.
- Extracted text: 48,102 characters.
- Approximate words: 7,853.
- Extracted region: `main`.
- Navigation or recommendation lines removed: 9.
- Title: `Cosmic-ray-induced correlated errors in superconducting qubit array`.
- DOI: `10.1038/s41467-025-59778-z`.
- Journal: `Nature Communications`.
- Authors detected from metadata: 18.

Coverage checks:

- Title found.
- `Results` found.
- `Methods` found.
- `Data availability` found.
- `References` found.
- `Fig. 1` found.
- Domain terms found: `muon`, gamma symbol, `QEC`.

Noise checks:

- `Skip to main content`: not found.
- Browser support warning: not found.
- `Subscribe`: not found.
- `Similar content being viewed`: not found.
- Tested navigation tokens: 0.

This route is now the best way to read the original publisher webpage. Compared with the generic webpage fetcher, it avoids the 12,000 character cap, selects the article body instead of whole-page text, and removes common navigation, header, footer, sharing, advertising, subscription, sidebar, and recommendation blocks.

Compared with Docling, this route has a different strength profile. It does not need PDF font decoding and therefore avoids the glyph/Unicode failure class entirely. It can also expose publisher HTML metadata cleanly. Its main risk is publisher-specific HTML drift, so it should be tested across more publishers before becoming the only canonical route.

## Recommendation

For this article, use Docling as the canonical parsed PDF source and `fetch_paper_webpage` as the canonical parsed webpage source.

Recommended automatic pipeline:

1. Try OpenDataLoader first if it remains the preferred high-structure parser for normal PDFs.
2. If OpenDataLoader fails, times out, or produces low-quality text, fall back to Docling.
3. If Docling fails, fall back to the plain text baseline for searchable text.
4. When an article URL is available, run `fetch_paper_webpage` as a parallel source candidate.
5. Use generic `fetch_url` only for non-paper webpages or quick preview checks.

Recommended source roles for the LLM wiki:

- `raw`: original PDF and record metadata.
- `sources`: parser outputs, with Docling preferred for PDF and `fetch_paper_webpage` preferred for publisher HTML.
- `source` or summary layer: LLM-generated reading notes and retrieval-oriented summaries generated from the best available source, with PDF and webpage outputs cross-checked when both exist.

## Parser Ranking For This Article

1. Docling: best PDF route and best current source when the PDF is the authority of record.
2. Dedicated paper webpage fetch: best webpage route; complete content coverage, no truncation, no tested navigation noise.
3. Plain text baseline: best speed and acceptable content coverage, but weak structure.
4. Generic Nature webpage fetch: useful auxiliary extraction, incomplete for canonical reading because of truncation and page chrome.
5. OpenDataLoader: failed on this difficult PDF due to font/glyph issues and Java heap exhaustion.
