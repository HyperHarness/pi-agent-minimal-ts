(function installPiAgentPaperScience(root) {
  function findSciencePdfCandidate(input) {
    return root.PiAgentPaperCommon.findPdfCandidate(input);
  }

  root.PiAgentPaperScience = {
    findSciencePdfCandidate: findSciencePdfCandidate
  };
})(globalThis);
