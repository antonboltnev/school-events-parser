// background.js (Manifest V3 Service Worker)

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
    }
});
