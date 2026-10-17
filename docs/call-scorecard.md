# Demo-line call scorecard

One fixed list of checkpoints. Every test call gets scored against it, so we can see what improved, what regressed and what keeps failing.

- ✅ = passed
- ⚠️ = partly passed, or passed only because a safety check forced it
- ❌ = failed
- — = not exercised in that call

| # | Checkpoint | G1 Gemini 16 Oct 12:51 | G2 Gemini 16 Oct 13:39 | G3 Gemini 16 Oct 14:17 (filter off) | F1 Fast 17 Oct 07:03 | F2 Fast 17 Oct 08:00 | F3 Fast 17 Oct 21:38 (same build as F2) | F4 Fast 17 Oct 21:42 (same build as F2) |
|---|---|---|---|---|---|---|---|---|
| 1 | Hears the caller correctly | ❌ "Nine is good" heard as "Nein, gut"; "yes" heard as "no" | ❌ Spanish, Hindi, Italian | ❌ German, Spanish | ✅ one slip ("Sorry?" heard as "Deville") | ✅ one slip ("book a line") | ⚠️ a few slips ("Audrey"), recovered | ⚠️ "That's my day at night", "Michael but close" |
| 2 | Gets the surname right | ❌ McCool | ❌ Makhlouf | ✅ Makhoul, after a struggle | ✅ Makhoul | ❌ **McCool** | ⚠️ booked **McCool**, fixed only when you asked | ✅ you spelled it for the lookup |
| 3 | Confirms the spelling before booking | ⚠️ only because the check forced it | ❌ | ⚠️ several re-spells | ⚠️ asked to spell, but no "is that right?" | ❌ **never asked** | ❌ **never asked** | — |
| 4 | Books only after the caller agrees to a time | ✅ the check held it | ❌ booked before you agreed | ⚠️ third try unchecked | ✅ | ✅ | ✅ | — |
| 5 | Books the time the caller asked for | — | ❌ 9 AM, not your 10 AM | ✅ 10 AM | ✅ 9:30 | ✅ Tue 9 AM | ✅ Mon 10:30 | — |
| 6 | Moves a booking when asked | — | — | — | ❌ refused (name check) | ❌ **made a second booking instead of moving** | — | — |
| 7 | Cancels with at most 2 confirmations | — | — | — | ❌ refused ("no booking") | ❌ **5 confirmations, and asked for the phone** | — | ❌ **3 confirmations and asked for the phone** |
| 8 | Never says anything false about bookings | ⚠️ "Actually, let me clarify…" | ❌ "You're all set" over your "No" | ⚠️ "Perfect! You're all set" mid-spelling | ❌ "no appointment on the system" | ❌ **"I didn't book anything on this call"** | ✅ | ❌ **"a booking was started but never completed"** |
| 9 | Remembers what it did earlier in the call | — | — | — | ✅ | ❌ **forgot its own Tuesday booking** | ❌ **asked your name again** ("I just told you") | ✅ |
| 10 | Stops when interrupted, answers "Sorry?" | — | — | — | ❌ "Sorry?" waited 10 s | ✅ stopped 8 times when you spoke | ✅ | ✅ took your "No, no" |
| 11 | Short replies, no repeating itself | ✅ | ✅ | ✅ | ❌ 12–15 s replies, repeated offers | ⚠️ short, but asked the time 4× | ⚠️ asked for a time twice | ⚠️ re-confirmations |
| 12 | Speaks spelled names clearly | — | — | — | ❌ dropped "U L" | — | ⚠️ "M-C-C-O-O-L" recorded as "m c c o o" | — |
| 13 | Speed (median gap ≤ 1.5 s) | ✅ ~1.5 s | ✅ | ✅ | ✅ 1.06 s* | ✅ 0.98 s* (p90 4.0 s) | ✅ 0.91 s* (p90 3.0 s) | ✅ 1.03 s* (p90 5.1 s) |
| 14 | Ends properly (goodbye → hangs up; never over an objection) | ❌ cut off by the 3-min limit | ❌ hung up over "No, I said 10AM" | ❌ asked to spell, then hung up | ✅ | ⚠️ you hung up mid-confusion | ✅ | ⚠️ **didn't hang up after "That's all"; logged a callback you didn't want** |
| | **Score (✅ out of checkpoints exercised)** | **3 / 8** | **2 / 10** | **4 / 10** | **6 / 13** | **6 / 13** | **7 / 12** | **4 / 9** |

\* Measured from when it detected you'd finished. Add about 0.3–0.9 s for the real gap from your last word.

F3 and F4 ran the same build as F2: none of the fixes below were deployed yet. They repeat F2's failures, which the simulator also reproduced before the fixes (no spelling check, a forgotten name, cancel friction). F4 adds one the simulator had missed: after a pure cancel, the model ended the call as "booking complete", and the old safety check took that literally, told you there was no appointment, and logged a callback you'd said you didn't want.

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

The same simulator and scoring on both sides: six scripted callers, three runs each (18 calls). "Before" is the build you phoned (F2). "After" (commit 0cfe039) adds the fixes for the four root causes above, plus two more the simulator found: it moves and cancels its own bookings without asking your name again, and it no longer hangs up until you've said you're done. A cancel now takes one "yes": the AI reads the booking back once, and the system won't cancel without that answer.

| # | Checkpoint | Before | After |
|---|---|---|---|
| 2 | Gets the surname right | 3/15 | ✅ 15/15 | ⚠️ booked **McCool**, fixed only when you asked | ✅ you spelled it for the lookup |
| 3 | Confirms the spelling before booking | 0/15 | ✅ 15/15 | ❌ **never asked** | — |
| 4 | Books only after the caller agrees to a time | 15/15 | ✅ 15/15 | ✅ | — |
| 5 | Books the time the caller asked for | 11/15 | ✅ 15/15 | ✅ Mon 10:30 | — |
| 6 | Moves a booking when asked | 3/3 | ✅ 3/3 | — | — |
| 7 | Cancels with at most 2 confirmations | 1/3 | ✅ 3/3 | — | ❌ **3 confirmations and asked for the phone** |
| 8 | Never says anything false about bookings | 13/18 | ✅ 18/18 | ✅ | ❌ **"a booking was started but never completed"** |
| 9 | Remembers what it did earlier in the call | 3/7 | ✅ 3/3 | ❌ **asked your name again** ("I just told you") | ✅ |
| 10 | Answers "Sorry?" | 5/5 | ✅ 5/5 |
| 11 | Short replies, no repeating itself | 3/18 | ⚠️ 10/18 | ⚠️ asked for a time twice | ⚠️ re-confirmations |
| 14 | Ends properly | 18/18 | ✅ 18/18 |
| | **Passing on every run** | **4 / 11** | **10 / 11** |

Checkpoints 1, 12 and 13 need a real phone line.

**Still failing: short replies (11).** This comes mostly from the demo script in the line's prompt, not the code:
- The demo announcement ("Just so you know, this is a demo of Phondo…") gets merged with other sentences into one long turn of 45–70 words.
- The script makes it ask "Want me to find you a time?" or "Want me to get Dave to ring you?" even when the caller has just asked for that.
- It ends almost every answer with "Anything else I can help with?".

A stronger instruction in the code didn't fix it. Shortening the announcement and dropping those scripted questions from the prompt should.
