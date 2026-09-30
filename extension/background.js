// Service worker for MIS Volopay 1-Click Sync Bridge
const CLOUDFLARE_ENDPOINTS = [
  "https://mis-expenses-dashboard.zoom-attendance-live.workers.dev/api/volopay/auth",
  "https://mis-expenses-dashboard.abhishek-nitj-002-1.workers.dev/api/volopay/auth"
];

async function pushTokensToCloudflare(tokens) {
  if (!tokens || !tokens.access_token || !tokens.client) {
    return false;
  }
  let anySuccess = false;
  for (const ep of CLOUDFLARE_ENDPOINTS) {
    try {
      const res = await fetch(ep, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(tokens)
      });
      if (res.ok) {
        anySuccess = true;
      }
    } catch (e) {
      console.warn("Failed pushing tokens to Cloudflare endpoint:", ep, e);
    }
  }
  return anySuccess;
}

// Receive tokens extracted directly from open Volopay tab
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "VOLOPAY_TOKENS_EXTRACTED" && message.tokens) {
    chrome.storage.local.set({ volopay_tokens: message.tokens });
    pushTokensToCloudflare(message.tokens);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "GET_VOLOPAY_TOKENS") {
    (async () => {
      // 1. Try to actively read from an open Volopay tab
      try {
        const tabs = await chrome.tabs.query({ url: "*://iskconwhitefield.volopay.co.in/*" });
        if (tabs && tabs.length > 0) {
          const tab = tabs[0];
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              function get(k) { return localStorage.getItem(k) || sessionStorage.getItem(k) || ""; }
              return {
                access_token: get("access-token") || get("accessToken") || "",
                client: get("client") || "",
                uid: get("uid") || "abhishek.nitj.002@gmail.com",
                expiry: get("expiry") || "",
                account: "iskconwhitefield"
              };
            }
          });

          const activeTokens = results?.[0]?.result;
          if (activeTokens && activeTokens.access_token && activeTokens.client) {
            await chrome.storage.local.set({ volopay_tokens: activeTokens });
            await pushTokensToCloudflare(activeTokens);
            sendResponse({ ok: true, tokens: activeTokens, message: "Fresh tokens extracted from open Volopay tab" });
            return;
          }
        }
      } catch (err) {
        console.warn("Could not inspect tab directly:", err);
      }

      // 2. Fall back to cached tokens in chrome.storage.local
      const data = await chrome.storage.local.get("volopay_tokens");
      if (data && data.volopay_tokens) {
        await pushTokensToCloudflare(data.volopay_tokens);
        sendResponse({ ok: true, tokens: data.volopay_tokens, message: "Using cached tokens from recent session" });
        return;
      }

      sendResponse({ ok: false, message: "No active Volopay session found. Please open Volopay in Chrome." });
    })();

    return true; // Keep message channel open for async response
  }
});
