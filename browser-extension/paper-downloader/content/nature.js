(function installPiAgentPaperNature(root) {
  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function findNaturePdfCandidate(input) {
    return root.PiAgentPaperCommon.findPdfCandidate(input);
  }

  function resolveCandidateUrl(href, baseUrl) {
    try {
      return new URL(href, baseUrl).toString();
    } catch (error) {
      return null;
    }
  }

  function isNatureArticlePdfUrl(value) {
    try {
      var parsed = new URL(value);
      var hostname = parsed.hostname.toLowerCase();
      return (
        (hostname === "www.nature.com" || hostname === "nature.com") &&
        /^\/articles\/[^/?#]+\.pdf$/i.test(parsed.pathname)
      );
    } catch (error) {
      return false;
    }
  }

  function isNatureSupplementalPdfUrl(value) {
    try {
      var parsed = new URL(value);
      var hostname = parsed.hostname.toLowerCase();
      var decodedPath = decodeURIComponent(parsed.pathname);
      var normalizedPath = decodedPath.toLowerCase();
      if (!/\.pdf$/i.test(parsed.pathname)) {
        return false;
      }
      if (isNatureArticlePdfUrl(value)) {
        return false;
      }
      if (hostname === "static-content.springer.com") {
        return normalizedPath.indexOf("/esm/") !== -1 || normalizedPath.indexOf("/mediaobjects/") !== -1;
      }
      if (hostname === "media.springernature.com") {
        return normalizedPath.indexOf("mediaobjects") !== -1 ||
          normalizedPath.indexOf("moesm") !== -1 ||
          normalizedPath.indexOf("_esm") !== -1;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  function isNatureSupplementalText(value) {
    var text = normalizeText(value).toLowerCase();
    return (
      text.indexOf("supplementary information") !== -1 ||
      text.indexOf("supplementary material") !== -1 ||
      text.indexOf("supplemental material") !== -1
    );
  }

  function findNatureSupplementalMaterialCandidates(input) {
    var currentDocument = input && input.document;
    var baseUrl = input && input.baseUrl;
    if (!currentDocument || !baseUrl || typeof currentDocument.querySelectorAll !== "function") {
      return [];
    }

    var anchors = currentDocument.querySelectorAll("a[href]");
    var seen = {};
    var results = [];
    for (var index = 0; index < anchors.length; index += 1) {
      var anchor = anchors[index];
      var href = typeof anchor.getAttribute === "function" ? anchor.getAttribute("href") : anchor.href;
      if (!href) {
        continue;
      }

      var candidate = resolveCandidateUrl(href, baseUrl);
      if (!candidate || seen[candidate] || !isNatureSupplementalPdfUrl(candidate)) {
        continue;
      }

      seen[candidate] = true;
      results.push({
        url: candidate,
        title: isNatureSupplementalText(anchor && anchor.textContent)
          ? normalizeText(anchor && anchor.textContent)
          : "Supplementary information"
      });
    }

    return results;
  }

  root.PiAgentPaperNature = {
    findNaturePdfCandidate: findNaturePdfCandidate,
    findNatureSupplementalMaterialCandidates: findNatureSupplementalMaterialCandidates
  };
})(globalThis);
