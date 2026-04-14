#!/usr/bin/env node
/**
 * Generate static voice preview audio files using Gemini TTS.
 *
 * Intended to be run ONCE per catalog update (not at every boot or deploy).
 * Writes 8 WAV files to voice-server/public/preview/<voiceId>.wav, which are
 * then committed to the repo and shipped in the Docker image. The /preview
 * endpoint serves these directly, avoiding any runtime Gemini TTS API calls
 * (free, instant, and abuse-proof).
 *
 * ## Prerequisites
 *
 * - `GEMINI_API_KEY` environment variable set
 * - Your Google AI Studio account should ideally have billing enabled —
 *   the free tier's "5 RPM, 100 RPD" limit makes generating all 8 voices in
 *   one run flaky. With billing enabled the quota is far above what we need
 *   (and the total cost for all 8 is ~$0.001).
 *
 * ## How to run
 *
 * Locally:
 *   cd voice-server && GEMINI_API_KEY=... node scripts/generate-previews.js
 *
 * On Fly.io (reuses the live GEMINI_API_KEY secret):
 *   fly ssh console -a phondo-voice -C "cd /app && node scripts/generate-previews.js"
 *   fly ssh sftp get /app/public/preview/*.wav ./public/preview/
 *
 * Then commit the generated files and redeploy:
 *   git add voice-server/public/preview/*.wav
 *   git commit -m "chore: regenerate voice preview audio files"
 *   git push
 *
 * ## Rate limit handling
 *
 * The script waits DELAY_MS between requests to stay under free-tier limits.
 * Failures are logged but don't abort the script — run it again to fill in
 * the missing files.
 */

const fs = require("fs");
const path = require("path");

// Gemini voice mapping is duplicated here so the script is standalone. Keep
// in sync with voice-server/lib/voice-mapping.js (GEMINI_VOICE_MAP).
const VOICES = [
  // Australian voices
  { id: "XB0fDUnXU5powFXDhCwa", name: "Charlotte", gemini: "Kore",   text: "Hi there! Thanks for getting in touch. What can I do for you?" },
  { id: "ZQe5CZNOzWyzPSCn5a3c", name: "James",     gemini: "Puck",   text: "G'day! Thanks for calling. How can I help you today?" },
  { id: "IKne3meq5aSn9XLyUdCD", name: "Liam",      gemini: "Charon", text: "Hey! Good to hear from you. How can I help?" },
  // American voices
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah",     gemini: "Aoede",  text: "Hello! Thank you for calling. How may I assist you today?" },
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel",    gemini: "Leda",   text: "Good morning! I'd be happy to help you with your inquiry." },
  { id: "jBpfuIE2acCO8z3wKNLl", name: "Emily",     gemini: "Zephyr", text: "Hey! Great to hear from you! How can I help?" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam",      gemini: "Fenrir", text: "Hi there! Thanks for reaching out. What can I do for you?" },
  { id: "yoZ06aMxZJJ28mfd3POQ", name: "Sam",       gemini: "Orus",   text: "Thank you for your call. I'm here to help you today." },
];

const DELAY_MS = 20_000; // 20 seconds between requests — conservative for free tier
const MODEL = "gemini-2.5-pro-preview-tts";
const OUT_DIR = path.join(__dirname, "..", "public", "preview");

/** Wrap raw PCM in a minimal WAV container. Mirrors pcmToWav in server.js. */
function pcmToWav(pcmBuffer, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const fileSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

async function generateOne(voice, apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: voice.text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice.gemini },
            },
          },
        },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 400)}`);
  }

  const payload = await res.json();
  const audioPart = payload?.candidates?.[0]?.content?.parts?.find(
    (p) => p?.inlineData?.data
  );
  if (!audioPart) {
    throw new Error(`No audio part in Gemini response: ${JSON.stringify(payload).slice(0, 300)}`);
  }

  const pcm = Buffer.from(audioPart.inlineData.data, "base64");
  return pcmToWav(pcm);
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY not set. Export it and re-run.");
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const results = [];
  for (let i = 0; i < VOICES.length; i++) {
    const voice = VOICES[i];
    const outPath = path.join(OUT_DIR, `${voice.id}.wav`);

    // Skip if already generated and non-empty — idempotent re-runs.
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
      console.log(`[${i + 1}/${VOICES.length}] ${voice.name} (${voice.gemini}) — already exists, skipping`);
      results.push({ voice: voice.name, status: "skipped" });
      continue;
    }

    process.stdout.write(`[${i + 1}/${VOICES.length}] ${voice.name} (${voice.gemini}) ... `);
    try {
      const wav = await generateOne(voice, apiKey);
      fs.writeFileSync(outPath, wav);
      console.log(`ok (${wav.length} bytes → ${outPath})`);
      results.push({ voice: voice.name, status: "ok", bytes: wav.length });
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      results.push({ voice: voice.name, status: "failed", error: err.message });
    }

    // Throttle between requests even if the current one failed — the free
    // tier rate limit applies to attempts, not just successes.
    if (i < VOICES.length - 1) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  console.log("");
  console.log("=== Summary ===");
  const ok = results.filter((r) => r.status === "ok").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;
  console.log(`  ok: ${ok}  skipped: ${skipped}  failed: ${failed}`);
  if (failed > 0) {
    console.log("");
    console.log("Failed voices:");
    results.filter((r) => r.status === "failed").forEach((r) => {
      console.log(`  - ${r.voice}: ${r.error}`);
    });
    console.log("");
    console.log("Re-run the script to retry failed voices. Consider enabling");
    console.log("billing on Google AI Studio if free-tier rate limits are");
    console.log("blocking you.");
    process.exit(1);
  }

  console.log("");
  console.log("Done. Next:");
  console.log("  git add voice-server/public/preview/*.wav");
  console.log("  git commit -m 'chore: regenerate voice preview audio files'");
  console.log("  git push");
  console.log("  # ...then fly deploy to ship them to production");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
