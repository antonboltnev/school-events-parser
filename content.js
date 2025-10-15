chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "highlightText" && msg.text) {
        const node = [...document.querySelectorAll("*")].find(el =>
            el.textContent.includes(msg.text)
        );
        if (node) {
            node.scrollIntoView({ behavior: "smooth", block: "center" });
            node.style.backgroundColor = "yellow";
            setTimeout(() => (node.style.backgroundColor = ""), 2000);
        }
    }
});
