# Voice providers for more languages (researched 18 Oct 2026)

**Why this came up:** on call F5, the demo line promised Arabic and then sent Arabic text to an English-only voice. The fast pipeline uses Deepgram for both directions:
- **Hearing:** Flux, which is English-only.
- **Speaking:** Aura-2, whose voices cover seven languages: English, Spanish, French, German, Italian, Dutch and Japanese.

Deepgram's live models API (checked 18 Oct) has no Arabic voice. Its other recogniser, Nova-3, does understand Arabic.

## Comparison

| Provider | Hears (speech to text) | Speaks (voices) | Arabic | Mandarin, Cantonese, Vietnamese, Greek, Italian, Hindi, Punjabi, Korean, Filipino | Runs in Sydney? | Notes |
|---|---|---|---|---|---|---|
| **Azure AI Speech** | 148 locales, real time | 100+ languages (standard neural voices) | 16 dialects to speak (incl. Lebanese, Egyptian, Gulf), 18 to hear | all yes | **Yes**: `australiaeast` has real-time STT and neural voices; audio is processed in the resource's region | HD voices aren't offered in Sydney; standard voices sound flatter than ElevenLabs |
| ElevenLabs | (Scribe, not checked) | Flash v2.5: 32 languages (~75 ms model time, ~200 ms measured incl. network). v3: 74 languages, but it's the slower "expressive" model | yes (one Arabic) | most | No (US/EU) | Most natural voices |
| Cartesia Sonic-3.5 | — | 42 languages, sub-90 ms | yes, but Cartesia's own notes say Arabic pronunciation is still behind | most | No | Fast |
| Google Chirp 3 HD | (not checked) | ~50 languages, streaming with phone-ready μ-law audio | yes (one generic Arabic) | most | No (nearest: Singapore) | |
| Deepgram (today) | Nova-3: 152 codes incl. Arabic dialects; Flux: English only | Aura-2: 7 languages | hears only | hears most; speaks none | Yes (`api.au.deepgram.com`) | Keep it for English: fastest, already built |

## Recommendation

**Azure AI Speech, in its Sydney region, for any call that isn't in English.** It's the only option that is all of the following:
- one vendor for both hearing and speaking;
- the widest language coverage;
- covers the Arabic dialects Sydney callers actually speak, Lebanese among them;
- processes audio in Sydney, which keeps latency low from Fly `syd` and fits the "stored at rest in Sydney" wording.

English stays on Deepgram Flux and Aura.

**How it would plug in:**
1. Every call starts as today.
2. When the caller asks for another language, the server switches that call's hearing to Azure (that locale) and its voice to an Azure voice for the rest of the call. The language request is the same evidence bar as the prompt's rule; see the follow-up below for a caller who just starts speaking another language.
3. Claude Haiku already writes Arabic, so the model side doesn't change.

**Costs and risks to settle before building:**
- **Turn-taking.** Flux detects end-of-turn for English; Azure's recogniser segments on silence, so it needs tuning on real calls.
- **Voice quality.** Azure's standard voices are flatter. HD voices exist, but not in Sydney: through Voice Live they're synthesised in another region.
- **Price.** Check Azure's per-hour speech-to-text and per-character voice prices against Deepgram before committing.
- **Follow-up.** Detecting a language a caller simply starts speaking, without asking, needs Azure's language identification.

**No-new-vendor alternative:** hand Arabic callers to Gemini Live mid-call; it speaks Arabic. But its hearing on noisy phone lines is why we moved English off it.

## Sources

- Azure Speech regions (updated 8 Oct 2026): https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions
- Azure Speech language support: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts
- ElevenLabs models: https://help.elevenlabs.io/hc/en-us/articles/17883183930129
- ElevenLabs languages: https://elevenlabs.io/docs/help-center/other/what-languages-do-you-support
- ElevenLabs Flash v2.5 measured latency: https://humannessindex.vapi.ai/models/elevenlabs-flash-v2-5
- Cartesia models: https://docs.cartesia.ai/build-with-cartesia/tts-models/latest
- Cartesia release notes (Arabic pronunciation): https://releasebot.io/updates/cartesia
- Google Chirp 3 HD: https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd
- Deepgram Aura-2 languages: https://deepgram.com/learn/aura-2-now-speaks-dutch-french-german-italian-japanese
- Deepgram models API (`GET /v1/models`), queried 18 Oct 2026
