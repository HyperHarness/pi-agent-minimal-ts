(function runPiAgentPaperDownloader(root) {
  var SCIENCE_ACCESS_RETRY_INTERVAL_MS = 1500;
  var SCIENCE_ACCESS_RETRY_TIMEOUT_MS = 15000;
  var APS_ARTICLE_TEXT_RETRY_INTERVAL_MS = 1500;
  var APS_ARTICLE_TEXT_RETRY_TIMEOUT_MS = 15000;
  var APS_MATHJAX_RETRY_INTERVAL_MS = 900;
  var APS_MATHJAX_RETRY_TIMEOUT_MS = 180000;

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

  function countSelectorMatches(rootNode, selector) {
    try {
      return rootNode && typeof rootNode.querySelectorAll === "function"
        ? rootNode.querySelectorAll(selector).length
        : 0;
    } catch (error) {
      return 0;
    }
  }

  function countHtmlMatches(html, pattern) {
    var matches = String(html || "").match(pattern);
    return matches ? matches.length : 0;
  }

  function getMathJaxBridgeMarker(currentDocument, markerName) {
    var targets = [
      currentDocument && currentDocument.body,
      currentDocument && currentDocument.documentElement
    ];
    for (var index = 0; index < targets.length; index += 1) {
      var target = targets[index];
      try {
        if (target && typeof target.getAttribute === "function") {
          var value = target.getAttribute(markerName);
          if (value !== null && value !== undefined && value !== "") {
            return String(value);
          }
        }
      } catch (error) {
        // Try the next marker target.
      }
    }
    return "n/a";
  }

  function collectMathSnapshotDiagnostics(currentDocument, snapshotHtml) {
    if (!currentDocument || !isApsHost(currentDocument.location && currentDocument.location.hostname)) {
      return null;
    }

    return {
      domMath: countSelectorMatches(currentDocument, "math"),
      domAssistive: countSelectorMatches(currentDocument, "mjx-assistive-mml"),
      domMjx: countSelectorMatches(currentDocument, "mjx-container"),
      domLazy: countSelectorMatches(currentDocument, "mjx-lazy"),
      snapshotMath: countHtmlMatches(snapshotHtml, /<math\b/gi),
      snapshotAssistive: countHtmlMatches(snapshotHtml, /<mjx-assistive-mml\b/gi),
      snapshotMjx: countHtmlMatches(snapshotHtml, /<mjx-container\b/gi),
      snapshotLazy: countHtmlMatches(snapshotHtml, /<mjx-lazy\b/gi),
      snapshotFormula: countHtmlMatches(snapshotHtml, /\bclass=["'][^"']*\bmath-formula\b/gi),
      bridgeItems: getMathJaxBridgeMarker(currentDocument, "data-pi-agent-mathjax-items"),
      bridgeRecovered: getMathJaxBridgeMarker(currentDocument, "data-pi-agent-mathjax-recovered"),
      bridgePending: getMathJaxBridgeMarker(currentDocument, "data-pi-agent-mathjax-pending"),
      bridgeLazy: getMathJaxBridgeMarker(currentDocument, "data-pi-agent-mathjax-lazy-containers")
    };
  }

  function formatMathSnapshotDiagnostics(diagnostics) {
    if (!diagnostics) {
      return undefined;
    }

    return [
      "math diagnostics:",
      "dom math=" + diagnostics.domMath + ",",
      "dom assistive=" + diagnostics.domAssistive + ",",
      "dom mjx=" + diagnostics.domMjx + ",",
      "dom lazy=" + diagnostics.domLazy + ",",
      "snapshot math=" + diagnostics.snapshotMath + ",",
      "snapshot assistive=" + diagnostics.snapshotAssistive + ",",
      "snapshot mjx=" + diagnostics.snapshotMjx + ",",
      "snapshot lazy=" + diagnostics.snapshotLazy + ",",
      "snapshot formulas=" + diagnostics.snapshotFormula + ",",
      "bridge items=" + diagnostics.bridgeItems + ",",
      "bridge recovered=" + diagnostics.bridgeRecovered + ",",
      "bridge pending=" + diagnostics.bridgePending + ",",
      "bridge lazy=" + diagnostics.bridgeLazy
    ].join(" ");
  }

  function appendDiagnosticMessage(message, diagnostics) {
    if (!diagnostics) {
      return message;
    }
    return message ? message + " " + diagnostics : diagnostics;
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

  function scoreArticleImageCandidate(image, url) {
    var haystack = [
      url,
      image && image.getAttribute && image.getAttribute("class"),
      image && image.getAttribute && image.getAttribute("alt"),
      image && image.getAttribute && image.getAttribute("aria-label")
    ].join(" ").toLowerCase();
    var score = 0;

    if (/\/article\/[^?#]+\/figures\/\d+\/|\/figures\/\d+\//i.test(url)) {
      score += 200;
    }
    if (/\b(?:article-fulltext|figure|figcaption|lazy-fulltext)\b/i.test(haystack)) {
      score += 80;
    }
    if (/\bfig(?:ure)?\.?\s*\d+\b/i.test(haystack)) {
      score += 60;
    }
    if (/\b(?:badge|metrics?|altmetric|dimensions|rss|logo|icon|social|share|avatar)\b/i.test(haystack)) {
      score -= 200;
    }
    if (/\/(?:assets|static|images?)\/(?:badge|logo|icon|rss|social)/i.test(url)) {
      score -= 120;
    }

    return score;
  }

  function collectArticleImageCandidates(currentDocument) {
    var candidateRoot = selectArticleSnapshotElement(currentDocument);
    if (!candidateRoot || typeof candidateRoot.querySelectorAll !== "function") {
      return [];
    }

    var images = Array.prototype.slice.call(candidateRoot.querySelectorAll("img"));
    images.sort(function compareArticleImagePriority(left, right) {
      var leftUrl =
        (left && (left.currentSrc || (left.getAttribute && (
          left.getAttribute("src") ||
          left.getAttribute("data-src") ||
          left.getAttribute("data-original") ||
          left.getAttribute("data-lazy-src") ||
          firstSrcsetUrl(left.getAttribute("srcset"))
        )))) || "";
      var rightUrl =
        (right && (right.currentSrc || (right.getAttribute && (
          right.getAttribute("src") ||
          right.getAttribute("data-src") ||
          right.getAttribute("data-original") ||
          right.getAttribute("data-lazy-src") ||
          firstSrcsetUrl(right.getAttribute("srcset"))
        )))) || "";
      return scoreArticleImageCandidate(right, rightUrl) - scoreArticleImageCandidate(left, leftUrl);
    });

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

  function getApsLazyMathJaxNodes(rootWindow) {
    if (!isApsHost(rootWindow.location.hostname) || !rootWindow.document) {
      return [];
    }
    try {
      return Array.prototype.slice.call(rootWindow.document.querySelectorAll("mjx-lazy"));
    } catch (error) {
      return [];
    }
  }

  function getApsMathJaxViewportHeight(rootWindow) {
    return typeof rootWindow.innerHeight === "number" && rootWindow.innerHeight > 0
      ? rootWindow.innerHeight
      : 800;
  }

  function getApsMathJaxDocumentSweepY(rootWindow, scrollIndex) {
    var viewportHeight = getApsMathJaxViewportHeight(rootWindow);
    var scrollingElement = rootWindow.document && (
      rootWindow.document.scrollingElement ||
      rootWindow.document.documentElement ||
      rootWindow.document.body
    );
    var scrollHeight = scrollingElement && typeof scrollingElement.scrollHeight === "number"
      ? scrollingElement.scrollHeight
      : 0;
    if (scrollHeight <= viewportHeight) {
      return undefined;
    }

    var maxY = Math.max(0, scrollHeight - viewportHeight);
    var step = Math.max(200, Math.floor(viewportHeight * 0.75));
    var steps = Math.max(1, Math.ceil(maxY / step) + 1);
    var safeScrollIndex = typeof scrollIndex === "number" && scrollIndex >= 0 ? scrollIndex : 0;
    return Math.min(maxY, (safeScrollIndex % steps) * step);
  }

  function getApsMathJaxScrollY(rootWindow, target, scrollIndex) {
    if (typeof scrollIndex === "number" && scrollIndex % 5 === 4) {
      var sweepY = getApsMathJaxDocumentSweepY(rootWindow, scrollIndex);
      if (typeof sweepY === "number") {
        return sweepY;
      }
    }

    var viewportHeight = getApsMathJaxViewportHeight(rootWindow);
    var currentY = typeof rootWindow.pageYOffset === "number"
      ? rootWindow.pageYOffset
      : 0;

    try {
      if (target && typeof target.getBoundingClientRect === "function") {
        var rect = target.getBoundingClientRect();
        if (rect && typeof rect.top === "number" && Number.isFinite(rect.top)) {
          return Math.max(0, currentY + rect.top - viewportHeight / 2);
        }
      }
    } catch (error) {
      // Fall back to a document sweep below.
    }

    return getApsMathJaxDocumentSweepY(rootWindow, scrollIndex);
  }

  function dispatchApsScrollEvent(rootWindow) {
    try {
      if (typeof rootWindow.dispatchEvent === "function" && typeof rootWindow.Event === "function") {
        rootWindow.dispatchEvent(new rootWindow.Event("scroll"));
        rootWindow.dispatchEvent(new rootWindow.Event("resize"));
      }
    } catch (error) {
      // Native browser scrolling already emits this; tests and old browsers may not expose Event.
    }
  }

  function findApsMathJaxScrollTarget(lazyNode) {
    if (!lazyNode || typeof lazyNode.closest !== "function") {
      return lazyNode;
    }

    return (
      lazyNode.closest(
        ".article-fulltext-disp-eq-panel, .article-fulltext-paragraph, figure, table, section, mjx-container"
      ) ||
      lazyNode.closest("mjx-container") ||
      lazyNode
    );
  }

  function collectApsMathJaxMathItems(mathList) {
    if (!mathList) {
      return [];
    }
    if (Array.isArray(mathList)) {
      return mathList;
    }
    if (typeof mathList[Symbol.iterator] === "function") {
      try {
        return Array.prototype.slice.call(mathList);
      } catch (error) {
        // Fall through to MathJax linked-list shapes.
      }
    }
    if (Array.isArray(mathList.items)) {
      return mathList.items;
    }
    if (Array.isArray(mathList.list)) {
      return mathList.list;
    }

    var items = [];
    var node = mathList.head || mathList.first || null;
    var guard = 0;
    while (node && guard < 1000) {
      items.push(node.data || node.item || node);
      node = node.next || null;
      guard += 1;
    }
    return items;
  }

  function getApsMathJaxItemText(item) {
    var candidates = [
      item && item.math,
      item && item.inputData && item.inputData.math,
      item && item.inputData && item.inputData.original,
      item && item.inputData && item.inputData.source,
      item && item.source
    ];
    for (var index = 0; index < candidates.length; index += 1) {
      var text = String(candidates[index] || "").replace(/\s+/g, " ").trim();
      if (text) {
        return text;
      }
    }
    return "";
  }

  function getApsMathJaxItemRoot(item) {
    return (
      item && (
        item.typesetRoot ||
        (item.outputData && (item.outputData.mjx || item.outputData.node || item.outputData.root)) ||
        item.root ||
        null
      )
    );
  }

  function replaceApsLazyMathJaxRoot(currentDocument, rootNode, text, display) {
    if (!currentDocument || !rootNode || !text) {
      return false;
    }

    var target = rootNode;
    try {
      if (
        target &&
        target.tagName &&
        String(target.tagName).toLowerCase() !== "mjx-container" &&
        typeof target.closest === "function"
      ) {
        target = target.closest("mjx-container") || target;
      }
    } catch (error) {
      target = rootNode;
    }

    try {
      if (
        target &&
        typeof target.querySelector === "function" &&
        !target.querySelector("mjx-lazy")
      ) {
        return false;
      }
    } catch (error) {
      // If the target exposes a parent node, still try the replacement.
    }

    if (!target || !target.parentNode || typeof target.parentNode.replaceChild !== "function") {
      return false;
    }

    var replacement = currentDocument.createElement(display ? "div" : "span");
    replacement.className = display ? "math-formula display" : "math-formula";
    replacement.textContent = text;
    target.parentNode.replaceChild(replacement, target);
    return true;
  }

  function recoverApsMathJaxFromMathDocument(rootWindow) {
    if (!isApsHost(rootWindow.location.hostname) || !rootWindow.document) {
      return 0;
    }

    var mathDocument = rootWindow.MathJax &&
      rootWindow.MathJax.startup &&
      rootWindow.MathJax.startup.document;
    var items = collectApsMathJaxMathItems(mathDocument && mathDocument.math);
    var recovered = 0;
    for (var index = 0; index < items.length; index += 1) {
      var item = items[index];
      var text = getApsMathJaxItemText(item);
      var rootNode = getApsMathJaxItemRoot(item);
      if (
        replaceApsLazyMathJaxRoot(
          rootWindow.document,
          rootNode,
          text,
          Boolean(item && item.display)
        )
      ) {
        recovered += 1;
      }
    }
    return recovered;
  }

  function ensureApsMathJaxBridge(rootWindow) {
    if (!isApsHost(rootWindow.location.hostname) || !rootWindow.document) {
      return false;
    }
    var currentDocument = rootWindow.document;
    var documentElement = currentDocument.documentElement;
    if (
      documentElement &&
      documentElement.getAttribute &&
      documentElement.getAttribute("data-pi-agent-mathjax-bridge-injected") === "true"
    ) {
      return true;
    }
    if (
      !rootWindow.chrome ||
      !rootWindow.chrome.runtime ||
      typeof rootWindow.chrome.runtime.getURL !== "function" ||
      typeof currentDocument.createElement !== "function"
    ) {
      return false;
    }

    try {
      var script = currentDocument.createElement("script");
      script.src = rootWindow.chrome.runtime.getURL("content/mathjax-bridge.js");
      script.async = false;
      script.onload = function removeLoadedBridgeScript() {
        if (script.parentNode && typeof script.parentNode.removeChild === "function") {
          script.parentNode.removeChild(script);
        }
      };
      var parent = currentDocument.head || documentElement || currentDocument.body;
      if (!parent || typeof parent.appendChild !== "function") {
        return false;
      }
      parent.appendChild(script);
      if (documentElement && documentElement.setAttribute) {
        documentElement.setAttribute("data-pi-agent-mathjax-bridge-injected", "true");
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  function requestApsMathJaxPageRecovery(rootWindow) {
    ensureApsMathJaxBridge(rootWindow);
    try {
      if (
        rootWindow.document &&
        typeof rootWindow.document.dispatchEvent === "function" &&
        typeof rootWindow.CustomEvent === "function"
      ) {
        rootWindow.document.dispatchEvent(new rootWindow.CustomEvent("pi-agent-paper-recover-mathjax"));
      }
    } catch (error) {
      // The bridge also runs once on load; repeated recovery is best-effort.
    }
  }

  function triggerApsMathJaxRendering(rootWindow, scrollIndex) {
    var mathJax = rootWindow.MathJax;
    try {
      if (mathJax && typeof mathJax.typesetPromise === "function") {
        mathJax.typesetPromise();
      } else if (mathJax && typeof mathJax.typeset === "function") {
        mathJax.typeset();
      }
    } catch (error) {
      // APS lazy placeholders are still nudged into view below.
    }

    var lazyNodes = getApsLazyMathJaxNodes(rootWindow);
    if (lazyNodes.length === 0) {
      try {
        if (typeof rootWindow.scrollTo === "function") {
          rootWindow.scrollTo(0, 0);
        }
      } catch (error) {
        // Restoring the scroll position is best-effort only.
      }
      return 0;
    }

    var safeScrollIndex = typeof scrollIndex === "number" && scrollIndex >= 0 ? scrollIndex : 0;
    var targetIndex = safeScrollIndex % lazyNodes.length;

    var lazyNode = lazyNodes[targetIndex];
    var target = findApsMathJaxScrollTarget(lazyNode);
    try {
      if (target && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ block: "center", inline: "nearest" });
      }
    } catch (error) {
      // Keep trying the remaining formulas.
    }

    try {
      if (typeof rootWindow.scrollTo === "function") {
        var scrollY = getApsMathJaxScrollY(rootWindow, target, safeScrollIndex);
        if (typeof scrollY === "number") {
          rootWindow.scrollTo(0, scrollY);
          dispatchApsScrollEvent(rootWindow);
        }
      }
    } catch (error) {
      // Element-level scrolling above is still useful in browser contexts that block window scrolling.
    }

    return safeScrollIndex + 1;
  }

  function shouldWaitForApsMathJax(rootWindow, classification) {
    if (
      !isApsHost(rootWindow.location.hostname) ||
      classification.status !== "page_classified" ||
      !rootWindow.document ||
      !rootWindow.document.body
    ) {
      return false;
    }

    return getApsLazyMathJaxNodes(rootWindow).length > 0;
  }

  function buildMessage() {
    ensureApsMathJaxBridge(root);
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

    if (classification.status === "page_classified") {
      requestApsMathJaxPageRecovery(root);
      recoverApsMathJaxFromMathDocument(root);
    }

    var supplementalMaterials = classification.status === "page_classified"
      ? supplementalHelper({
        document: root.document,
        baseUrl: root.location.href
      })
      : undefined;
    var snapshotHtml = classification.status === "page_classified"
      ? collectArticleSnapshotHtml(root.document)
      : undefined;
    var mathDiagnostics = snapshotHtml
      ? formatMathSnapshotDiagnostics(collectMathSnapshotDiagnostics(root.document, snapshotHtml))
      : undefined;
    var message = {
      type: "paper_page_classified",
      status: classification.status,
      message: appendDiagnosticMessage(classification.message, mathDiagnostics),
      pdfUrl: pdfUrl,
      finalUrl: root.location.href,
      title: root.document.title,
      html: snapshotHtml,
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
      shouldWaitForApsMathJax: shouldWaitForApsMathJax(root, classification),
      message: message
    };
  }

  function sendWhenReady(state) {
    var result = buildMessage();
    if (result.shouldWait && Date.now() - state.startedAt < SCIENCE_ACCESS_RETRY_TIMEOUT_MS) {
      root.setTimeout(function retryScienceAccessSnapshot() {
        sendWhenReady(state);
      }, SCIENCE_ACCESS_RETRY_INTERVAL_MS);
      return;
    }

    if (
      result.shouldWaitForApsArticleText &&
      Date.now() - state.startedAt < APS_ARTICLE_TEXT_RETRY_TIMEOUT_MS
    ) {
      activateApsArticleText(root);
      root.setTimeout(function retryApsArticleTextSnapshot() {
        sendWhenReady({
          startedAt: state.startedAt,
          apsMathJaxStartedAt: undefined
        });
      }, APS_ARTICLE_TEXT_RETRY_INTERVAL_MS);
      return;
    }

    if (result.shouldWaitForApsMathJax) {
      var mathJaxStartedAt = typeof state.apsMathJaxStartedAt === "number"
        ? state.apsMathJaxStartedAt
        : Date.now();
      if (Date.now() - mathJaxStartedAt < APS_MATHJAX_RETRY_TIMEOUT_MS) {
        var nextMathJaxScrollIndex = triggerApsMathJaxRendering(root, state.apsMathJaxScrollIndex);
        root.setTimeout(function retryApsMathJaxSnapshot() {
          sendWhenReady({
            startedAt: state.startedAt,
            apsMathJaxStartedAt: mathJaxStartedAt,
            apsMathJaxScrollIndex: nextMathJaxScrollIndex
          });
        }, APS_MATHJAX_RETRY_INTERVAL_MS);
        return;
      }
    }

    root.chrome.runtime.sendMessage(result.message);
  }

  sendWhenReady({ startedAt: Date.now() });
})(globalThis);
