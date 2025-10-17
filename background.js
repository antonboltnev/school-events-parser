// background.js (Manifest V3 Service Worker)
const extractionCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // expire after 10 minutes

// Listen for any runtime messages if needed
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // In case popup wants to refresh or revoke the token, you can add logic here.
    if (msg.action === "revokeToken") {
        chrome.identity.getAuthToken({ interactive: false }, (token) => {
            if (token) {
                chrome.identity.removeCachedAuthToken({ token }, () => {
                    console.log("Auth token revoked.");
                    sendResponse({ success: true });
                });
            } else {
                sendResponse({ success: false });
            }
        });
        return true; // Keep message channel open for async sendResponse
    }

    // Example: simple ping-pong check
    if (msg.action === "ping") {
        sendResponse({ message: "pong" });
        return;
    }

    if (msg.action === "cache:get" && msg.fingerprint) {
        const entry = extractionCache.get(msg.fingerprint);
        if (entry && Date.now() - entry.timestamp > CACHE_TTL_MS) {
            extractionCache.delete(msg.fingerprint);
            sendResponse({ entry: null });
        } else {
            sendResponse({ entry: entry ? { text: entry.text, events: entry.events } : null });
        }
        return;
    }

    if (msg.action === "cache:set" && msg.fingerprint && msg.payload) {
        extractionCache.set(msg.fingerprint, {
            text: msg.payload.text,
            events: msg.payload.events,
            timestamp: Date.now(),
        });
        sendResponse({ success: true });
        return;
    }

    if (msg.action === "cache:clear" && msg.fingerprint) {
        extractionCache.delete(msg.fingerprint);
        sendResponse({ success: true });
        return;
    }
});
