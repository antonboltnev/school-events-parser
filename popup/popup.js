pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("libs/pdf.worker.min.js");

function normalizeDateRange(dateStr) {
    if (!dateStr) return dateStr;

    // 🧹 Remove common prefixes like "Starting", "From", "On"
    dateStr = dateStr
        .replace(/^\s*(starting|from|on|beginning|begins|begin)\s+/i, "")
        .trim();

    // Match ISO-style ranges
    const rangeMatch = dateStr.match(
        /\b(\d{4}-\d{1,2}-\d{1,2})\s*(?:to|–|-)\s*(\d{4}-\d{1,2}-\d{1,2})\b/i
    );
    if (rangeMatch) return rangeMatch[1];

    // Match "20 Oct to 31 Oct"
    const altRange = dateStr.match(/\b(\d{1,2}\s+\w+)\s*(?:to|–|-)\s*(\d{1,2}\s+\w+)/i);
    if (altRange) return altRange[1];

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
async function extractTextFromPdf() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = await fetch(tab.url);
    const buffer = await response.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map(i => i.str).join(" ");
        text += `\n--- Page ${i} ---\n` + pageText;
    }
    return text;
}

async function extractEventsAI(text) {
    try {
        const res = await fetch("http://localhost:3000/parse-events", {
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

// -------------------- Popup Rendering --------------------
document.addEventListener("DOMContentLoaded", async () => {
    const container = document.getElementById("events");
    const addAllBtn = document.getElementById("add-all");

    addAllBtn.style.display = 'none';

    try {
        const text = await extractTextFromPdf();
        const events = await extractEventsAI(text);
        container.textContent = "";


        if (!events.length) {
            container.textContent = "No events detected.";
            addAllBtn.style.display = 'none';
            return;
        }

        // Enable after successful scan
        addAllBtn.style.display = 'block';
        addAllBtn.textContent = "Add All";

        // Render events
        events.forEach((ev, idx) => {
            const div = document.createElement("div");
            div.className = "event-item";
            div.innerHTML = `
  <b>${ev.title}</b><br>
  <p>${ev.description.slice(0, 120)}...</p><br>
  🗓️ ${ev.date || ""}<br>
  ⏰ ${ev.startTime || ""}${ev.endTime ? "–" + ev.endTime : ""}<br>
  <button class="btn btn-primary add-btn" data-index="${idx}">Add to Calendar</button>
`;
            // On click — scroll/highlight original text
            div.addEventListener("click", async () => {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

                // Ignore Chrome-internal or extension pages
                if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
                    console.warn("Cannot inject into this page type.");
                    return;
                }

                try {
                    // Ensure scripting API is available
                    if (!chrome.scripting) {
                        console.error("Scripting API not available");
                        return;
                    }

                    await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        files: ["content.js"]
                    });

                    chrome.tabs.sendMessage(tab.id, {
                        action: "highlightText",
                        text: ev.raw.slice(0, 50)
                    });
                } catch (err) {
                    console.error("Could not inject content script:", err);
                }
            });
            container.appendChild(div);
        });

        // Handle individual "Add to Calendar" buttons
        document.querySelectorAll(".add-btn").forEach((btn) => {
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

        // Handle "Add All" button
        addAllBtn.addEventListener("click", async () => {
            addAllBtn.disabled = true;
            addAllBtn.innerHTML = 'Adding all... <span class="spinner"></span>';
            for (const ev of events) await addEventToCalendar(ev);
            addAllBtn.innerHTML = "✅ All Added!";
        });
    } catch (err) {
        container.textContent = "❌ Unable to read document.";
        console.error(err);
    }
});
