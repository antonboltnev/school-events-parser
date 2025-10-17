import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";

import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(bodyParser.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_KEY });

app.post("/parse-events", async (req, res) => {
    const { text } = req.body;

    const cleaned = text
        .replace(/\n\s*\n+/g, "\n") // remove empty lines
        .replace(/--- Page \d+ ---/g, "") // remove PDF markers
        .replace(/\s{2,}/g, " "); // collapse multiple spaces

    try {
        const response = await client.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content: `Extract events from text as JSON:
                    {"events":[{"title":"","date":"","startTime":"","endTime":"","location":"","description":""}]}`

                },
                { role: "user", content: cleaned }
            ]
        });

        const parsed = JSON.parse(response.choices[0].message.content);
        res.json(parsed);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));
