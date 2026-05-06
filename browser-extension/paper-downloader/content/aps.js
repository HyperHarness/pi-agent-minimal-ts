(function installPiAgentPaperAps(root) {
  function deriveApsPdfUrl(baseUrl) {
    try {
      var parsed = new URL(baseUrl);
      var doiMatch = parsed.pathname.match(/^\/doi\/(?!pdf\/)(.+)$/i);
      if (doiMatch && doiMatch[1]) {
        parsed.pathname = "/doi/pdf/" + doiMatch[1];
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      }

      var match = parsed.pathname.match(/^\/([^/]+)\/abstract\/(.+)$/i);
      if (!match) {
        return null;
      }

      parsed.pathname = "/" + match[1] + "/pdf/" + match[2];
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch (error) {
      return null;
    }
  }

  function findApsPdfCandidate(input) {
    var genericCandidate = root.PiAgentPaperCommon.findPdfCandidate(input);
    if (genericCandidate) {
      return genericCandidate;
    }

    return deriveApsPdfUrl(input && input.baseUrl);
  }

  root.PiAgentPaperAps = {
    findApsPdfCandidate: findApsPdfCandidate
  };
})(globalThis);
