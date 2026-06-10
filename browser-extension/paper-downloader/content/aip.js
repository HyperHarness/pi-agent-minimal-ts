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

  function findAipPdfCandidate(input) {
    var genericCandidate = root.PiAgentPaperCommon.findPdfCandidate(input);
    if (genericCandidate) {
      return genericCandidate;
    }

    return deriveAipPdfUrl(input && input.baseUrl);
  }

  root.PiAgentPaperAip = {
    findAipPdfCandidate: findAipPdfCandidate
  };
})(globalThis);
