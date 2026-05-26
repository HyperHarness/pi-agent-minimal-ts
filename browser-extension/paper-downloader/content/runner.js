(function runPiAgentPaperDownloader(root) {
  var SCIENCE_ACCESS_RETRY_INTERVAL_MS = 1500;
  var SCIENCE_ACCESS_RETRY_TIMEOUT_MS = 15000;
  var APS_ARTICLE_TEXT_RETRY_INTERVAL_MS = 1500;
  var APS_ARTICLE_TEXT_RETRY_TIMEOUT_MS = 15000;

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

  function chooseSupplementalMaterialHelper(hostname) {
    var normalizedHostname = String(hostname || "").toLowerCase();
    if (normalizedHostname === "journals.aps.org" || normalizedHostname === "aps.org") {
      return root.PiAgentPaperAps.findApsSupplementalMaterialCandidates;
    }

    return root.PiAgentPaperCommon.findSupplementalMaterialCandidates;
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

  function isApsHost(hostname) {
    var normalizedHostname = String(hostname || "").toLowerCase();
    return normalizedHostname === "journals.aps.org" || normalizedHostname === "aps.org";
  }

  function selectArticleSnapshotElement(currentDocument) {
    if (!currentDocument || !currentDocument.documentElement) {
      return null;
    }

    if (isApsHost(currentDocument.location && currentDocument.location.hostname)) {
      return currentDocument.body;
    }

    return (
      currentDocument.querySelector("main[data-track-component*='article body' i]") ||
      currentDocument.querySelector("main[class*='article' i]") ||
      currentDocument.querySelector("article") ||
      currentDocument.querySelector("main") ||
      currentDocument.body
    );
  }

  function collectArticleSnapshotHtml(currentDocument) {
    if (!currentDocument || !currentDocument.documentElement) {
      return "";
    }

    var candidate = selectArticleSnapshotElement(currentDocument);
    var headHtml = currentDocument.head ? currentDocument.head.innerHTML : "";
    var bodyHtml = candidate ? candidate.outerHTML : currentDocument.documentElement.outerHTML;
    return "<!doctype html><html><head>" + headHtml + "</head><body>" + bodyHtml + "</body></html>";
  }

  function firstSrcsetUrl(value) {
    var candidate = String(value || "").split(",", 1)[0] || "";
    return candidate.trim().split(/\s+/, 1)[0] || "";
  }

  function filenameFromUrl(value) {
    try {
      var parsed = new URL(value);
      var parts = decodeURIComponent(parsed.pathname).split("/");
      return parts[parts.length - 1] || undefined;
    } catch (error) {
      return undefined;
    }
  }

  function collectArticleImageCandidates(currentDocument) {
    var candidateRoot = selectArticleSnapshotElement(currentDocument);
    if (!candidateRoot || typeof candidateRoot.querySelectorAll !== "function") {
      return [];
    }

    var images = Array.prototype.slice.call(candidateRoot.querySelectorAll("img"));
    var seen = {};
    var results = [];
    for (var index = 0; index < images.length && results.length < 40; index += 1) {
      var image = images[index];
      var originalUrl =
        image.getAttribute("src") ||
        image.getAttribute("data-src") ||
        image.getAttribute("data-original") ||
        image.getAttribute("data-lazy-src") ||
        firstSrcsetUrl(image.getAttribute("srcset"));
      var fetchUrl = image.currentSrc || originalUrl;
      if (!fetchUrl) {
        continue;
      }
      if (String(fetchUrl).indexOf("data:") === 0) {
        continue;
      }

      try {
        var absoluteUrl = new URL(fetchUrl, currentDocument.baseURI || root.location.href).toString();
        if (seen[absoluteUrl]) {
          continue;
        }
        seen[absoluteUrl] = true;
        results.push({
          url: absoluteUrl,
          originalUrl: originalUrl || fetchUrl,
          filename: filenameFromUrl(absoluteUrl),
          alt: image.getAttribute("alt") || undefined
        });
      } catch (error) {
        // Ignore malformed image URLs.
      }
    }

    return results;
  }

  function isScienceHost(hostname) {
    var normalizedHostname = String(hostname || "").toLowerCase();
    return normalizedHostname === "www.science.org" || normalizedHostname === "science.org";
  }

  function hasScienceAccessWall(text) {
    var normalizedText = String(text || "").replace(/\s+/g, " ").toLowerCase();
    return (
      normalizedText.indexOf("access the full article") !== -1 ||
      normalizedText.indexOf("view all access options to continue reading this article") !== -1 ||
      normalizedText.indexOf("check access") !== -1 ||
      normalizedText.indexOf("log in to view the full text") !== -1 ||
      normalizedText.indexOf("aaas id login") !== -1 ||
      normalizedText.indexOf("purchase digital access to this article") !== -1
    );
  }

  function shouldWaitForScienceAccess(rootWindow, classification, pdfUrl) {
    if (
      !isScienceHost(rootWindow.location.hostname) ||
      classification.status !== "page_classified"
    ) {
      return false;
    }

    var bodyText = rootWindow.document.body ? rootWindow.document.body.innerText : "";
    var documentHtml = rootWindow.document.documentElement
      ? rootWindow.document.documentElement.innerHTML
      : "";
    return hasScienceAccessWall(bodyText + " " + documentHtml);
  }

  function normalizeVisibleText(text) {
    return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function getApsArticleTextPanelText(rootWindow) {
    var text = normalizeVisibleText(rootWindow.document.body ? rootWindow.document.body.innerText : "");
    var articleIndex = text.indexOf("article text");
    if (articleIndex === -1) {
      return "";
    }

    var tail = text.slice(articleIndex + "article text".length);
    var stopIndexes = [
      tail.indexOf("supplemental material"),
      tail.indexOf("references"),
      tail.indexOf("reuse & permissions")
    ].filter(function keepFoundIndex(index) {
      return index > 0;
    });
    var stopIndex = stopIndexes.length > 0 ? Math.min.apply(Math, stopIndexes) : tail.length;
    return tail.slice(0, stopIndex).trim();
  }

  function hasApsArticleTextLoaded(rootWindow) {
    var panelText = getApsArticleTextPanelText(rootWindow);
    return panelText.split(/\s+/).filter(Boolean).length >= 120;
  }

  function findApsArticleTextControl(currentDocument) {
    var candidates = Array.prototype.slice.call(
      currentDocument.querySelectorAll("a, button, [role='tab'], [role='button']")
    );
    for (var index = 0; index < candidates.length; index += 1) {
      var element = candidates[index];
      var label = normalizeVisibleText(
        [
          element.textContent,
          element.getAttribute && element.getAttribute("aria-label"),
          element.getAttribute && element.getAttribute("title"),
          element.getAttribute && element.getAttribute("href")
        ].join(" ")
      );
      if (label.indexOf("article text") !== -1 || label.indexOf("full text") !== -1) {
        return element;
      }
    }

    return null;
  }

  function activateApsArticleText(rootWindow) {
    if (!isApsHost(rootWindow.location.hostname)) {
      return false;
    }

    var control = findApsArticleTextControl(rootWindow.document);
    if (control && typeof control.click === "function") {
      control.click();
      return true;
    }

    try {
      if (rootWindow.location.hash !== "#article-text") {
        rootWindow.location.hash = "article-text";
        return true;
      }
    } catch (error) {
      return false;
    }

    return false;
  }

  function shouldWaitForApsArticleText(rootWindow, classification) {
    if (
      !isApsHost(rootWindow.location.hostname) ||
      classification.status !== "page_classified"
    ) {
      return false;
    }

    var pageText = normalizeVisibleText(rootWindow.document.body ? rootWindow.document.body.innerText : "");
    return pageText.indexOf("article text") !== -1 && !hasApsArticleTextLoaded(rootWindow);
  }

  function buildMessage() {
    var helper = choosePublisherHelper(root.location.hostname);
    var supplementalHelper = chooseSupplementalMaterialHelper(root.location.hostname);
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

    var supplementalMaterials = classification.status === "page_classified"
      ? supplementalHelper({
        document: root.document,
        baseUrl: root.location.href
      })
      : undefined;
    var message = {
      type: "paper_page_classified",
      status: classification.status,
      message: classification.message,
      pdfUrl: pdfUrl,
      finalUrl: root.location.href,
      title: root.document.title,
      html: classification.status === "page_classified"
        ? collectArticleSnapshotHtml(root.document)
        : undefined,
      webpageAssets: classification.status === "page_classified"
        ? collectArticleImageCandidates(root.document)
        : undefined
    };
    if (supplementalMaterials && supplementalMaterials.length > 0) {
      message.supplementalMaterials = supplementalMaterials;
    }

    return {
      classification: classification,
      pdfUrl: pdfUrl,
      shouldWait: shouldWaitForScienceAccess(root, classification, pdfUrl),
      shouldWaitForApsArticleText: shouldWaitForApsArticleText(root, classification),
      message: message
    };
  }

  function sendWhenReady(startedAt) {
    var result = buildMessage();
    if (result.shouldWait && Date.now() - startedAt < SCIENCE_ACCESS_RETRY_TIMEOUT_MS) {
      root.setTimeout(function retryScienceAccessSnapshot() {
        sendWhenReady(startedAt);
      }, SCIENCE_ACCESS_RETRY_INTERVAL_MS);
      return;
    }

    if (
      result.shouldWaitForApsArticleText &&
      Date.now() - startedAt < APS_ARTICLE_TEXT_RETRY_TIMEOUT_MS
    ) {
      activateApsArticleText(root);
      root.setTimeout(function retryApsArticleTextSnapshot() {
        sendWhenReady(startedAt);
      }, APS_ARTICLE_TEXT_RETRY_INTERVAL_MS);
      return;
    }

    root.chrome.runtime.sendMessage(result.message);
  }

  sendWhenReady(Date.now());
})(globalThis);
