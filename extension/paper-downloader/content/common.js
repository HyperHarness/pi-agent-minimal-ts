(function installPiAgentPaperCommon(root) {
  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function classifyPage(input) {
    var url = normalizeText(input && input.url).toLowerCase();
    var title = normalizeText(input && input.title).toLowerCase();
    var text = normalizeText(input && input.text).toLowerCase();
    var combined = [url, title, text].join(" ");

    var needsVerification =
      url.indexOf("/cdn-cgi/") !== -1 ||
      combined.indexOf("just a moment") !== -1 ||
      combined.indexOf("checking if the site connection is secure") !== -1 ||
      combined.indexOf("cloudflare") !== -1 ||
      combined.indexOf("captcha") !== -1 ||
      combined.indexOf("verify you are human") !== -1 ||
      url.indexOf("/login") !== -1 ||
      url.indexOf("/signin") !== -1 ||
      /^(login|log in|sign in|sign-in)$/.test(title) ||
      text.indexOf("sign in through your institution") !== -1 ||
      text.indexOf("log in through your institution") !== -1;

    if (needsVerification) {
      return {
        status: "awaiting_user_verification",
        message: "This page appears to require user verification before download can continue."
      };
    }

    return { status: "page_classified" };
  }

  function resolveCandidateUrl(href, baseUrl) {
    try {
      return new URL(href, baseUrl).toString();
    } catch (error) {
      return null;
    }
  }

  function isPdfCandidate(anchor, href) {
    var text = normalizeText(anchor && anchor.textContent).toLowerCase();
    var normalizedHref = normalizeText(href).toLowerCase();

    return (
      /\.pdf(?:[?#]|$)/i.test(normalizedHref) ||
      normalizedHref.indexOf("/pdf/") !== -1 ||
      normalizedHref.indexOf("type=pdf") !== -1 ||
      normalizedHref.indexOf("download=pdf") !== -1 ||
      (text.indexOf("pdf") !== -1 && normalizedHref.indexOf("download") !== -1) ||
      (text.indexOf("download") !== -1 && normalizedHref.indexOf("pdf") !== -1)
    );
  }

  function findPdfCandidate(input) {
    var currentDocument = input && input.document;
    var baseUrl = input && input.baseUrl;
    if (!currentDocument || !baseUrl || typeof currentDocument.querySelectorAll !== "function") {
      return null;
    }

    var anchors = currentDocument.querySelectorAll("a[href]");
    for (var index = 0; index < anchors.length; index += 1) {
      var anchor = anchors[index];
      var href =
        typeof anchor.getAttribute === "function" ? anchor.getAttribute("href") : anchor.href;
      if (!href || !isPdfCandidate(anchor, href)) {
        continue;
      }

      var candidate = resolveCandidateUrl(href, baseUrl);
      if (candidate) {
        return candidate;
      }
    }

    return null;
  }

  root.PiAgentPaperCommon = {
    classifyPage: classifyPage,
    findPdfCandidate: findPdfCandidate
  };
})(globalThis);
