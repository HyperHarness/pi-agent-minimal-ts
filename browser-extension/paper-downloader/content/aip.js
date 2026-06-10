(function installPiAgentPaperAip(root) {
  function deriveAipPdfUrl(baseUrl) {
    try {
      var parsed = new URL(baseUrl);
      var pdfMatch = parsed.pathname.match(/^\/doi\/pdf\/(.+)$/i);
      if (pdfMatch && pdfMatch[1]) {
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      }

      var doiMatch = parsed.pathname.match(/^\/doi\/(.+)$/i);
      if (!doiMatch || !doiMatch[1]) {
        return null;
      }

      parsed.pathname = "/doi/pdf/" + doiMatch[1];
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch (error) {
      return null;
    }
  }

  function normalizeDoi(value) {
    var match = String(value || "").match(/\b10\.1063\/[^\s"'<>?#]+/i);
    if (!match || !match[0]) {
      return null;
    }

    return match[0].replace(/[).,;]+$/g, "");
  }

  function resolveAbsoluteUrl(value, baseUrl) {
    try {
      return new URL(value, baseUrl).toString();
    } catch (error) {
      return null;
    }
  }

  function deriveAipPdfUrlFromMetadata(document, baseUrl) {
    var pdfUrlSelectors = [
      "meta[name='citation_pdf_url']",
      "meta[property='citation_pdf_url']",
      "meta[name='dc.Format'][content*='pdf' i]",
      "a[href*='/doi/pdf/']"
    ];
    for (var pdfIndex = 0; pdfIndex < pdfUrlSelectors.length; pdfIndex += 1) {
      var pdfSelector = pdfUrlSelectors[pdfIndex];
      var pdfCandidates = [];
      try {
        pdfCandidates = Array.prototype.slice.call(document.querySelectorAll(pdfSelector));
      } catch (error) {
        pdfCandidates = [];
      }

      for (var pdfCandidateIndex = 0; pdfCandidateIndex < pdfCandidates.length; pdfCandidateIndex += 1) {
        var pdfElement = pdfCandidates[pdfCandidateIndex];
        var rawPdfUrl =
          (pdfElement.getAttribute && (
            pdfElement.getAttribute("content") ||
            pdfElement.getAttribute("href")
          )) ||
          pdfElement.href ||
          "";
        var absolutePdfUrl = rawPdfUrl ? resolveAbsoluteUrl(rawPdfUrl, baseUrl) : null;
        if (!absolutePdfUrl) {
          continue;
        }

        try {
          var parsedPdfUrl = new URL(absolutePdfUrl);
          if (/\/doi\/pdf\/10\.1063\//i.test(parsedPdfUrl.pathname)) {
            parsedPdfUrl.search = "";
            parsedPdfUrl.hash = "";
            return parsedPdfUrl.toString();
          }
        } catch (error) {
          // Try the next metadata entry.
        }
      }
    }

    var selectors = [
      "meta[name='citation_doi']",
      "meta[name='dc.Identifier']",
      "meta[property='citation_doi']",
      "a[href*='10.1063/']"
    ];
    for (var index = 0; index < selectors.length; index += 1) {
      var selector = selectors[index];
      var candidates = [];
      try {
        candidates = Array.prototype.slice.call(document.querySelectorAll(selector));
      } catch (error) {
        candidates = [];
      }

      for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        var element = candidates[candidateIndex];
        var doi = normalizeDoi(
          [
            element.getAttribute && element.getAttribute("content"),
            element.getAttribute && element.getAttribute("href"),
            element.textContent
          ].join(" ")
        );
        if (!doi) {
          continue;
        }

        try {
          var parsed = new URL(baseUrl);
          parsed.pathname = "/doi/pdf/" + doi;
          parsed.search = "";
          parsed.hash = "";
          return parsed.toString();
        } catch (error) {
          return "https://pubs.aip.org/doi/pdf/" + doi;
        }
      }
    }

    return null;
  }

  function findAipPdfCandidate(input) {
    return deriveAipPdfUrl(input && input.baseUrl) ||
      deriveAipPdfUrlFromMetadata(input && input.document, input && input.baseUrl) ||
      root.PiAgentPaperCommon.findPdfCandidate(input);
  }

  root.PiAgentPaperAip = {
    findAipPdfCandidate: findAipPdfCandidate
  };
})(globalThis);
