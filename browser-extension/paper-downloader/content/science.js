(function installPiAgentPaperScience(root) {
  function deriveSciencePdfUrl(baseUrl) {
    try {
      var parsed = new URL(baseUrl);
      var match = parsed.pathname.match(/^\/doi\/(?!suppl\/)(?:(?:pdf|full|abs|epdf)\/)?(.+)$/i);
      if (!match || !match[1]) {
        return null;
      }

      parsed.pathname = "/doi/pdf/" + match[1];
      parsed.search = "?download=true";
      parsed.hash = "";
      return parsed.toString();
    } catch (error) {
      return null;
    }
  }

  function findSciencePdfCandidate(input) {
    return deriveSciencePdfUrl(input && input.baseUrl) || root.PiAgentPaperCommon.findPdfCandidate(input);
  }

  root.PiAgentPaperScience = {
    findSciencePdfCandidate: findSciencePdfCandidate
  };
})(globalThis);
