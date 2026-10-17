# Demo-line call scorecard

One fixed list of checkpoints. Every test call gets scored against it, so we can see what improved, what regressed and what keeps failing.

- ✅ = passed
- ⚠️ = partly passed, or passed only because a safety check forced it
- ❌ = failed
- — = not exercised in that call

| # | Checkpoint | G1 Gemini 16 Oct 12:51 | G2 Gemini 16 Oct 13:39 | G3 Gemini 16 Oct 14:17 (filter off) | F1 Fast 17 Oct 07:03 | F2 Fast 17 Oct 08:00 |
|---|---|---|---|---|---|---|
| 1 | Hears the caller correctly | ❌ "Nine is good" heard as "Nein, gut"; "yes" heard as "no" | ❌ Spanish, Hindi, Italian | ❌ German, Spanish | ✅ one slip ("Sorry?" heard as "Deville") | ✅ one slip ("book a line") |
| 2 | Gets the surname right | ❌ McCool | ❌ Makhlouf | ✅ Makhoul, after a struggle | ✅ Makhoul | ❌ **McCool** |
| 3 | Confirms the spelling before booking | ⚠️ only because the check forced it | ❌ | ⚠️ several re-spells | ⚠️ asked to spell, but no "is that right?" | ❌ **never asked** |
| 4 | Books only after the caller agrees to a time | ✅ the check held it | ❌ booked before you agreed | ⚠️ third try unchecked | ✅ | ✅ |
| 5 | Books the time the caller asked for | — | ❌ 9 AM, not your 10 AM | ✅ 10 AM | ✅ 9:30 | ✅ Tue 9 AM |
| 6 | Moves a booking when asked | — | — | — | ❌ refused (name check) | ❌ **made a second booking instead of moving** |
| 7 | Cancels with at most 2 confirmations | — | — | — | ❌ refused ("no booking") | ❌ **5 confirmations, and asked for the phone** |
| 8 | Never says anything false about bookings | ⚠️ "Actually, let me clarify…" | ❌ "You're all set" over your "No" | ⚠️ "Perfect! You're all set" mid-spelling | ❌ "no appointment on the system" | ❌ **"I didn't book anything on this call"** |
| 9 | Remembers what it did earlier in the call | — | — | — | ✅ | ❌ **forgot its own Tuesday booking** |
| 10 | Stops when interrupted, answers "Sorry?" | — | — | — | ❌ "Sorry?" waited 10 s | ✅ stopped 8 times when you spoke |
| 11 | Short replies, no repeating itself | ✅ | ✅ | ✅ | ❌ 12–15 s replies, repeated offers | ⚠️ short, but asked the time 4× |
| 12 | Speaks spelled names clearly | — | — | — | ❌ dropped "U L" | — |
| 13 | Speed (median gap ≤ 1.5 s) | ✅ ~1.5 s | ✅ | ✅ | ✅ 1.06 s* | ✅ 0.98 s* (p90 4.0 s) |
| 14 | Ends properly (goodbye → hangs up; never over an objection) | ❌ cut off by the 3-min limit | ❌ hung up over "No, I said 10AM" | ❌ asked to spell, then hung up | ✅ | ⚠️ you hung up mid-confusion |
| | **Score (✅ out of checkpoints exercised)** | **3 / 8** | **2 / 10** | **4 / 10** | **6 / 13** | **6 / 13** |

\* Measured from when it detected you'd finished. Add about 0.3–0.9 s for the real gap from your last word.

## What the fast calls tell us

**Now passing:** hearing, speed, stopping when interrupted, and hanging up. These are the things we moved off Gemini for.

**Still failing:** conversation logic in the Claude version. That code never got the months of rules and safety checks the Gemini version has. Four root causes cover every ❌ in F2:

1. **Memory (checkpoint 9).** The Claude version keeps only the last 20 messages. By turn 15 of a 29-turn call it had literally lost its own booking. *Fix:* keep the whole call, plus a pinned "this call so far" note: bookings made or cancelled, the name and whether its spelling was confirmed, and the phone.
2. **Name confirmation (checkpoints 2 and 3).** Whether it spells the name back is left to the model's judgement. F1 asked to spell; F2 didn't. *Fix:* the server refuses to book until the surname has been spelled back and confirmed. This is the same idea as the booking check (#442), applied here.
3. **Changing a booking (checkpoint 6).** Asked for "another time", it booked a second appointment. *Fix:* if this call already made a booking, a new booking request is turned into a move unless the caller clearly wants two.
4. **Cancel friction (checkpoint 7).** The cancel safety step held the cancel twice, and the model didn't pass your number, so it asked for it. *Fix:* fill in the caller-ID number automatically, and keep one pending cancel across re-asks. That gives two confirmations at most.

## Changing how we test, to stop the whack-a-mole

Most of these failures are conversation logic, so they don't need a phone call to find.

- **Recommended:** a simulated-caller test. Another AI plays scripted callers against the real Claude prompt and tools, in test mode, with no audio. Scenarios: book with a spelled name, change the time, cancel, "Sorry?", goodbye.
- Each run is scored automatically against this table, many times per change, in minutes.
- Phone calls are then only for what needs a real line: hearing, speed, interruptions and audio.
- Every future call gets a new column in this file.
