// Injected on https://mis-expenses-dashboard.zoom-attendance-live.workers.dev/*
(function () {
  // Signal to the dashboard that the 1-click bridge extension is active
  window.__MIS_VOLOPAY_EXTENSION_INSTALLED = true;
  document.documentElement.setAttribute("data-mis-bridge", "installed");

  window.dispatchEvent(new CustomEvent("MIS_BRIDGE_READY"));

  // Listen for sync initiation events from the Dashboard webpage
  window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "MIS_REQUEST_FRESH_TOKENS") {
      chrome.runtime.sendMessage({ type: "GET_VOLOPAY_TOKENS" }, (response) => {
        window.postMessage({
          type: "MIS_TOKENS_READY",
          ok: response ? response.ok : false,
          tokens: response ? response.tokens : null,
          message: response ? response.message : "Extension communication failed"
        }, "*");
      });
    }
  });
})();
