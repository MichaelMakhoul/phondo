# Simulated calls (SCRUM-594)

Scripted callers phone the demo line's **real** conversation logic and every
call is scored against the 14 checkpoints in `docs/call-scorecard.md`. Use it
before asking anyone to make a test call: phone tests are for what needs a real
line (hearing, speed, interruptions, audio).

## What is real and what is simulated

| Real | Simulated |
|---|---|
| server.js's turn handler (`buildLLMOptions … handleUserSpeech`, loaded with the wiring tests' runtime-slice idiom) and every guard in it | Audio: no STT, no TTS, no barge-in, no turn timing |
| The call setup: context, system prompt, live schedule, the fast path's voice addendum, disclosure, greeting | The caller: an LLM (`SIM_CALLER_MODEL`) with a goal |
| Claude Haiku as the fast path calls it (`FAST_LLM_MODEL`, clause chunking) | The caller's STT: a said surname is misheard (`Khoury` → `Curry`/`Corey`), a spelled one arrives as Flux writes it (`K h o u r y.`), as on the 2026-10-17 test calls |
| The tool executor and the Next.js tool-call route with the real calendar handlers | The database: an in-memory store (`fake-supabase.ts`) seeded from a fixture, with the appointment overlap and unique-code constraints |

Network access is limited to Haiku on the Messages API (`gateway.ts`). The
store, notifications, SMS and rate limiters are stubs, so a run can never touch
production.

## Run it

```bash
# 1. Capture the demo line's setup (read-only; keep the file out of git — it holds the business's prompt)
node scripts/sim-calls/capture-fixture.mjs 35cc7464-e4c5-4924-bf39-f5f939824825 .sim-calls/demo-line.json

# 2. Run every scenario three times
SIM_FIXTURE=.sim-calls/demo-line.json SIM_RUNS=3 SIM_LABEL="my change" \
  npx vitest run --config scripts/sim-calls/vitest.config.ts
```

The report lands in `.sim-calls/<timestamp>/report.md` (gitignored), with one
file per call under `runs/`: transcript, tool calls, diary, verdicts and the
server log. In a git worktree, point `SIM_ENV_FILE` at a checkout's
`voice-server/.env` for the API key and the capture's read-only credentials.

| Variable | Default | |
|---|---|---|
| `SIM_FIXTURE` | (required) | the captured business |
| `SIM_SCENARIOS` | all | e.g. `S2,S3` |
| `SIM_RUNS` | 2 | runs per scenario |
| `SIM_CONCURRENCY` | 4 | calls at once |
| `SIM_CALLER_MODEL` | `claude-haiku-5-5` | the caller |
| `SIM_JUDGE_MODEL` | `session` | the judge; `session` = no API call: each run's judge prompt is written to `runs/<run>.judge-prompt.md` for the Claude Code session to grade into `runs/<run>.judge.json`, then `SIM_RESCORE=<dir>` builds the report from those grades. Until then the run's report marks every verdict a grade could change ⏳ and says it isn't a verdict, and a call with no grade fails the re-score |
| `SIM_GATEWAY` | `anthropic` | `openrouter` sends the same requests to OpenRouter's Anthropic-compatible endpoint with `OPENROUTER_API_KEY`, pinned to Anthropic's own servers at the same price (`claude-haiku-5-5` only) |
| `SIM_NOISE` | `phone` | `none` turns the STT layer off |
| `SIM_OUT` | `.sim-calls/<timestamp>` | report directory |
| `SIM_LABEL` | | the report's title |
| `SIM_ENV_FILE` | `voice-server/.env` | where to find `ANTHROPIC_API_KEY` (or `OPENROUTER_API_KEY`) |

**Haiku only.** Sonnet and Opus work (the judge) is done in the Claude Code session, never through the API (the owner's rule, 23 Oct 2026). A run refuses any other model before it starts, and `gateway.ts` refuses any request that could reach one: another model by name, a server tool (the advisor tool consults Opus) or a beta header.

**Cost (2026-10-21 prices).** A call costs about 3¢: the receptionist (Haiku 5.5) ~2.5¢, the caller (Haiku 5.5) ~0.5¢, and the judge is the session. Set a budget before a run (calls × cost): 2,200 simulated calls cost about $200 over 17-21 Oct, mostly a Sonnet caller and an Opus judge.

## Scoring

Deterministic checks read the diary and the tool calls; an LLM judge reads the
transcript. Checkpoints 2 and 6 trust the diary; 7, 11 and 14 take the worse of
the diary and the judge; the rest are the judge's. 1, 12 and 13 need audio and
are never scored here.

A run whose turn handler hit an error (a `[Pipeline]` error, a blocked network
call, a gap in the fake store) is listed under anomalies and fails the vitest
run: it is a harness problem, not a score.

## Clocked scenarios and languages (SCRUM-594 F5)

- `S8` runs at its own `clock` (Sunday 18 Oct 2026, 2:32 PM Sydney — phone test F5). `Date` is global, so a clocked scenario runs on its own: `SIM_SCENARIOS=S8`. A default run leaves it out. `SIM_NOW=<ISO time>` runs every selected scenario at that time instead.
- `S9` (a Spanish speaker) and `S10` (asks for Arabic) score checkpoint 15. For Spanish, the AI must speak Spanish in the Spanish voice; for Arabic, it must say plainly that the line can't speak it. A reply with letters outside Latin script fails either way.
- Phone test F9: each AI line is recorded with the voice the server would say it in (`lib/fast-languages.js` `sentenceVoice`: each sentence in its own language's voice). Checkpoint 15 fails English read by another language's voice and another language read by the English voice. `S13` (Spanish, then back to English) must also end with the line in English.
- Every call record carries `callTime` and the org's `businessHours`. The judge checks dates and weekdays the AI states against them, and a deterministic check fails checkpoint 8 when the AI names the wrong weekday for today or tomorrow.
