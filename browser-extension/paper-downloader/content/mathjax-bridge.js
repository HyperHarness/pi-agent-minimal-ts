(function installPiAgentPaperMathJaxBridge(root) {
  if (root.__piAgentPaperMathJaxBridgeInstalled) {
    return;
  }
  root.__piAgentPaperMathJaxBridgeInstalled = true;

  function collectMathItems(mathList) {
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

  function mathItemText(item) {
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

  function mathItemRoot(item) {
    return (
      item && (
        item.typesetRoot ||
        (item.outputData && (item.outputData.mjx || item.outputData.node || item.outputData.root)) ||
        item.root ||
        null
      )
    );
  }

  function replaceLazyRoot(rootNode, text, display) {
    if (!rootNode || !text) {
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
      // If parent replacement is available, still try it.
    }

    if (!target || !target.parentNode || typeof target.parentNode.replaceChild !== "function") {
      return false;
    }

    var replacement = root.document.createElement(display ? "div" : "span");
    replacement.className = display ? "math-formula display" : "math-formula";
    replacement.textContent = text;
    target.parentNode.replaceChild(replacement, target);
    return true;
  }

  function collectLazyContainers() {
    try {
      var containers = Array.prototype.slice.call(root.document.querySelectorAll("mjx-container"));
      return containers.filter(function keepLazyContainer(container) {
        try {
          return container && typeof container.querySelector === "function" && container.querySelector("mjx-lazy");
        } catch (error) {
          return false;
        }
      });
    } catch (error) {
      return [];
    }
  }

  function recoverMathJax() {
    var mathDocument = root.MathJax && root.MathJax.startup && root.MathJax.startup.document;
    var items = collectMathItems(mathDocument && mathDocument.math);
    var recovered = 0;
    var pending = [];
    for (var index = 0; index < items.length; index += 1) {
      var item = items[index];
      var text = mathItemText(item);
      var itemRoot = mathItemRoot(item);
      if (replaceLazyRoot(itemRoot, text, Boolean(item && item.display))) {
        recovered += 1;
        continue;
      }

      if (!text) {
        continue;
      }
      if (itemRoot && typeof itemRoot.querySelector === "function") {
        try {
          if (!itemRoot.querySelector("mjx-lazy")) {
            continue;
          }
        } catch (error) {
          // Keep it as a pending candidate below.
        }
      }
      pending.push({
        text: text,
        display: Boolean(item && item.display)
      });
    }

    var lazyContainers = collectLazyContainers();
    var fallbackCount = Math.min(pending.length, lazyContainers.length);
    for (var fallbackIndex = 0; fallbackIndex < fallbackCount; fallbackIndex += 1) {
      if (
        replaceLazyRoot(
          lazyContainers[fallbackIndex],
          pending[fallbackIndex].text,
          pending[fallbackIndex].display
        )
      ) {
        recovered += 1;
      }
    }

    try {
      var markerTargets = [root.document.documentElement, root.document.body].filter(Boolean);
      for (var markerIndex = 0; markerIndex < markerTargets.length; markerIndex += 1) {
        markerTargets[markerIndex].setAttribute("data-pi-agent-mathjax-recovered", String(recovered));
        markerTargets[markerIndex].setAttribute("data-pi-agent-mathjax-items", String(items.length));
        markerTargets[markerIndex].setAttribute("data-pi-agent-mathjax-pending", String(pending.length));
        markerTargets[markerIndex].setAttribute("data-pi-agent-mathjax-lazy-containers", String(lazyContainers.length));
        markerTargets[markerIndex].setAttribute("data-pi-agent-mathjax-bridge", "ready");
      }
    } catch (error) {
      // DOM instrumentation is best-effort only.
    }
    return recovered;
  }

  function startRecoveryPolling() {
    var startedAt = Date.now();
    var interval = root.setInterval(function pollMathJaxRecovery() {
      var recovered = recoverMathJax();
      var remaining = collectLazyContainers().length;
      if (
        remaining === 0 ||
        recovered > 0 ||
        Date.now() - startedAt > 120000
      ) {
        root.clearInterval(interval);
      }
    }, 500);
  }

  root.document.addEventListener("pi-agent-paper-recover-mathjax", recoverMathJax);
  recoverMathJax();
  startRecoveryPolling();
})(window);
