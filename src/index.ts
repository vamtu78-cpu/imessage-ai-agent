import http from "node:http";
import https from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { attachment } from "@spectrum-ts/core";

const TARGET_PHONE = process.env.TARGET_PHONE!; // e.g. "+8613800138000"
const TARGET_SPACE_ID = `any;-;${TARGET_PHONE}`;
const PORT = Number(process.env.PORT ?? 4001);

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY; // optional — omit to disable [voice]
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

const RELAY_BASE_URL = process.env.RELAY_BASE_URL!; // any OpenAI-compatible /chat/completions host
const RELAY_API_KEY = process.env.RELAY_API_KEY!;
const RELAY_MODEL = process.env.RELAY_MODEL!;

// Stickers are optional. Put label -> image URL pairs in stickers.json
// (gitignored — see stickers.example.json for the format).
const STICKERS: Record<string, string> = existsSync("./stickers.json")
  ? JSON.parse(readFileSync("./stickers.json", "utf8"))
  : {};

// Persona is loaded from persona.txt (gitignored — see persona.example.txt).
// Keep your character/relationship details out of source control.
const PERSONA = existsSync("./persona.txt")
  ? readFileSync("./persona.txt", "utf8").trim()
  : "You are a friendly, casual texting companion. Keep replies short and natural.";

const MARKER_DOCS = `

You can send more than plain text by writing one of these on its own line:
- "[voice]your text" — speak this line instead of typing it (only if voice is configured; use sparingly)
${Object.keys(STICKERS).length > 0 ? `- "[img:label]" — send a sticker, label must be exactly one of: ${Object.keys(STICKERS).join(", ")}` : ""}
- "[delay:N]your text" — don't send this now, send it N minutes from now (e.g. to follow up later)
Don't overuse these — most replies should just be plain lines. If you have several thoughts, put each on its own line, like someone texting in a burst — don't write one long paragraph.`;

const SYSTEM_PROMPT = PERSONA + MARKER_DOCS;

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});

const im = imessage(app);

type ChatMsg = { role: "system" | "user" | "assistant"; content: string };
const history: ChatMsg[] = [];
const MAX_TURNS = 20;

function callRelay(messages: ChatMsg[]): Promise<string> {
  const body = JSON.stringify({ model: RELAY_MODEL, messages, max_tokens: 500 });
  const url = new URL(RELAY_BASE_URL + "/chat/completions");
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RELAY_API_KEY}` },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            const text = parsed.choices?.[0]?.message?.content;
            if (!text) return reject(new Error("no content: " + data));
            resolve(text);
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ttsElevenLabs(text: string): Promise<Buffer> {
  const body = JSON.stringify({ text, model_id: "eleven_multilingual_v2" });
  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`);
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json", "xi-api-key": ELEVENLABS_API_KEY!, Accept: "audio/mpeg" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode !== 200) return reject(new Error("elevenlabs error: " + buf.toString()));
          resolve(buf);
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

type SpectrumSpace = Awaited<ReturnType<typeof im.space.get>>;

async function sendVoiceLine(space: SpectrumSpace, text: string) {
  // NOTE: spectrum-ts's voice() content type currently produces an
  // unplayable "00:00" bubble via Photon's iMessage relay — attachment()
  // with the same audio plays fine, just as a plain file bubble instead of
  // the native waveform pill. See README "known limitations".
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) return;
  const audio = await ttsElevenLabs(text);
  await space.send(attachment(audio, { mimeType: "audio/mpeg", name: "voice.mp3" }));
}

function fetchBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

async function sendStickerLine(space: SpectrumSpace, label: string) {
  const url = STICKERS[label];
  if (!url) return;
  const buf = await fetchBuffer(url);
  const ext = url.endsWith(".gif") ? "gif" : "png";
  await space.send(attachment(buf, { mimeType: `image/${ext}`, name: `${label}.${ext}` }));
}

async function sendLine(space: SpectrumSpace, line: string) {
  if (line.startsWith("[voice]")) {
    await sendVoiceLine(space, line.slice("[voice]".length).trim());
  } else if (line.startsWith("[img:") && line.endsWith("]")) {
    await sendStickerLine(space, line.slice("[img:".length, -1).trim());
  } else {
    await space.send(line);
    history.push({ role: "assistant", content: line });
  }
}

const DELAY_PATTERN = /^\[delay:(\d+)\](.*)$/;

async function sendSplit(space: SpectrumSpace, text: string) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const delayMatch = line.match(DELAY_PATTERN);
    if (delayMatch) {
      const minutes = Number(delayMatch[1]);
      const content = delayMatch[2].trim();
      setTimeout(() => {
        sendLine(space, content).catch((err) => console.error("delayed send error:", err));
      }, minutes * 60_000);
      console.log(`scheduled delayed send in ${minutes}min:`, content);
      continue;
    }
    await sendLine(space, line);
    await sleep(700);
  }
}

async function sendToTarget(text: string) {
  const space = await im.space.get(TARGET_SPACE_ID);
  await sendSplit(space, text);
}

http
  .createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/send") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { text } = JSON.parse(body);
        await sendToTarget(text);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
  })
  .listen(PORT, "127.0.0.1");

console.log(`Listening for inbound iMessage; local push endpoint on 127.0.0.1:${PORT}/send`);

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") continue;
  const userText = message.content.text;
  console.log("inbound:", userText);
  history.push({ role: "user", content: userText });
  if (history.length > MAX_TURNS) history.splice(0, history.length - MAX_TURNS);
  try {
    const reply = await callRelay([{ role: "system", content: SYSTEM_PROMPT }, ...history]);
    await sendSplit(space, reply);
  } catch (err) {
    console.error("relay error:", err);
    await space.send("(hiccup on my end, try again in a bit)");
  }
}
