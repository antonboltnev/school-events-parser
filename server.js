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

    try {
        const response = await client.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0.1,
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content: `You extract event details from newsletters.
Output JSON like:
{
  "events": [
    {
      "title": "string",
      "date": "YYYY-MM-DD" or "Every <weekday>",
      "startTime": "HH:mm",
      "endTime": "HH:mm",
      "location": "string",
      "description": "string"
    }
  ]
}`

                },
                { role: "user", content: text }
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
