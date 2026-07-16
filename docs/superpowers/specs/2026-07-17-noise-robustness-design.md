# Noise-robust call handling — design (SCRUM-554 / SCRUM-555)

**Date:** 2026-07-17 · **Status:** approved by owner (option "A now, then B")

## Problem (evidence from real calls)

1. **Train calls (6 calls, 2026-07-15).** Gemini Live transcribed train background audio as foreign-language caller turns on an English call — call `8f2df052`: "Ich stehe. Und ich fahre die Jacke zum Ziel." (German), "チェルシー フットボール クラブ" (Japanese), phantom Spanish. Every noise burst also *interrupted* the AI mid-sentence. All 6 calls failed.
2. **Speakerphone demo (2026-07-16, calls `12dc1058` Phondo / `6e1feb9c` Smile Hub).** The owner's Arabic was mis-transcribed ("¿De qué de qué árabe sí?", "आप सब ठीक है, अरबी?"), so it never met SCRUM-547's "clearly intelligible sentence" evidence bar. The AI knew Arabic was wanted but **transferred to a human instead of switching**. The Phondo call also answered a 2-word Spanish fragment in Spanish (rule violation under noise), then recovered.
3. **Config root cause for (1):** `services/gemini-live.js` sets `startOfSpeechSensitivity: "START_SENSITIVITY_HIGH"` (SCRUM-375, for quiet callers) + `activityHandling: "START_OF_ACTIVITY_INTERRUPTS"` — faint background audio opens and interrupts turns.
4. **Bonus gap found:** the legacy `buildSystemPrompt` path still carried the pre-SCRUM-547 "auto-detect from the first turn … throughout the call" wording in two places (SCRUM-547's negative test matched a different phrasing).

## Package A — shipped in this branch (SCRUM-554)

1. **VAD retune** (`services/gemini-live.js`): onset `HIGH → LOW` + `prefixPaddingMs: 250` (≈250ms of sustained speech before a turn commits — noise bursts no longer open/interrupt turns). `endOfSpeechSensitivity` stays `LOW` and `silenceDurationMs` stays 1000 so quiet/slow callers aren't cut off mid-turn (preserves the SCRUM-375 intent).
2. **Noisy-line protocol** (both prompt paths): respond only to the primary caller; garbled turn → one brief re-ask; second unclear turn → **guided mode** (menu of what the receptionist can do); interpret half-heard speech against expected caller intents (booking / hours / prices / urgent) and **confirm before acting**; never force-fit, never book/cancel/change from an unconfirmed guess; final fallback = callback capture.
3. **Language-request confirm fast path** (prompt-builder LANGUAGE rule + server.js LANGUAGE LOCK): a garbled turn containing an audible language *name* ("Arabic", "عربي", …) is a language request, not noise — confirm bilingually ("Would you like to continue in Arabic? تحب تكمل بالعربي؟"); yes in either language = full evidence, switch immediately. No more transfer-on-language-request.
4. **Legacy path port**: evidence-bar language rule + noisy-line protocol replace the stale auto-detect wording.
5. **Tests**: new SCRUM-554 describe block pins the VAD values (and forbids `START_SENSITIVITY_HIGH`), the protocol in both paths, the bilingual confirm in both files, and the absence of ALL known sticky-auto-detect phrasings.

**Trade-off accepted:** LOW onset means a very quiet caller's turn *start* may need slightly louder/longer speech to register. Mitigated now by prefix padding + unchanged end-of-speech behavior; properly solved by package B.

## Package B — next (SCRUM-555)

Inbound audio front-end in the voice server, before Gemini: software AGC (normalize quiet callers up — closes the SCRUM-375 concern for good) + RNNoise-style suppression for stationary noise on the 8 kHz Twilio leg. Explicit non-goal: suppression cannot remove *competing speech*; the prompt protocol covers that. Validate per-call CPU on Fly shared-cpu; A/B against the 2026-07-15 train-call recordings.

## Package C — held

Own turn-taking: disable Gemini auto-VAD, run Silero VAD with a noise-floor dominance gate, send manual activity events. Only if A+B prove insufficient on real calls.

## Verification

- `npm test` + `npm run typecheck` (both CI gates) green.
- Full review pipeline (/review-and-fix) on the diff.
- Real-world: repeat the train test + speakerphone Arabic demo after the owner deploys.
