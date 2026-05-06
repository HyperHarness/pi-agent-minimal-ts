(function installPiAgentPaperNature(root) {
  function findNaturePdfCandidate(input) {
    return root.PiAgentPaperCommon.findPdfCandidate(input);
  }

  root.PiAgentPaperNature = {
    findNaturePdfCandidate: findNaturePdfCandidate
  };
})(globalThis);
