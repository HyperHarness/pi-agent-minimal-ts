(function runPiAgentPaperDownloader(root) {
  function choosePublisherHelper(hostname) {
    var normalizedHostname = String(hostname || "").toLowerCase();
    if (normalizedHostname === "www.nature.com" || normalizedHostname === "nature.com") {
      return root.PiAgentPaperNature.findNaturePdfCandidate;
    }
    if (normalizedHostname === "www.science.org" || normalizedHostname === "science.org") {
      return root.PiAgentPaperScience.findSciencePdfCandidate;
    }
    if (normalizedHostname === "journals.aps.org" || normalizedHostname === "aps.org") {
      return root.PiAgentPaperAps.findApsPdfCandidate;
    }

    return root.PiAgentPaperCommon.findPdfCandidate;
  }

  function isChallengePage(url, title, text) {
    var combined = [url, title, text].join(" ").toLowerCase();
    return (
      String(url || "").toLowerCase().indexOf("/cdn-cgi/") !== -1 ||
      combined.indexOf("just a moment") !== -1 ||
      combined.indexOf("checking if the site connection is secure") !== -1 ||
      combined.indexOf("cloudflare") !== -1 ||
      combined.indexOf("captcha") !== -1 ||
      combined.indexOf("verify you are human") !== -1
    );
  }

  var helper = choosePublisherHelper(root.location.hostname);
  var pageText = root.document.body ? root.document.body.innerText : "";
  var classification = root.PiAgentPaperCommon.classifyPage({
    url: root.location.href,
    title: root.document.title,
    text: pageText
  });
  var pdfUrl = null;

  if (!isChallengePage(root.location.href, root.document.title, pageText)) {
    pdfUrl = helper({
      document: root.document,
      baseUrl: root.location.href
    });
    if (pdfUrl) {
      classification = { status: "page_classified" };
    }
  }

  root.chrome.runtime.sendMessage({
    type: "paper_page_classified",
    status: classification.status,
    message: classification.message,
    pdfUrl: pdfUrl
  });
})(globalThis);
