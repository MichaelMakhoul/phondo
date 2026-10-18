# Pilot running cost: 3 free months (estimated 18 Oct 2026)

**Setup costed:** the demo line's fast pipeline with the ElevenLabs Flash voice (clip 4) on every business's line:
- **Hearing:** Deepgram Flux.
- **Thinking:** Claude Haiku 5.5.
- **Speaking:** ElevenLabs Flash v2.5.
- **Line:** Twilio.

All prices are USD list prices on 18 Oct 2026.

## Cost per minute of call

| Item | Price | ¢ per call-minute | Notes |
|---|---|---|---|
| Twilio inbound, AU local number | $0.0100/min | 1.00 | |
| Twilio Media Streams (live audio to our server) | ~$0.004/min | 0.40 | third-party figure; not on Twilio's AU page |
| Twilio recording + storage | $0.0025 + $0.0005/min | 0.30 | |
| Deepgram Flux, live hearing | $0.0077/min | 0.77 | standard rate; $0.0065 while the promo lasts |
| Deepgram, post-call transcript of the recording | ~$0.0048/min | 0.48 | |
| ElevenLabs Flash voice | $0.04 / 1K chars | 1.44 | AI talks ~40% of the call at ~900 chars per minute |
| Post-call analysis (`gpt-6-luna`) | ~$0.001/call | 0.03 | from `ai-models-refresh-2026-10-09.md` |
| **Total, excluding Claude** | | **≈ 4.4¢** | |
| Claude Haiku 5.5 (voice + validator) | $0.10 / $0.50 per MTok | ≈ 0.33 | ~$0.01 per 3-minute call uncached; prompt caching would cut it further. **Covered by the $200/month Anthropic credit, up to ~20,000 calls a month.** |

With Deepgram Aura-2 instead of ElevenLabs, the voice line drops to 1.08¢ (total ≈ 4.1¢).

## Per business per month

Assumes ~3-minute calls and that the AI answers the business's forwarded or missed calls only. Each business adds an AU local number at $3/month.

| Business | AI-answered calls/month | Minutes | Cost/month | 3 free months |
|---|---|---|---|---|
| Light | 50 | 150 | ~$10 | ~$30 |
| **Typical tradie** | **150** | **450** | **~$23** | **~$69** |
| Busy | 400 | 1,200 | ~$56 | ~$168 |

## Fixed monthly costs (shared, not per business)

| Item | ≈ / month | Notes |
|---|---|---|
| Fly.io always-on voice server | ~$42 | from the Oct 2026 Fly cost memo; scales a little with concurrent calls |
| ElevenLabs plan | **$0 extra** | No fixed cost on top of usage. Pay-as-you-go (no monthly fee) and the monthly plans both charge $0.04 per 1K chars. A plan's fee is simply that month's characters bought up front: Starter $6 = 150K chars, Creator $22 = 550K, Pro $99 = ~2.5M, Scale $299 = ~7.5M. The tier really sets how many voice requests can run at once (~3 on Starter, 5 on Creator, 10 on Pro). Any paid plan includes the commercial licence and API access to library voices. |
| Supabase / Vercel / Resend | current plans | unchanged by the pilot |

## 10 typical businesses for 3 months

- Usage: 10 × $69 ≈ $690.
- Fixed: 3 × ~$42 (the voice server) ≈ $126.
- **Total ≈ US$800–850.** Claude usage is covered by the Anthropic credit.

The ElevenLabs plan isn't counted separately: its fee is prepaid usage that's already in the per-business numbers.

10 typical tradies use about 1.6M characters a month. That's ~$65 on pay-as-you-go, or the Pro plan ($99), which also allows 10 voice requests at once.

## Caveats

- **Call volume dominates the cost.** Check it against the first pilots' real numbers after a month.
- **Media Streams rate** needs confirming on Twilio's live pricing page.
- **The Deepgram promos** (Flux $0.0065, Nova-3 $0.0048) have no end date; the table uses Flux's standard rate.
- **SMS is excluded.** Customer SMS is paused until the ABN sender is registered.
- **The current setup is cheaper.** Today's production lines run Gemini Live, at ≈ 2.25¢/min for Gemini's audio. That puts it in the same range for the speech part, at ~4¢/min all-in with Twilio.

## Sources

- Twilio AU voice pricing: https://www.twilio.com/en-us/voice/pricing/au
- Twilio recording cost: https://support.twilio.com/hc/en-us/articles/223132527-How-Much-Does-It-Cost-to-Record-a-Call
- Deepgram pricing: https://deepgram.com/pricing
- ElevenLabs API pricing: https://elevenlabs.io/pricing/api
- ElevenLabs plans: https://elevenlabs.io/pricing (it shows Starter at $1 and Creator at $11, which look like first-month offers; confirm at checkout)
- Claude Haiku 5.5 pricing: Claude API reference, cached 6 Oct 2026
