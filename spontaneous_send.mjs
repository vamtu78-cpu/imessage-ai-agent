// Optional: have the bot text you unprompted, on a schedule.
// Run this from cron; it asks the relay for one fresh line and pushes it
// through the running service's own /send endpoint (don't open a second
// Spectrum connection — see README).
import https from "node:https";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";

const RELAY_BASE_URL = process.env.RELAY_BASE_URL;
const RELAY_API_KEY = process.env.RELAY_API_KEY;
const RELAY_MODEL = process.env.RELAY_MODEL;
const PORT = Number(process.env.PORT ?? 4001);

const PERSONA = existsSync("./persona.txt")
  ? readFileSync("./persona.txt", "utf8").trim()
  : "You are a friendly, casual texting companion.";

const SYSTEM_PROMPT = `${PERSONA}

You're texting them out of the blue right now — not replying to anything,
you just thought of them. One or two short lines, no explanation, no
repeating the same opener every time. Output only the message itself.`;

function callRelay() {
  const body = JSON.stringify({
    model: RELAY_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "(send something now)" },
    ],
    max_tokens: 200,
    temperature: 1.1,
  });
  const url = new URL(RELAY_BASE_URL + "/chat/completions");
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${RELAY_API_KEY}` } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.choices[0].message.content.trim());
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function sendLocal(text) {
  const body = JSON.stringify({ text });
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: PORT, path: "/send", method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const text = await callRelay();
console.log("generated:", text);
console.log("send result:", await sendLocal(text));
