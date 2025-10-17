pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("libs/pdf.worker.min.js");

const textEncoder = new TextEncoder();

function toHex(buffer) {
    return Array.from(new Uint8Array(buffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

async function hashValue(value) {
    let data;
    if (typeof value === "string") {
        data = textEncoder.encode(value);
    } else if (value instanceof ArrayBuffer) {
        data = value;
    } else if (ArrayBuffer.isView(value)) {
        data = value.buffer;
    } else if (value != null) {
        data = textEncoder.encode(JSON.stringify(value));
    } else {
        data = textEncoder.encode("");
    }

    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return toHex(hashBuffer);
}

function normalizePathname(pathname = "") {
    if (!pathname) return "/";
    const collapsed = pathname.replace(/\/+/g, "/");
    if (collapsed.length > 1 && collapsed.endsWith("/")) {
        return collapsed.slice(0, -1);
    }
    return collapsed || "/";
}

function buildFingerprint(urlStr, variant, signature) {
    try {
        const parsed = new URL(urlStr);
        const normalizedPath = normalizePathname(parsed.pathname);
        return `${parsed.origin}${normalizedPath}|${variant}|${signature}`;
    } catch {
        return `${urlStr}|${variant}|${signature}`;
    }
}

function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(response);
        });
    });
}

const cacheApi = {
    async get(fingerprint) {
        try {
            const res = await runtimeMessage({ action: "cache:get", fingerprint });
            return res?.entry || null;
        } catch (err) {
            console.warn("Cache lookup failed:", err);
            return null;
        }
    },
    async set(fingerprint, payload) {
        try {
            await runtimeMessage({ action: "cache:set", fingerprint, payload });
        } catch (err) {
            console.warn("Cache write failed:", err);
        }
    },
    async clear(fingerprint) {
        try {
            await runtimeMessage({ action: "cache:clear", fingerprint });
        } catch (err) {
            console.warn("Cache clear failed:", err);
        }
    },
};

function normalizeDateRange(dateStr) {
    if (!dateStr) return dateStr;

    // 🧹 Remove prefixes like "Starting", "From", "On"
    dateStr = dateStr.replace(/^\s*(starting|from|on|beginning|begins|begin)\s+/i, "");

    // Remove ordinal suffixes (1st, 2nd, 3rd, 8th)
    dateStr = dateStr.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1");

    // Handle ranges "2025-10-20 to 2025-10-31"
    const rangeMatch = dateStr.match(
        /\b(\d{4}-\d{1,2}-\d{1,2})\s*(?:to|–|-)\s*(\d{4}-\d{1,2}-\d{1,2})\b/i
    );
    if (rangeMatch) return rangeMatch[1];

    // Handle "20 Oct to 31 Oct"
    const altRange = dateStr.match(/\b(\d{1,2}\s+\w+)\s*(?:to|–|-)\s*(\d{1,2}\s+\w+)/i);
    if (altRange) return altRange[1];

    // Try parsing the cleaned string
    const parsed = new Date(dateStr);
    if (!isNaN(parsed)) {
        const yyyy = parsed.getFullYear();
        const mm = String(parsed.getMonth() + 1).padStart(2, "0");
        const dd = String(parsed.getDate()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd}`;
    }

    return dateStr.trim();
}

function getNextWeekdayDate(weekday) {
    const map = {
        SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6
    };
    const today = new Date();
    const dayOfWeek = today.getDay();
    const targetDay = map[weekday];
    const diff = (targetDay + 7 - dayOfWeek) % 7;
    const next = new Date(today);
    next.setDate(today.getDate() + diff);
    return next;
}

function detectRecurrence(dateText) {
    const map = {
        monday: "MO",
        tuesday: "TU",
        wednesday: "WE",
        thursday: "TH",
        friday: "FR",
        saturday: "SA",
        sunday: "SU",
    };
    const lower = dateText.toLowerCase();
    const matches = [...lower.matchAll(/(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/g)]
        .map((m) => map[m[1]]);
    return matches.length ? matches : null;
}

// -------------------- PDF Extraction --------------------
async function extractTextFromPdfOrPortal(activeTab) {
    const tab = activeTab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab || !tab.url) {
        throw new Error("Active tab URL unavailable");
    }

    // 🧩 Try to extract text from .portalModalInner first (injected into the page)
    try {
        const [{ result: portalText }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const el = document.querySelector(".portalModalInner");
                return el ? el.innerText.trim() : null;
            },
        });

        if (portalText && portalText.length > 100) { // avoid tiny elements
            console.log("✅ Extracted text from portal modal.");
            const signature = await hashValue(`${tab.url}|portal|${portalText}`);
            return {
                text: portalText,
                variant: "portal",
                signature,
            };
        }
    } catch (err) {
        console.warn("⚠️ Could not access portal modal:", err);
    }

    // 🧾 If not found, fallback to PDF extraction
    console.log("🧾 Extracting from PDF...");
    const response = await fetch(tab.url);
    const buffer = await response.arrayBuffer();
    const headerSeed = [
        response.headers.get("etag"),
        response.headers.get("last-modified"),
        response.headers.get("content-length"),
    ]
        .filter(Boolean)
        .join("|");
    const signature = headerSeed
        ? await hashValue(`${tab.url}|pdf|${headerSeed}`)
        : await hashValue(buffer);

    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map((i) => i.str).join(" ");
        text += `\n--- Page ${i} ---\n` + pageText;
    }

    return {
        text,
        variant: "pdf",
        signature,
    };
}

async function extractEventsAI(text) {
    try {
        const res = await fetch("https://school-events-parser.fly.dev/parse-events", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text })
        });
        const data = await res.json();
        return data.events || [];
    } catch (err) {
        console.error("AI extraction failed:", err);
        return [];
    }
}

// -------------------- Google Calendar API --------------------
async function addEventToCalendar(ev) {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: true }, async (token) => {
            if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);

            const tokenString = typeof token === "string" ? token : token.access_token;

            try {
                const recurringDays = detectRecurrence(ev.date);
                const eventBody = {
                    summary: ev.title || "Event",
                    description: ev.description || "",
                    location: ev.location || "",
                };

                // 🧩 Handle date ranges like "2025-10-20 to 2025-10-31"
                const rangeMatch = ev.date?.match(
                    /\b(\d{4}-\d{1,2}-\d{1,2})\s*(?:to|–|-)\s*(\d{4}-\d{1,2}-\d{1,2})\b/i
                );

                if (rangeMatch) {
                    const startDate = rangeMatch[1];
                    const endDate = rangeMatch[2];
                    eventBody.start = { date: startDate, timeZone: "Europe/Berlin" };
                    eventBody.end = { date: endDate, timeZone: "Europe/Berlin" };
                }
                else if (recurringDays) {
                    // 🧩 Weekly recurring event
                    const dayCode = recurringDays[0]; // e.g. "TU"
                    const start = getNextWeekdayDate(dayCode);

                    // parse times
                    const [sh, sm = 0] = (ev.startTime || "09:00").split(":").map(Number);
                    const [eh, em = 0] = (ev.endTime || "10:00").split(":").map(Number);
                    start.setHours(sh, sm, 0, 0);
                    const end = new Date(start);
                    end.setHours(eh, em, 0, 0);

                    // 1 year later end date for recurrence
                    const until = new Date(start);
                    until.setFullYear(start.getFullYear() + 1);
                    const untilStr = until.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

                    eventBody.start = { dateTime: start.toISOString(), timeZone: "Europe/Berlin" };
                    eventBody.end = { dateTime: end.toISOString(), timeZone: "Europe/Berlin" };
                    eventBody.recurrence = [
                        `RRULE:FREQ=WEEKLY;BYDAY=${recurringDays.join(",")};UNTIL=${untilStr}`,
                    ];
                }
                else {
                    // 🧩 Regular single-date event
                    // normalize "2025-10-20 to 2025-10-31" -> "2025-10-20" (if user missed the range match)
                    const normalizedDate = normalizeDateRange(ev.date);
                    const start = new Date(`${normalizedDate}T${ev.startTime || "09:00"}`);
                    const end = ev.endTime
                        ? new Date(`${normalizedDate}T${ev.endTime}`)
                        : new Date(start.getTime() + 60 * 60 * 1000);

                    if (isNaN(start.getTime())) {
                        console.error("❌ Invalid start date:", normalizedDate);
                        reject(new Error("Invalid start date"));
                        return;
                    }

                    eventBody.start = { dateTime: start.toISOString(), timeZone: "Europe/Berlin" };
                    eventBody.end = { dateTime: end.toISOString(), timeZone: "Europe/Berlin" };
                }

                // 🧠 Log the event body for debugging
                console.log("Creating event:", eventBody);

                // 📨 Send to Google Calendar API
                const res = await fetch(
                    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
                    {
                        method: "POST",
                        headers: {
                            Authorization: "Bearer " + tokenString,
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify(eventBody),
                    }
                );

                const data = await res.json();

                if (data.error) {
                    console.error("Google API error:", data.error);
                    reject(data.error);
                    return;
                }

                if (data.htmlLink) {
                    // ✅ Open the event in background tab (don’t steal focus)
                    chrome.tabs.create({ url: data.htmlLink, active: false });
                }

                resolve(data);
            } catch (err) {
                reject(err);
            }
        });
    });
}

function formatDate(dateStr) {
    if (!dateStr) return "";

    const candidates = [];
    const normalized = normalizeDateRange(dateStr);
    if (normalized) {
        candidates.push(normalized);
    }
    if (!candidates.includes(dateStr)) {
        candidates.push(dateStr);
    }

    for (const candidate of candidates) {
        const parsed = new Date(candidate);
        if (!isNaN(parsed)) {
            const day = String(parsed.getDate()).padStart(2, "0");
            const month = String(parsed.getMonth() + 1).padStart(2, "0");
            const year = parsed.getFullYear();
            return `${day}.${month}.${year}`;
        }
    }

    return dateStr;
}

// -------------------- Popup Rendering --------------------
document.addEventListener("DOMContentLoaded", async () => {
    const container = document.getElementById("events");
    const rescanBtn = document.getElementById("reparse");

    let events = [];
    let activeTab;
    let tabUrl = "";

    const setScanningState = () => {
        container.innerHTML = 'Scanning document. Bigger docs take more time.<span class="spinner spinner--primary" aria-hidden="true"></span>';
    };

    const renderEvents = (list) => {
        container.innerHTML = "";

        if (!list.length) {
            container.textContent = "No events detected.";
            rescanBtn.style.display = "none";
            return;
        }

        rescanBtn.style.display = "block";

        list.forEach((ev, idx) => {
            const div = document.createElement("div");
            div.className = "event-item";
            const desc = (ev.description || "").slice(0, 120);
            const hasMoreDesc = (ev.description || "").length > 120;
            const descriptionMarkup = desc ? `<p>${desc}${hasMoreDesc ? "..." : ""}</p><br>` : "";
            const range = ev.endTime ? `${ev.startTime || ""}–${ev.endTime}` : ev.startTime || "";
            const timeMarkup = range ? `⏰ ${range}<br>` : "";

            div.innerHTML = `
              <b>${ev.title || "Untitled Event"}</b><br>
              ${descriptionMarkup}
              🗓️ ${formatDate(ev.date) || ""}<br>
              ${timeMarkup}
              <button class="btn btn-primary add-btn" data-index="${idx}">Add to Calendar</button>
            `;

            div.addEventListener("click", async () => {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

                if (!tab?.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
                    console.warn("Cannot inject into this page type.");
                    return;
                }

                try {
                    if (!chrome.scripting) {
                        console.error("Scripting API not available");
                        return;
                    }

                    await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        files: ["content.js"],
                    });

                    const highlightCandidate = (ev.raw || ev.description || ev.title || "").slice(0, 80);
                    if (highlightCandidate) {
                        chrome.tabs.sendMessage(tab.id, {
                            action: "highlightText",
                            text: highlightCandidate,
                        });
                    }
                } catch (err) {
                    console.error("Could not inject content script:", err);
                }
            });

            container.appendChild(div);
        });

        container.querySelectorAll(".add-btn").forEach((btn) => {
            btn.addEventListener("click", async (e) => {
                e.stopPropagation();
                btn.disabled = true;
                btn.innerHTML = 'Adding... <span class="spinner"></span>';
                const ev = events[btn.dataset.index];
                try {
                    await addEventToCalendar(ev);
                    btn.innerHTML = "✅ Added!";
                } catch (err) {
                    console.error(err);
                    btn.innerHTML = "❌ Error";
                }
            });
        });
    };

    const runExtraction = async ({ forceFresh = false } = {}) => {
        setScanningState();
        rescanBtn.disabled = true;
        rescanBtn.textContent = forceFresh ? "Rescanning..." : "Rescan & Refresh";

        try {
            const { text, variant, signature } = await extractTextFromPdfOrPortal(activeTab);
            const fingerprint = buildFingerprint(tabUrl, variant, signature);

            if (forceFresh) {
                await cacheApi.clear(fingerprint);
            }

            let cached = forceFresh ? null : await cacheApi.get(fingerprint);
            let parsedText = text;
            let parsedEvents = cached?.events;

            if (!parsedEvents) {
                parsedEvents = await extractEventsAI(parsedText);
                await cacheApi.set(fingerprint, { text: parsedText, events: parsedEvents });
            } else if (cached?.text) {
                parsedText = cached.text;
            }

            events = Array.isArray(parsedEvents) ? parsedEvents : [];
            renderEvents(events);
        } catch (err) {
            console.error(err);
            container.textContent = "❌ Unable to read document.";
            rescanBtn.style.display = "none";
        } finally {
            rescanBtn.disabled = false;
            rescanBtn.textContent = "Rescan & Refresh";
        }
    };

    try {
        [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabUrl = activeTab?.url || "";
    } catch (err) {
        console.error("Unable to determine active tab:", err);
        container.textContent = "❌ Unable to determine active tab.";
        rescanBtn.disabled = true;
        return;
    }

    let isLisPortal = false;
    try {
        const { hostname } = new URL(tabUrl);
        isLisPortal = hostname.includes("engage.lis.school");
    } catch {
        isLisPortal = tabUrl.includes("engage.lis.school");
    }

    if (!isLisPortal) {
        container.textContent = "Only available on LIS school portal.";
        rescanBtn.disabled = true;
        return;
    }

    rescanBtn.addEventListener("click", async () => {
        await runExtraction({ forceFresh: true });
    });

    await runExtraction();
});
