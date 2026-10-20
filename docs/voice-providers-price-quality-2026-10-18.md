# Voice providers: price, quality and speed (researched 18 Oct 2026)

Deepgram vs ElevenLabs vs Gemini for the phone line, plus Anthropic's new fast mode. Prices come from each provider's own pricing page on 18 Oct 2026. Quality figures are Elo scores from the Artificial Analysis Speech Arena: blind listener votes, higher is better. They measure how natural a voice sounds, not its speed or accuracy.

## Voices (text to speech)

Assumptions: the AI speaks about 900 characters per minute. Gemini bills about 1,500 audio tokens per minute of speech; that rate is derived from Google's own per-minute figure for Live.

| Voice | Price | ≈ per minute of AI speech | Quality (Elo) | Speed (first audio) | Languages | Arabic | Hosted |
|---|---|---|---|---|---|---|---|
| **Deepgram Aura-2** (demo line today) | $0.030 / 1K chars | 2.7¢ | not ranked | 44–97 ms, measured from Sydney | 7 | no | **Sydney endpoint** |
| Deepgram Flux TTS (Aug 2026) | $0.045 / 1K chars | 4.1¢ | 1053 | "as low as 80 ms" | English only | no | |
| **ElevenLabs v4 Turbo** (Sept 2026) | ~$0.04 / 1K chars (launch coverage; not yet on the API price page) | ~3.6¢ | **1330 (#1)** | ~100 ms plus network | 90+ | **yes** | US/EU |
| ElevenLabs Flash v2.5 | $0.04 / 1K chars | 3.6¢ | 1078 | ~75 ms plus network (~200 ms measured) | 32 | yes | US/EU |
| ElevenLabs v3 Conversational | $0.04 / 1K chars | 3.6¢ | 1210 | ~280 ms | 70+ | yes | US/EU |
| **Gemini 3.8 Flash-Lite TTS** | $6 / 1M audio tokens | **0.9¢**, then 1.8¢ from 1 Jan 2027 | 1248 | not published; Google pitches it for real-time agents | 101 | yes | Google global |
| Gemini 3.8 Flash TTS | $9 / 1M audio tokens | 1.35¢, then 2.7¢ from 1 Jan 2027 | 1275 | not published; Google pitches it for narration | ~130 | yes | Google global |
| Azure standard neural (my earlier pick) | — | — | **1035** | — | 100+ | 16 dialects | Sydney |
| Azure HD 2.5 | — | — | 1135 | — | | | not in Sydney |

Gaps and caveats:
- **ElevenLabs v4 Turbo:** so far it's documented only on ElevenLabs' Text-to-Dialogue WebSocket, not its standard real-time stream-input endpoint. Phone-ready μ-law output isn't documented for it either. Both need confirming before we build on it.
- **Speed from Sydney:** US/EU-hosted voices add roughly 0.15–0.25 s per reply, versus Deepgram's Sydney endpoint.

## Hearing (speech to text), per minute of call

| Model | Price | Languages | Arabic |
|---|---|---|---|
| Deepgram Flux English (demo line today) | $0.0065 (promo; standard $0.0077) | English | no |
| Deepgram Flux Multilingual | $0.0078 | ~10 | no |
| Deepgram Nova-3 | $0.0048 single-language / $0.0058 multilingual (promo; standard $0.0077 / $0.0092) | 40+ (152 regional codes) | **yes** |
| ElevenLabs Scribe Realtime | $0.39/hour = $0.0065 | multilingual | (not checked) |

## All-in-one (Gemini Live: every line except the demo line)

`gemini-3.8-live` charges $3 per 1M audio-in tokens (~$0.005/min) and $12 per 1M audio-out tokens (~$0.018/min). Prompt and history text tokens are billed on top.

## What a 5-minute call costs

Assumes the caller is on the line for 5 minutes and the AI speaks for about 2 of them.

| Setup | ≈ cost |
|---|---|
| Today: Flux + Aura-2 + Claude Haiku 5.5 | ~11¢ |
| Same, with an ElevenLabs voice | ~13¢ |
| Same, with Gemini 3.8 Flash-Lite TTS | ~7¢ (~9¢ from 2027) |
| Gemini Live, audio only | ~6¢ plus text tokens |

**Price isn't the decider. Quality, speed from Sydney, and languages are.**

## Recommendation

Run an A/B on the demo line: **ElevenLabs v4 Turbo vs Deepgram Aura-2**. Measure time-to-first-audio from Sydney and listen to both.
- **Why v4 Turbo:** it's the best-rated voice by a wide margin (1330 vs Deepgram's 1053), and it covers 90+ languages including Arabic. That would replace the Azure plan: Azure's standard voices rank near the bottom (1035).
- **Fallback:** if v4 Turbo isn't usable on a real-time streaming endpoint yet, try Gemini 3.8 Flash-Lite TTS (1248, 101 languages, cheapest).
- **Hearing:** non-English calls still need a multilingual recogniser. Deepgram Nova-3 hears Arabic, so we'd add no new vendor for hearing.

## Anthropic "fast mode"

**What it is:** a research preview on the Claude API, for **Claude Opus 5.5, Opus 5 and Opus 4.8 only**.
- **Speed:** output tokens stream up to 2.5× faster.
- **Price:** double the standard rate (Opus 5.5: $8 / $40 per MTok).
- **How to turn it on:** `speed: "fast"` plus the beta flag `fast-mode-2026-02-01`.

**Why it doesn't help us:**
- The demo line runs **Claude Haiku 5.5**, which has no fast mode.
- Our replies are short, so what callers feel is time to first word, not output speed.
- Opus in fast mode would cost about 80× Haiku and still start slower.

**What we can do on our side:**
1. **Already done:** Haiku's thinking is switched off for speed (`lib/model-params.js` `claudeLatencyParams`).
2. **Not done yet — add prompt caching.** The fast path resends the same long system prompt and tool list on every turn with no `cache_control`. Caching it, with a breakpoint on the system prompt and the growing history, cuts the time the model takes to read the prompt before answering, and cuts input cost to 0.1× on cached tokens. Haiku 5.5 caches prompts of 512 tokens or more. Watch out: a mid-call schedule refresh rewrites the system prompt, which resets the cache.

## Sources

- Deepgram pricing: https://deepgram.com/pricing
- Deepgram Flux TTS: https://deepgram.com/product/text-to-speech/flux
- ElevenLabs API pricing: https://elevenlabs.io/pricing/api
- ElevenLabs models: https://elevenlabs.io/docs/overview/models
- Eleven v4 Turbo launch coverage: https://www.digitalapplied.com/blog/eleven-v4-turbo-voice-agents-latency-pricing
- Gemini API pricing: https://ai.google.dev/gemini-api/docs/pricing
- Gemini 3.8 Flash-Lite TTS: https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-lite-tts
- Gemini 3.8 Flash TTS: https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts
- Artificial Analysis Speech Arena: https://artificialanalysis.ai/text-to-speech/leaderboard
- Vapi Humanness Index, Flash v2.5: https://humannessindex.vapi.ai/models/elevenlabs-flash-v2-5
- Anthropic fast mode / Haiku 5.5: the Claude API reference, cached 6 Oct 2026
