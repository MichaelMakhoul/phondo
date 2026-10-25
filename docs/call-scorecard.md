# Demo-line call scorecard

One fixed list of checkpoints. Every test call gets scored against it, so we can see what improved, what regressed and what keeps failing.

- ✅ = passed
- ⚠️ = partly passed, or passed only because a safety check forced it
- ❌ = failed
- — = not exercised in that call

| # | Checkpoint | G1 Gemini 16 Oct 12:51 | G2 Gemini 16 Oct 13:39 | G3 Gemini 16 Oct 14:17 (filter off) | F1 Fast 17 Oct 07:03 | F2 Fast 17 Oct 08:00 | F3 Fast 17 Oct 21:38 (same build as F2) | F4 Fast 17 Oct 21:42 (same build as F2) | F5 Fast 18 Oct 14:32 (new build 87e2433) | F6 Fast 19 Oct 10:02 (build 8347f34) | F7 Fast 20 Oct 11:14 (build 01269dc) | F8 Fast 20 Oct 15:25 (build be95e2e) | F9 Fast 21 Oct 01:53 (build 194e99e) | F10 Fast 26 Oct 03:36 (build 200ac20f, Claude via OpenRouter) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Hears the caller correctly | ❌ "Nine is good" heard as "Nein, gut"; "yes" heard as "no" | ❌ Spanish, Hindi, Italian | ❌ German, Spanish | ✅ one slip ("Sorry?" heard as "Deville") | ✅ one slip ("book a line") | ⚠️ a few slips ("Audrey"), recovered | ⚠️ "That's my day at night", "Michael but close" | ⚠️ said surname heard as "Makoot", "McCool"; spelled letters right | ⚠️ said surname heard as "McCool"; spelled letters right | ⚠️ "It is a replacement" heard as "It is our first name"; "Makhoul" as "Michael"; recovered by asking again | ⚠️ said surname heard as "McCook"; "1 PM would be great" cut off as "One PM will be where"; spelled letters right; recovered by asking | ⚠️ "slow drip" heard as "slow drink"; your "¿Hablas español?" heard as "Oh, plus español" (it switched anyway); recovered | ⚠️ "How about yesterday?" heard as "Oh, much yesterday"; "Let's see today then" as "Let's see who's they then"; recovered by asking both times |
| 2 | Gets the surname right | ❌ McCool | ❌ Makhlouf | ✅ Makhoul, after a struggle | ✅ Makhoul | ❌ **McCool** | ⚠️ booked **McCool**, fixed only when you asked | ✅ you spelled it for the lookup | ✅ Makhoul | ✅ Makhoul | ✅ Makhoul | ✅ Makhoul | ✅ Jordan | ✅ Dunn (but the call log says **Gunn**: see below) |
| 3 | Confirms the spelling before booking | ⚠️ only because the check forced it | ❌ | ⚠️ several re-spells | ⚠️ asked to spell, but no "is that right?" | ❌ **never asked** | ❌ **never asked** | — | ✅ spelled back + "is that right?" (one muddled extra round) | ✅ spelled back + "is that right?"; spelled again when you asked | ✅ spelled back; checked once more before booking | ✅ spelled back + "is that right?"; spelled again when you asked | ✅ spelled back J-O-R-D-A-N + "is that right?" | ✅ spelled back D-U-N-N + "is that right?" |
| 4 | Books only after the caller agrees to a time | ✅ the check held it | ❌ booked before you agreed | ⚠️ third try unchecked | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ ("any time is fine" → 9 AM) | ✅ ("Did you want to book 1 PM tomorrow?" → yes) | ✅ ("Two PM is good" → spelled back → booked) | ✅ ("Shall I book you in for 12:30 this afternoon?" → yes) |
| 5 | Books the time the caller asked for | — | ❌ 9 AM, not your 10 AM | ✅ 10 AM | ✅ 9:30 | ✅ Tue 9 AM | ✅ Mon 10:30 | — | ✅ Mon 10 AM | ✅ Mon 4:30 PM | ✅ Wed 9 AM | ✅ Wed 1 PM | ✅ Wed 2 PM | ✅ today (Mon) 12:30 PM |
| 6 | Moves a booking when asked | — | — | — | ❌ refused (name check) | ❌ **made a second booking instead of moving** | — | — | — | — | — | — | — | — |
| 7 | Cancels with at most 2 confirmations | — | — | — | ❌ refused ("no booking") | ❌ **5 confirmations, and asked for the phone** | — | ❌ **3 confirmations and asked for the phone** | — | — | — | — | — | — |
| 8 | Never says anything false about bookings | ⚠️ "Actually, let me clarify…" | ❌ "You're all set" over your "No" | ⚠️ "Perfect! You're all set" mid-spelling | ❌ "no appointment on the system" | ❌ **"I didn't book anything on this call"** | ✅ | ❌ **"a booking was started but never completed"** | ❌ **"Today's Monday the 18th"** (Sunday); "today's out, booked 9 to 5" (closed Sundays); **"Yes, I can speak Arabic"** | ✅ right weekday and date; offered today first | ✅ | ✅ | ✅ right weekday and date ("today, Wednesday the 21st") | ✅ "yesterday's gone, and we're closed on weekends anyway" (yesterday was Sunday); "tomorrow, Tuesday" |
| 9 | Remembers what it did earlier in the call | — | — | — | ✅ | ❌ **forgot its own Tuesday booking** | ❌ **asked your name again** ("I just told you") | ✅ | ✅ | ✅ | ⚠️ asked your first name after you'd given it (it heard "my last name is Michael") | ✅ | ✅ | ✅ |
| 10 | Stops when interrupted, answers "Sorry?" | — | — | — | ❌ "Sorry?" waited 10 s | ✅ stopped 8 times when you spoke | ✅ | ✅ took your "No, no" | ✅ answered your "Sorry?" | ✅ stopped for your "A new one"; answered "Hello?" | ✅ repeated when you said "Say it again"; stopped for you 6 times | ❌ **"Sorry?" waited 5 s** (the name step), then your second ask cut its reply off; stopped for you when you spoke | ✅ repeated the photo request when you asked (1.1 s); answered your "Sorry?"; stopped for you 6 times | ✅ stopped for you twice ("If any available today", "Oh, that's all") |
| 11 | Short replies, no repeating itself | ✅ | ✅ | ✅ | ❌ 12–15 s replies, repeated offers | ⚠️ short, but asked the time 4× | ⚠️ asked for a time twice | ⚠️ re-confirmations | ⚠️ asked you to spell again after you had; "anything else?" 3× | ⚠️ said the same times twice in one reply; **two goodbyes** before you were done; the demo line | ⚠️ asked the hot-water type 3 times (it misheard "I'm not sure"); the first-name mix-up | ⚠️ two questions at once ("Is this a booked job rather than an urgent one? Can I grab your first and last name?"); asked your name 4 times (the repeats) | ⚠️ a muddled first offer ("first openings are 9:30 AM, but I can offer 2 PM or 3 PM today too. Want 2 PM, or would you rather have 9 AM tomorrow?"); the times said 3 times; "anything else?" 3× at the end | ⚠️ named 9 AM four times as it re-offered today; introduced itself twice; one double question ("…or replacing an existing one? And can I grab your first and last name?"), which you cut off |
| 12 | Speaks spelled names clearly | — | — | — | ❌ dropped "U L" | — | ⚠️ "M-C-C-O-O-L" recorded as "m c c o o" | — | — (no recording transcript yet) | ⚠️ the second read-back recorded as "M-A-K-H-R-U-L" | ✅ M-A-K-H-O-U-L read back clearly | ✅ M-A-K-H-O-U-L read back clearly; you asked to hear it once more | ✅ J-O-R-D-A-N read back clearly | ✅ D-U-N-N read back clearly |
| 13 | Speed (median gap ≤ 1.5 s) | ✅ ~1.5 s | ✅ | ✅ | ✅ 1.06 s* | ✅ 0.98 s* (p90 4.0 s) | ✅ 0.91 s* (p90 3.0 s) | ✅ 1.03 s* (p90 5.1 s) | ✅ 0.95 s* (p90 2.3 s) | ⚠️ 1.04 s* (p90 4.0 s), but **14 s of silence** after "Yeah, that one please" (you said "Hello?") and 6 s after "Four thirty is good" | ✅ 0.91 s* (p90 2.2 s), no long waits | ⚠️ 0.93 s* (p90 4.9 s), but **6.6 s of silence** after your surname and 5 s after "Sorry?" | ⚠️ 1.2 s* (p90 2.7 s) in English, but **4–4.5 s after every answer once it switched language** (the rest of the call ran on the slower voice path) | ✅ 1.12 s* (p90 2.3 s); the two slowest (2.2–2.3 s) while it waited for your name |
| 14 | Ends properly (goodbye → hangs up; never over an objection) | ❌ cut off by the 3-min limit | ❌ hung up over "No, I said 10AM" | ❌ asked to spell, then hung up | ✅ | ⚠️ you hung up mid-confusion | ✅ | ⚠️ **didn't hang up after "That's all"; logged a callback you didn't want** | ✅ waited for your goodbye | ⚠️ hung up after your "That's all", but tried twice before that (the check held it), with a goodbye each time | ✅ "anything else?" before the goodbye; hung up after your "that's all, cheers" | ✅ "anything else?" before the goodbye; hung up after your "That's all, thank you" | ✅ "anything else?" before the goodbye; hung up after your "That's all. Thank you" (one earlier hang-up attempt was held by the check; you heard nothing) | ✅ "anything else?" before the goodbye; hung up after your "Oh, that's all. Thanks" (one earlier hang-up attempt, after "Alright, thank you", was held by the check; you heard nothing) |
| 15 | Speaks the caller's language when it can; says so plainly when it can't | — | — | — | — | — | — | — | ❌ **"Yes, I can speak Arabic"**, then Arabic text to an English voice | — | — | — | ❌ switched to Spanish when you asked, but **never switched back**: your English got English replies in the Spanish voice ("This line speaks English" came out as "Two sign speaks English") | — |
| 16 | Clear audio: loud enough, no words cut off, no background noise | — | — | — | — | — | — | — | — | ❌ **4 words cut off mid-sound** ("…for yo—", "…Mich—"); a second of hold noise ("wind") before every reply | ❌ **too quiet to follow** ("Say it again"): 3–6 dB under the Gemini calls; no wind; 2 words cut off by the voice | ⚠️ **loud enough now**: −14 dBFS, level with Gemini; no wind; 2 word endings clipped by the voice | ❌ **the Spanish voice sounded off**: our +6 dB boost over-drove it (its distortion 10 dB worse than the English voice's); the English part −14 dBFS, clear | not measured yet (no cut-off words in the recording's transcript) |
| | **Score (✅ out of checkpoints exercised)** | **3 / 8** | **2 / 10** | **4 / 10** | **6 / 13** | **6 / 13** | **7 / 12** | **4 / 9** | **8 / 12** | **7 / 13** | **9 / 13** | **8 / 13** | **9 / 14** | **10 / 12** |

\* Measured from when it detected you'd finished. Add about 0.3–0.9 s for the real gap from your last word.

F3 and F4 ran the same build as F2: none of the fixes below were deployed yet. They repeat F2's failures, which the simulator also reproduced before the fixes (no spelling check, a forgotten name, cancel friction). F4 adds one the simulator had missed: after a pure cancel, the model ended the call as "booking complete", and the old safety check took that literally, told you there was no appointment, and logged a callback you'd said you didn't want.

F5 is the first call on the new build. The booking flow worked: it spelled your surname back, waited for your yes, and booked only after you agreed the time. Two new failures, both outside the booking checks:
- **Wrong weekday (8).** The model never asked the system for the date. The prompt's schedule only says "Current date: 2026-10-18", and it lists the closed Sunday as "Fully booked", with Monday the first day that has times. The model called today Monday and blamed "booked 9 to 5" for a day you're simply closed.
- **Arabic (8).** The shared prompt tells the AI it's multilingual (true for Gemini). This line hears with an English-only recogniser and speaks with Deepgram voices that have no Arabic. So it promised Arabic and sent Arabic text to an English voice, which came out as gibberish.

**Fixed after F5 (commits b3f728a → cf13f45), checked in the simulator before your next call:**
- **Weekday:**
  - The schedule names today's weekday. Today and a closed tomorrow each get their own line, e.g. "Today (Sun, Oct 18): CLOSED".
  - Before the business opens, today is labelled "this morning: the earliest times of all" and its times are offered first. In the small hours (before 5 AM) the AI is also told that a caller's "tomorrow morning" usually means today.
  - The prompt's example replies no longer say "the earliest … is tomorrow".
- **Languages:**
  - The demo line speaks English, Spanish, French, German, Italian, Dutch and Japanese: what Deepgram can both hear and say.
  - It switches when the caller asks, or once on its own when the caller clearly speaks one of them.
  - The spelling read-back, the cancel check, the goodbye check and the "I've booked you" check all understand the call's language. In another language a cancel goes ahead only on a clear yes that follows its read-back. A refusal drops it. An unclear answer, a hedge or a question gets asked again.
  - For Arabic or any other language, it says so in English and offers a call-back. It never sends a voice text it can't say.
- **Voice:** Charlotte now uses Deepgram's Australian voice.

**Simulated callers, 3 runs each (33 calls, head cf13f45, 6 AM Monday before opening):**

| Check | Result |
|---|---|
| Language handled (Spanish, French book-then-cancel, Japanese; Arabic declined) | 12/12 |
| Spelling confirmed before booking | 27/27 |
| Cancels within 2 confirmations | 9/9 |
| Ends properly | 33/33 |
| Never false about bookings | 31/33 |

- 10 of 12 checkpoints pass on every run. Short replies misses because of the demo prompt; the other miss is the "never false" line above.
- The 2 misses are early-morning slips ("the earliest is tomorrow"). The bookings themselves were right.
- In the before-opening fixes:
  - offering Tuesday as "the earliest morning" at 3 AM went from 5 calls in 12 to 0;
  - "today's fully booked" at 5:56 AM went from 6 calls in 12 to 2;
  - 7:30 AM: 12/12.
- **Cancel safety in other languages:** a reviewer probed 282 ways of taking a cancel back. None cancels. A caller who keeps saying a clear yes is never stuck.

F6 (Monday 10:02 AM, build 8347f34) booked correctly: the right weekday, today offered first, your surname spelled back, and 4:30 PM booked. Checkpoint 16 is new: the recording showed problems you can hear but no other checkpoint covers. What went wrong, from the recording and the logs:
- **Words cut off mid-sound (16).** Four times a word stops dead: "Let me book that for yo—", "Have a good day, Mich—", "is that righ—" and "Sure—". The next sentence then starts, so it sounds like the AI stopping and starting again. This is Deepgram's Australian voice (Theia) itself. Replaying the call's exact messages gave the same cuts, and so did Deepgram's other API and its full-quality audio. Over the same sentences, the endings that came back cut off were Theia 13 of 90, Thalia (American) 3 of 90 and Hyperion (Australian, male) 1 of 90.
- **The "wind" (16).** The fast line still played the old pipeline's "thinking" sound: soft brown noise for about a second before every reply.
- **14 s of silence (13).** You answered "Yeah, that one please" to "is that the one?". The "one" counted as the first digit of a phone number, so the line waited 12 s for the rest, until you said "Hello?".
- **6 s after "Four thirty is good" (13).** A time said in words didn't count as a time, so the line waited out its 4 s limit.
- **Two goodbyes (11, 14).** The prompt told the AI to say goodbye as soon as you confirmed the booking, but this line won't hang up until you say you're done. So you heard "Have a good day, Michael" and then "Is there anything else I can help you with today?". Your "Sounds perfect" arrived separately from your "Yeah". It was answered on its own, which led to a second goodbye.
- **The same times twice (11):** "Today's openings start at 11 AM, and tomorrow has times from 9:30 AM. Would today at 11 AM or tomorrow at 9:30 AM suit you better?"
- **The demo line**, which you asked to remove.

**Fixed after F6 (commits 8089f87 → 72c2406), checked in the simulator before your next call:**
- No "thinking" sound on the fast line.
- A plain "yes" to "is that the one?" goes straight through. A different number given in pieces is still put together first. "One" and "oh" count as digits only inside a run of real digits. "Four thirty", "Four PM", "ten past four", "after four" and "noon" count as times.
- On the phone line, after you confirm a booking, the AI asks "anything else?" before any goodbye. If it does try to hang up early, it is told not to say goodbye again. Short approvals like "Sounds perfect", "That's great" and "Lovely" are no longer answered on their own while the AI is busy, the same as "Perfect" already was. Closers like "Cheers" and "All good" still count as your goodbye.
- New rule: say each time once, in the question.
- The demo line is gone. Phondo comes up only if the caller asks. The photo ask says to send it to this number. (The demo number itself can't receive texts or photos: SMS and MMS are off for it in Twilio.)
- **Not fixed: the cut-off words.** Fixing them means changing the voice, which is your call.

**Simulated callers, 3 runs each, Monday 11 AM (the same clock as the F5 run it is compared with):**

| Check | Before (F5 build) | After (2db8c6c) |
|---|---|---|
| Says the demo line | 19 of 33 calls | 0 of 36 |
| Says goodbye before you're done (the hang-up is held) | 5 of 33 | 2 of 36 |
| Ends properly | 33/33 | 35/36 |
| Never false about bookings | 29/33 | 34/36 |
| Short replies, no repeating itself | 18/33 | 24/36 |
| Spelling confirmed before booking | 27/27 | 30/30 |
| Cancels within 2 confirmations | 8/9 | 9/9 |
| Languages | 11/12 | 12/12 |
| Checkpoints passing on every run | 8 / 12 | 9 / 12 |

- The one call that didn't end properly: the caller said "all correct, thanks, bye!" and was asked "anything else?". Rewording the rule fixed that case but brought back early goodbyes after a plain "yes, thanks", so this wording is the better balance.
- The 2 "never false" misses are the known "today's pretty full" slip, said with today free.
- The simulator has no audio and no turn timing, so the thinking sound and the number/time waits are covered by tests instead.

F7 (Tuesday 11:14 AM, build 01269dc) went well. It booked Wednesday 9 AM correctly, asked "anything else?" before saying goodbye, hung up after yours, played no wind, and answered in about 0.9 s. The one real problem was volume: **the voice was too quiet to follow**, and you had to ask "Say it again".
- On the recordings, Deepgram's Australian voice reached you at −17 to −20 dBFS (decibels below the loudest a phone line can carry). Gemini was at −14 on the same line. Every Deepgram voice measures 4–8 dB under Gemini, so changing the voice alone would not fix it.
- The line also misheard you a few times ("It is a replacement" was heard as "It is our first name"). It recovered each time by asking again.

**Fixed after F7 (commits 72a7c41 → eb6316c):**
- Every Deepgram audio frame, including the greeting and disclosure, is now 6 dB louder: level with the Gemini calls on a quiet sentence, up to 3 dB above them on a loud one.
- A soft limiter rounds off the loudest peaks instead of letting them crackle. On your call's audio it adds about as much error as the phone format already does.
- `AURA_GAIN_DB` tunes the boost without a code change: 8 is louder, 4 is softer, 0 or `off` turns it off.

F8 (Tuesday 3:25 PM, build be95e2e) booked correctly: Wednesday 1 PM, your surname spelled back and confirmed, and "anything else?" before the goodbye. **The volume fix worked.** The voice now reaches you at −14 dBFS, the same as the Gemini calls (F7: −17). The limiter touches about 1 speech sample in 70, about as often as Gemini's own peaks reach that level, so it adds no crackle. What still went wrong:
- **5–7 s of silence after one-word answers (10, 13).** After "Can I grab your first and last name?", the line waits for a name, and it counted a one-word answer as half a name. Your "Sorry?" waited the full 4 s for a second word, plus about a second to hear and answer. You asked again just as the reply started, so your words stopped it and you never heard it. Three more "repeat?" rounds followed. Your surname "McCook" waited the same 4 s: 6.6 s of silence before the times.
- **Two questions at once (11):** "Is this a booked job rather than an urgent one? Can I grab your first and last name?" The prompt already says one question at a time; the model slipped.
- Your first try (3:23 PM) ended when you hung up after 50 s. It had misheard "replacing an existing one" as "facing a new existing one" and asked again.

**Fixed after F8 (commits a47825a → a18530b):**
- "Sorry?", "Can you repeat that?" and "Say again?" are answered at once, even while the line is waiting for a name, number, email, address or time. So are "Hello?", "Can you hear me?" and "Still there?", which also send whatever you'd said so far.
- A one-word answer to a question about one name ("McCook." to "And your last name?") goes through after the usual short pause (about 1.2 s), not the 4 s maximum. It still waits for the rest after "Yeah." or a single letter (a spelling just started), or when she asked for your first and last name together.
- Replaying this call's turns through the real call code: "Sorry?" now reaches the AI at once, and "McCook." after 1.2 s; both took 4 s before.
- **Not fixed:** the two-questions slip (a model habit the prompt already forbids), and the voice's clipped word endings (changing the voice is your call).

F9 (Wednesday 1:53 AM, build 194e99e) booked correctly: today 2 PM, your surname spelled back and confirmed. **The F8 fix worked:** "Can you repeat that again, please?" was answered in 1.1 s, and the "Sorry?" near the end got its answer. Then you asked about languages and tried Spanish, and three things went wrong:
- **The Spanish voice sounded off (16).** F7's +6 dB boost was tuned on Theia. The Spanish voice is 2 dB louder, with peaks 3 dB higher, so the limiter squashed its loud syllables: its distortion was 10 dB worse than Theia's, and 25 times as many samples sat near full scale. Two English catalog voices (Orion, Arcas) had the same problem. The French, German, Italian, Dutch and Japanese voices stayed 4–6 dB quieter than Theia.
- **It never switched back to English (15).** You said "No. I just want to check if you speak any other languages." The AI answered in English but never switched the line back, so the Spanish voice read every English reply to the end of the call. On the recording, "This line speaks English" comes out as "Two sign speaks English".
- **Slow once it switched (13).** After a language switch, the rest of the call uses Deepgram's slower voice path, which makes each whole sentence (1–3.4 s) before playing it. Your answers waited 4–4.5 s, against about 1 s in English before.
- A muddled first offer (11): "Today's first openings are 9:30 AM, but I can offer 2 PM or 3 PM today too. Want 2 PM, or would you rather have 9 AM tomorrow?"

**Fixed after F9 (commits d04db35 → 123f3885):**
- **Each voice gets its own boost.** Every voice we use was measured: how loud it is, and how far it can be pushed before the limiter is heard. The Spanish voice now gets +3.5 dB, which brings its distortion back to Theia's. Orion gets +4.5 and Arcas +4. The quiet language voices get up to +9.5 dB, to come closer to Theia. Theia stays at +6.
- **Back to English.** When the line is in another language and you clearly speak English again (a full sentence, not just "okay, thanks"), it switches back to the English voice before it answers, and the AI is told. Asking in English for the line's language ("Can you say that again in Spanish?") keeps it.
- **"Do you speak Spanish?"** asked in English is answered in English, and the line switches when you say so.
- **Simulated calls:**
  - Replaying F9 (Spanish, then back to English): the line switched back to the English voice in every run (9 of 9 across the last three runs). The old code failed 3 of 3.
  - "Do you speak Spanish?" asked in English: the English voice used to say "Sí, puedo hablar español" first in 5 of 6 calls; none in 21 calls since.
  - Final head (18 calls, Spanish, Arabic, French, Japanese and the two Spanish-and-English callers): spelling, booking and endings 18/18. Language 13/18. Each miss is the AI's own text in another language than its voice: English lines like "Let me book that for you." on Spanish, French and Japanese calls (3), and "Sí, puedo hablar español" in the English voice when you ask in Spanish (2).
- **Not fixed:**
  - The slow replies after a language switch. The fix is to reopen the fast voice path in the new language's voice (and in Theia's on the way back).
  - The AI's own text in a different language from its voice (the misses above). The fix is to choose each sentence's voice from the sentence's own language, instead of predicting it from your words.

F10 (Monday 3:36 AM, build 200ac20f) is the first call with Claude reached through OpenRouter, a stopgap while the Anthropic balance is empty (until November). It worked: 14 replies, no errors, and about as fast as calling Anthropic directly (1.12 s median; F7–F9: 0.91–1.2 s). The call cost about 2.3¢ of the $5 OpenRouter key. An earlier try that evening (Sunday 9:03 PM, build d32438aa) isn't scored: the Anthropic balance had run out, every reply failed, and the AI only apologised. Since 200ac20f, refused Claude requests send new calls on this line to Gemini until the server restarts.

It booked correctly. Asked about yesterday (a Sunday), it said "yesterday's gone, and we're closed on weekends anyway". It then booked 12:30 PM today, after spelling your surname back and getting your yes. What went wrong:
- **Two mishearings (1).** "How about yesterday?" was heard as "Oh, much yesterday", and "Let's see today then" as "Let's see who's they then". It asked again both times.
- **Repeating itself (11).** It named 9 AM four times as it re-offered today, and introduced itself twice. Once it asked two questions at once ("…or replacing an existing one? And can I grab your first and last name?"); you cut that one off.
- **Two names on file.** The booking says Michael Dunn, as spelled back and confirmed on the call. The call log says Michael Gunn: the recording's transcript heard your spelled "D" as "G", and the call summary is written from that transcript. When a call books, the summary should take the name from the booking.
- **Slower after your name (13).** The two slowest replies (2.2–2.3 s) came while the line was waiting for a name. Every other reply took 0.9–1.7 s.

## What the fast calls tell us

**Now passing:** hearing, speed, stopping when interrupted, and hanging up. These are the things we moved off Gemini for.

**Still failing:** conversation logic in the Claude version. That code never got the months of rules and safety checks the Gemini version has. Four root causes cover every ❌ in F2:

1. **Memory (checkpoint 9).** The Claude version keeps only the last 20 messages. By turn 15 of a 29-turn call it had literally lost its own booking. *Fix:* keep the whole call, plus a pinned "this call so far" note: bookings made or cancelled, the name and whether its spelling was confirmed, and the phone.
2. **Name confirmation (checkpoints 2 and 3).** Whether it spells the name back is left to the model's judgement. F1 asked to spell; F2 didn't. *Fix:* the server refuses to book until the surname has been spelled back and confirmed. This is the same idea as the booking check (#442), applied here.
3. **Changing a booking (checkpoint 6).** Asked for "another time", it booked a second appointment. *Fix:* if this call already made a booking, a new booking request is turned into a move unless the caller clearly wants two.
4. **Cancel friction (checkpoint 7).** The cancel safety step held the cancel twice, and the model didn't pass your number, so it asked for it. *Fix:* fill in the caller-ID number automatically, and keep one pending cancel across re-asks. That gives two confirmations at most.

## Changing how we test, to stop the whack-a-mole

Most of these failures are conversation logic, so they don't need a phone call to find.

- **In place (17 Oct):** `scripts/sim-calls`. Another AI plays six scripted callers against the demo line's real prompt, call code, safety checks and booking code, with no audio. Its "phone line" mishears a said surname the way your calls did ("Khoury" heard as "Curry"). Every call is scored against this table automatically.
- Phone calls are now only for what needs a real line: hearing, speed, interruptions and audio.
- Every future phone call gets a new column in the table above.

## Simulated calls (no phone), 17 Oct

The same simulator and scoring on both sides, three runs per scripted caller. "Before" is the build you phoned (F2–F4): six callers, 18 calls. "After" is commit 11728a1: seven callers, 21 calls (the seventh, added after F4, cancels a booking from an earlier call). "After" adds the fixes for the four root causes above, plus three more the simulator and F4 found:
- it moves and cancels its own bookings without asking your name again;
- it doesn't hang up until you've said you're done;
- after a plain cancel, it no longer calls the call an unfinished booking.

A cancel now takes one "yes": the AI reads the booking back once, and the system won't cancel without that answer.

| # | Checkpoint | Before | After |
|---|---|---|---|
| 2 | Gets the surname right | 3/15 | ✅ 15/15 | ⚠️ booked **McCool**, fixed only when you asked | ✅ you spelled it for the lookup |
| 3 | Confirms the spelling before booking | 0/15 | ✅ 15/15 | ❌ **never asked** | — |
| 4 | Books only after the caller agrees to a time | 15/15 | ✅ 15/15 | ✅ | — |
| 5 | Books the time the caller asked for | 11/15 | ✅ 15/15 | ✅ Mon 10:30 | — |
| 6 | Moves a booking when asked | 3/3 | ✅ 3/3 | — | — |
| 7 | Cancels with at most 2 confirmations | 1/3 | ✅ 6/6 | — | ❌ **3 confirmations and asked for the phone** |
| 8 | Never says anything false about bookings | 13/18 | ✅ 21/21 | ✅ | ❌ **"a booking was started but never completed"** |
| 9 | Remembers what it did earlier in the call | 3/7 | ✅ 4/4 | ❌ **asked your name again** ("I just told you") | ✅ |
| 10 | Answers "Sorry?" | 5/5 | ✅ 5/5 |
| 11 | Short replies, no repeating itself | 3/18 | ⚠️ 11/21 | ⚠️ asked for a time twice | ⚠️ re-confirmations |
| 14 | Ends properly | 18/18 | ✅ 21/21 |
| | **Passing on every run** | **4 / 11** | **10 / 11** |

Checkpoints 1, 12 and 13 need a real phone line.

**Still failing: short replies (11).** This comes mostly from the demo script in the line's prompt, not the code:
- The demo announcement ("Just so you know, this is a demo of Phondo…") gets merged with other sentences into one long turn of 45–70 words.
- The script makes it ask "Want me to find you a time?" or "Want me to get Dave to ring you?" even when the caller has just asked for that.
- It ends almost every answer with "Anything else I can help with?".

A stronger instruction in the code didn't fix it. Shortening the announcement and dropping those scripted questions from the prompt should.
