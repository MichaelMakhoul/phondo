import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTACT_METHODS, contactOutcomeSentence, type CustomerContactResult } from "../customer-contact";
import { CALL_OUTCOMES, CALL_PURPOSES, TIMES_OF_DAY, VOICE_CALL_BLOCK_REASONS, checkCustomerCall, type TimeWindow } from "../customer-call";
import { CUSTOMER_NOTIFY_CALL_TYPE } from "../owner-call";
import { MACHINE_ANSWERS, buildCallOutcome, callResultOf } from "../call-outcome";
import { REQUESTED_BY_PATH } from "../recap";
import { OWNER_TOOL_NAMES, spokenPhone, parseBookingDetails } from "../tool-handlers";
import { parsePhoneToE164 } from "@/lib/phone/normalize";

// SCRUM-597 (types lens F6): the "let them know?" contract lives on both sides — the
// website's handlers write it, the voice server declares it to the model and reads it
// back. Each side's own tests check only their own copy, so this keep-in-sync guard
// require()s the voice server's modules and checks them against the TS ones.
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const vs = (rel: string) => require(path.join(here, "../../../../voice-server/lib", rel));
const ownerTools = vs("owner-tools.js") as {
  ownerToolDefinitions: Array<{ function: { name: string; parameters: { properties: Record<string, any>; required: string[] } } }>;
  OWNER_TOOL_NAMES: readonly string[];
};
const customerCall = vs("customer-call.js") as {
  CALL_BLOCK_REASONS: readonly string[];
  NOTIFY_PURPOSES: readonly string[];
  CALL_OUTCOMES: readonly string[];
  TIMES_OF_DAY: readonly string[];
  CUSTOMER_NOTIFY_CALL_TYPE: string;
  AMD_CONVERSATION: ReadonlySet<string>;
  AMD_VOICEMAIL: ReadonlySet<string>;
  notifyMetadata: (notify: Record<string, unknown>, extra?: Record<string, unknown>) => Record<string, unknown>;
  notifyCallEnd: (s: Record<string, unknown>, endedReason: string | null) => { notify: Record<string, unknown>; outcome: string };
  markSetupFailed: (supabase: unknown, notify: Record<string, unknown>, reason: string) => Promise<boolean>;
  finishCustomerCall: (row: Record<string, unknown>, what: Record<string, unknown>, deps: Record<string, unknown>) => Promise<{ finalized: boolean; reason: string }>;
  parseTimeWindow: (v: unknown) => { window: unknown } | null;
  sweepStuckCustomerCalls: (deps: Record<string, unknown>) => Promise<{ swept: number; checked: number; closed: number }>;
};
const runner = vs("owner-tool-runner.js") as {
  describeOwnerToolCall: (name: string, args: object, message: string, successful: boolean, data?: unknown) => string | null;
  runOwnerToolCall: (session: Record<string, any>, call: { name: string; args: Record<string, unknown> }, deps: Record<string, unknown>) => Promise<unknown>;
};

const writeTool = (name: string) => ownerTools.ownerToolDefinitions.find((d) => d.function.name === name)!.function;

describe("website ↔ voice server: the customer-contact contract", () => {
  it("the model is offered exactly the notify_customer values the handlers parse", () => {
    for (const name of ["owner_reschedule_appointment", "owner_cancel_appointment"]) {
      expect(writeTool(name).parameters.properties.notify_customer.enum).toEqual([...CONTACT_METHODS]);
    }
  });

  // Keyed by status: a new status (SCRUM-598's "calling") fails to compile here until
  // its sample and the voice server's wording for it are added (types lens round 2).
  const SAMPLES: { [S in CustomerContactResult["status"]]: Array<[Extract<CustomerContactResult, { status: S }>, string]> } = {
    sent: [[{ method: "text", status: "sent" }, " — customer texted"]],
    not_sent: [
      [{ method: "text", status: "not_sent", reason: "texts_paused" }, " — customer not texted"],
      [{ method: "text", status: "not_sent", reason: "rate_limited" }, " — customer not texted"],
    ],
    calling: [[{ method: "call", status: "calling", callId: "c-1" }, " — calling the customer"]],
    not_placed: [
      [{ method: "call", status: "not_placed", reason: "calls_disabled" }, " — customer not called"],
      [{ method: "call", status: "not_placed", reason: "outside_hours" }, " — customer not called"],
      [{ method: "call", status: "not_placed", reason: "place_unconfirmed" }, " — customer not called"],
    ],
    not_requested: [[{ method: "none", status: "not_requested" }, " — customer not told"]],
  };

  it("the voice server's call summary cuts every customer sentence the handlers write, and takes the outcome from data", () => {
    const change = "Cancelled Dr. J. Smith's job on Friday, October 16 at 3:00 PM.";
    const results = Object.values(SAMPLES).flat() as Array<[CustomerContactResult, string]>;
    for (const [result, tail] of results) {
      for (const kind of ["cancelled", "moved"] as const) {
        const message = change + contactOutcomeSentence(result, "Dr. J. Smith", kind);
        const data = { outcome: "cancelled", customer_contact: result };
        expect(runner.describeOwnerToolCall("owner_cancel_appointment", {}, message, true, data), `${kind} ${JSON.stringify(result)}`).toBe(
          change.replace(/\.$/, "") + tail
        );
      }
    }
  });

  // SCRUM-598: the call's own contract — the voice server's refusals and purposes are
  // the ones the website words, and owner_call_customer is declared with what the route plucks.
  it("both sides know the same call refusals, purposes, outcomes, times of day and call type", () => {
    expect([...VOICE_CALL_BLOCK_REASONS]).toEqual([...customerCall.CALL_BLOCK_REASONS]);
    expect([...CALL_PURPOSES]).toEqual([...customerCall.NOTIFY_PURPOSES]);
    // Types lens T1: a drifted outcome would drop out of the owner's email silently...
    expect([...CALL_OUTCOMES]).toEqual([...customerCall.CALL_OUTCOMES]);
    expect([...TIMES_OF_DAY]).toEqual([...customerCall.TIMES_OF_DAY]);
    // ...and a drifted call type would run the customer pipeline (a text-back to the customer we rang).
    expect(CUSTOMER_NOTIFY_CALL_TYPE).toBe(customerCall.CUSTOMER_NOTIFY_CALL_TYPE);
  });

  it("every Twilio AnsweredBy is exactly one of: talked to, a voicemail, or a machine the call hung up on (code lens N7)", () => {
    // Twilio's documented AnsweredBy values (DetectMessageEnd never sends machine_start; it is kept for safety).
    const TWILIO_ANSWERED_BY = ["human", "unknown", "fax", "machine_start", "machine_end_beep", "machine_end_silence", "machine_end_other"];
    for (const v of TWILIO_ANSWERED_BY) {
      const homes = [customerCall.AMD_CONVERSATION.has(v), customerCall.AMD_VOICEMAIL.has(v), MACHINE_ANSWERS.has(v)].filter(Boolean).length;
      expect(homes, v).toBe(1);
    }
  });

  it("the window the website sends is the window the voice server reads (types lens N2)", async () => {
    const window = { earliest: "2026-11-02", latest: "2026-11-06", timeOfDay: "morning" } satisfies TimeWindow;
    let sent: any = null;
    const fetch = (async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ canCall: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    await checkCustomerCall(
      { organizationId: "o", appointmentId: "a1", purpose: "find_new_time", phone: "0412 345 678", requestedByCallId: "o1", window },
      { voiceServerUrl: "https://voice.example", internalSecret: "s", fetch }
    );
    // A renamed key would be read as "no limit" and the call would run without the window the owner approved.
    expect(customerCall.parseTimeWindow(sent.window)).toEqual({ window });
  });
});

// Types lens N3: the voice server's own writers, run for real, feed the website's own
// readers — a key renamed on either side fails here, not in an owner's email.
describe("website ↔ voice server: what a customer call's row says", () => {
  const ORG = "11111111-2222-4333-a444-555555555555";
  const CALL = "55555555-5555-4555-8555-555555555555";
  const BOOKING = "aaaaaaaa-0000-4000-8000-000000000001";
  const NOTIFY = { callId: CALL, organizationId: ORG, appointmentId: BOOKING, purpose: "confirm", requestedByCallId: "o1", mode: "conversation", answeredBy: "human" };
  /** The voice server's writers' view of the DB: reads answer `row`, every update is kept. */
  function writerDb(row: Record<string, unknown>) {
    const writes: Array<Record<string, any>> = [];
    const chain = (result: unknown) => {
      const b: any = {};
      for (const m of ["select", "eq", "in", "order"]) b[m] = () => b;
      b.maybeSingle = async () => result;
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
      return b;
    };
    return {
      writes,
      from: () => ({
        select: () => chain({ data: row, error: null }),
        update: (payload: Record<string, any>) => {
          writes.push(payload);
          return chain({ data: [{ id: row.id }], error: null });
        },
      }),
    };
  }
  /** The website's reader's view: the call row, then the booking, then no other bookings. */
  function readerDb(call: Record<string, unknown>) {
    return {
      from: (table: string) => {
        const b: any = {};
        for (const m of ["select", "eq", "in", "order"]) b[m] = () => b;
        b.maybeSingle = async () => ({
          data:
            table === "calls"
              ? { id: CALL, summary: null, caller_phone: "+61412345678", started_at: null, ended_at: null, created_at: "2026-10-27T03:00:00Z", ...call }
              : { id: BOOKING, attendee_name: "Jane Smith", start_time: "2026-10-28T03:30:00Z", status: "confirmed", updated_at: "2026-10-20T00:00:00Z", rescheduled_from_id: null },
          error: null,
        });
        b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res, rej);
        return b;
      },
    };
  }
  const read = (call: Record<string, unknown>) => buildCallOutcome(readerDb(call), { organizationId: ORG, callId: CALL, timezone: "Australia/Sydney" });

  it("the request's ids sit where the recap and the outcome email look for them (types lens R1)", () => {
    const requestedByKey = REQUESTED_BY_PATH.split("->>").pop() as string;
    expect(REQUESTED_BY_PATH).toBe(`metadata->notify->>${requestedByKey}`);
    // recap.ts matches a placed call to its change by these three.
    expect(customerCall.notifyMetadata(NOTIFY)).toMatchObject({ [requestedByKey]: "o1", appointment_id: BOOKING, purpose: "confirm" });
  });

  it("a conversation's end-of-call fields (notifyCallEnd) read back: purpose, result, outcome and note", async () => {
    const end = customerCall.notifyCallEnd({ notify: NOTIFY, notifyOutcome: { outcome: "declined", note: "Can't make it" } }, "end_call_tool");
    const r = await read({ status: "completed", outcome: end.outcome, duration_seconds: 80, metadata: { call_type: CUSTOMER_NOTIFY_CALL_TYPE, notify: end.notify } });
    expect(r?.purpose).toBe("confirm");
    expect(r?.result).toEqual({ kind: "answered", seconds: 80, endedOnAFault: false, sureItWasAPerson: true });
    expect(r?.assistantOutcome).toBe("declined");
    expect(r?.assistantNote).toBe("Can't make it");
  });

  it("a voicemail spoken and played reads as left, with its message; one never spoken reads as not left", async () => {
    const vm = { ...NOTIFY, mode: "voicemail", answeredBy: "machine_end_beep" };
    const left = customerCall.notifyCallEnd({ notify: vm, notifyVoicemailDone: true, notifyVoicemailText: "Hi Jane, it's Bob's Plumbing.", notifyVoicemailPlayed: true }, "customer-call-voicemail-left");
    const r = await read({ status: "completed", outcome: left.outcome, duration_seconds: 20, metadata: { notify: left.notify } });
    expect(r?.result).toEqual({ kind: "voicemail", playedToEnd: true });
    expect(r?.voicemailText).toBe("Hi Jane, it's Bob's Plumbing.");
    const unspoken = customerCall.notifyCallEnd({ notify: vm, notifyVoicemailText: "Hi Jane" }, "customer-call-voicemail-not-spoken");
    expect(callResultOf({ status: "failed", outcome: unspoken.outcome, metadata: { notify: unspoken.notify } })).toEqual({ kind: "voicemail_not_left" });
  });

  it("a setup failure stamped by markSetupFailed reads as our failure, never the customer hanging up", async () => {
    const db = writerDb({ id: CALL, metadata: { call_type: CUSTOMER_NOTIFY_CALL_TYPE, notify: customerCall.notifyMetadata(NOTIFY) } });
    expect(await customerCall.markSetupFailed(db, NOTIFY, "no-briefing")).toBe(true);
    // Twilio's status callback then finishes the row as "completed".
    expect(callResultOf({ status: "completed", outcome: null, metadata: db.writes[0].metadata })).toEqual({ kind: "failed_on_our_side" });
  });

  it("finishCustomerCall's cut off, fax and no answer read back as such", async () => {
    const row = { id: CALL, organization_id: ORG, assistant_id: "asst-1", caller_phone: "+61412345678", metadata: { notify: customerCall.notifyMetadata(NOTIFY) } };
    const finish = async (status: string, what: Record<string, unknown>) => {
      const db = writerDb({ ...row, status });
      const done = await customerCall.finishCustomerCall({ ...row, status }, what, { supabase: db, notifyCallCompleted: async () => {} });
      expect(done.finalized).toBe(true);
      const w = db.writes[0];
      return callResultOf({ status: w.status, outcome: null, duration_seconds: w.duration_seconds, metadata: w.metadata });
    };
    expect(await finish("in-progress", { twilioStatus: "completed", durationSeconds: 95 })).toEqual({ kind: "cut_off", seconds: 95 });
    expect(await finish("ringing", { twilioStatus: "completed", durationSeconds: 3, answeredBy: "fax" })).toEqual({ kind: "machine_answered" });
    expect(await finish("queued", { twilioStatus: "no-answer", durationSeconds: 0 })).toEqual({ kind: "no_answer" });
    expect(await finish("queued", { twilioStatus: "busy", durationSeconds: 0 })).toEqual({ kind: "busy" });
  });

  it("a call the sweeper gives up on (Twilio never told us how it ended) reads 'we don't know', never 'didn't go through' (tests lens)", async () => {
    const sid = `CA${"0123456789abcdef".repeat(2)}`;
    const row = {
      id: CALL, organization_id: ORG, assistant_id: "asst-1", vapi_call_id: `sh_${sid}`, caller_phone: "+61412345678", status: "ringing",
      created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      metadata: { call_type: CUSTOMER_NOTIFY_CALL_TYPE, notify: customerCall.notifyMetadata(NOTIFY) },
    };
    const writes: Array<Record<string, any>> = [];
    const chain = (result: unknown) => {
      const b: any = {};
      for (const m of ["select", "eq", "in", "like", "lt", "order", "limit"]) b[m] = () => b;
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
      return b;
    };
    const db = {
      from: () => ({
        select: () => chain({ data: [row], error: null }),
        update: (payload: Record<string, any>) => {
          writes.push(payload);
          return chain({ data: [{ id: CALL }], error: null });
        },
      }),
    };
    const done = await customerCall.sweepStuckCustomerCalls({ supabase: db, hasLiveSession: () => false, fetchTwilioCall: async () => null, notifyCallCompleted: async () => {} });
    expect(done.swept).toBe(1);
    expect(callResultOf({ status: writes[0].status, outcome: null, metadata: writes[0].metadata })).toEqual({ kind: "unknown_end" });
  });
  it("the owner tool names match, and owner_call_customer declares exactly the arguments the route reads", () => {
    expect([...OWNER_TOOL_NAMES]).toEqual([...ownerTools.OWNER_TOOL_NAMES]);
    const call = writeTool("owner_call_customer");
    expect(Object.keys(call.parameters.properties).sort()).toEqual(["appointment_id", "confirmed", "earliest_date", "latest_date", "purpose", "time_of_day"]);
    expect(call.parameters.properties.time_of_day.enum).toEqual([...TIMES_OF_DAY]);
    expect(call.parameters.properties.purpose.enum).toEqual(["confirm", "find_new_time"]);
  });
});

// SCRUM-599: the three new writes — what the voice server declares is what the route
// plucks, a booking is offered only the handler's own choices, and the stored summary
// cuts every customer sentence the booking handler writes.
describe("website ↔ voice server: book, block and mark done", () => {
  it("each declares exactly the arguments the route reads", () => {
    expect(Object.keys(writeTool("owner_book_appointment").parameters.properties).sort()).toEqual(["confirmed", "customer_email", "customer_name", "customer_phone", "details", "notes", "notify_customer", "service_type_id", "start"]);
    expect(Object.keys(writeTool("owner_block_time").parameters.properties).sort()).toEqual(["confirmed", "end", "reason", "start"]);
    expect(Object.keys(writeTool("owner_mark_callback_done").parameters.properties).sort()).toEqual(["callback_id", "confirmed", "note"]);
  });

  it("a new booking is offered a text or nothing: the contact methods the handlers parse, less the call", () => {
    expect(writeTool("owner_book_appointment").parameters.properties.notify_customer.enum).toEqual(CONTACT_METHODS.filter((m) => m !== "call"));
  });

  it("the voice server's summary of a booking ends at its customer sentence and takes the outcome from data", () => {
    const booking = "Booked Dr. J. Smith for Friday, October 16 at 10:00 AM with Alex.";
    const textResults: Array<[CustomerContactResult, string]> = [
      [{ method: "text", status: "sent" }, " — customer texted"],
      [{ method: "text", status: "not_sent", reason: "texts_paused" }, " — customer not texted"],
      [{ method: "text", status: "not_sent", reason: "landline" }, " — customer not texted"],
      [{ method: "none", status: "not_requested" }, " — customer not told"],
    ];
    for (const [result, tail] of textResults) {
      const message = booking + contactOutcomeSentence(result, "Dr. J. Smith", "booked");
      expect(runner.describeOwnerToolCall("owner_book_appointment", {}, message, true, { outcome: "booked", customer_contact: result }), JSON.stringify(result)).toBe(booking.replace(/\.$/, "") + tail);
    }
  });
});

// SCRUM-601 (test lens gap 2): the website reads a booking's number back in its national
// form, and the model may copy that form into its confirm. The voice server's gate keys a
// yes by the number's digits, so each form the read-back gives must confirm the form the
// owner said — run through the real gate, not a hand-copied list of formats.
describe("SCRUM-601: the number the read-back gives confirms the number the owner said", () => {
  const BOOK = { customer_name: "Jane Smith", start: "2026-10-29T14:00", notes: "Leaking tap" };
  let clock = 0;
  const stamp = () => (clock = Math.max(Date.now() + 1, clock + 1));
  /** Arm a booking with the number as said, answer its read-back, confirm with `confirmedAs`: what the gate forwarded. */
  async function confirmedWith(said: string, confirmedAs: string): Promise<unknown> {
    const forwarded: Array<Record<string, unknown>> = [];
    const deps = {
      executeToolCall: async (_name: string, args: Record<string, unknown>) => {
        forwarded.push(args);
        return args.confirmed === true
          ? { success: true, message: "Booked.", data: { outcome: "booked" } }
          : { success: false, message: "Read this back…", data: { outcome: "needs_confirmation" } };
      },
      scheduleCache: { invalidate: () => {} },
      now: () => stamp(),
    };
    const session: Record<string, any> = {
      callSid: "CA1", organizationId: "org-1", assistantId: "asst-1", callRecordId: "call-1", ownerMode: true,
      organization: { timezone: "Australia/Sydney" }, callerPhone: "+61400000001", orgPhoneNumber: "+61255550000",
      telephonyProvider: "twilio", toolCallAudit: [], ownerToolCalls: 0,
      assistantTurnSeq: 0, lastAssistantTurnAt: 0, lastAssistantSpeechAt: 0, lastOwnerSpeechAt: 0,
    };
    await runner.runOwnerToolCall(session, { name: "owner_book_appointment", args: { ...BOOK, customer_phone: said } }, deps);
    // The read-back is heard, then the owner says yes.
    session.lastAssistantSpeechAt = stamp(); session.assistantTurnSeq += 1; session.lastAssistantTurnAt = stamp();
    session.lastOwnerSpeechAt = stamp();
    await runner.runOwnerToolCall(session, { name: "owner_book_appointment", args: { ...BOOK, customer_phone: confirmedAs, confirmed: true, notify_customer: "none" } }, deps);
    return forwarded.at(-1)?.confirmed;
  }

  for (const [said, country] of [
    ["0412 345 678", "AU"], ["+61 412 345 678", "AU"], ["61 412 345 678", "AU"], ["412 345 678", "AU"],
    ["(02) 9555 1234", "AU"], ["+61 2 9555 1234", "AU"],
    ["415-555-1234", "US"], ["+1 415 555 1234", "US"], ["1 (415) 555-1234", "US"],
  ] as const) {
    it(`${country} ${said}: confirmed as the read-back gives it, and as it is saved`, async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const saved = parsePhoneToE164(said, country);
      expect(saved, "parses in the org's country").not.toBeNull();
      const shown = spokenPhone(saved!, country);
      expect(shown, "read back in the national form").not.toBeNull();
      expect(await confirmedWith(said, shown!)).toBe(true);
      expect(await confirmedWith(said, saved!)).toBe(true);
    });
  }

  it("a number from elsewhere is read back as said, so confirming it as said goes through — and its +1 twin never does", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(spokenPhone("+64 9 555 1234", "AU")).toBeNull();
    expect(await confirmedWith("+64 9 555 1234", "+64 9 555 1234")).toBe(true);
    expect(await confirmedWith("+64 9 555 1234", "+1 649 555 1234")).toBe(false);
  });
});

// SCRUM-602: the website's `details` parser and the voice gate's key are two readings of
// one string. What the website ACCEPTS the gate must arm (else the read-back could never
// be confirmed); what the website REFUSES the gate must never arm. The same strings go
// through both here — hand-copied formats on either side would drift.
describe("SCRUM-602: a booking's details are read the same way by the website and the voice gate", () => {
  const BOOK = { customer_name: "Jane Smith", customer_phone: "0412 345 678", start: "2026-10-29T14:00" };
  let clock = 0;
  const stamp = () => (clock = Math.max(Date.now() + 1, clock + 1));
  /** Arm a booking with `details`; then confirm it with `confirmedAs` after the read-back: [armed, confirmed]. */
  async function armed(details: string, confirmedAs = details): Promise<[boolean, boolean]> {
    const forwarded: Array<Record<string, unknown>> = [];
    const deps = {
      executeToolCall: async (_n: string, args: Record<string, unknown>) => {
        forwarded.push(args);
        return args.confirmed === true ? { success: true, message: "Booked.", data: { outcome: "booked" } } : { success: false, message: "Read this back…", data: { outcome: "needs_confirmation" } };
      },
      scheduleCache: { invalidate: () => {} },
      now: () => stamp(),
    };
    const session: Record<string, any> = {
      callSid: "CA1", organizationId: "org-1", assistantId: "asst-1", callRecordId: "call-1", ownerMode: true,
      organization: { timezone: "Australia/Sydney" }, callerPhone: "+61400000001", orgPhoneNumber: "+61255550000",
      telephonyProvider: "twilio", toolCallAudit: [], ownerToolCalls: 0,
      assistantTurnSeq: 0, lastAssistantTurnAt: 0, lastAssistantSpeechAt: 0, lastOwnerSpeechAt: 0,
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runner.runOwnerToolCall(session, { name: "owner_book_appointment", args: { ...BOOK, details } }, deps);
    const isArmed = (session.ownerPendingConfirmations?.size ?? 0) > 0;
    session.lastAssistantSpeechAt = stamp(); session.assistantTurnSeq += 1; session.lastAssistantTurnAt = stamp();
    session.lastOwnerSpeechAt = stamp();
    await runner.runOwnerToolCall(session, { name: "owner_book_appointment", args: { ...BOOK, details: confirmedAs, confirmed: true, notify_customer: "none" } }, deps);
    return [isArmed, forwarded.at(-1)?.confirmed === true];
  }

  const ACCEPTED = [
    "service address=12 Smith St; urgency level=today",
    "service address: 12 Smith St;urgency level : today",
    "service address=12 Smith St\nurgency level=today",
    "service address=12 Smith St;\r\n  urgency\tlevel=today\n",
    "service address=12 Smith St\u2028urgency level=today",
    "service address＝12 Smith St； urgency level＝today", // fullwidth, NFKC on both sides
    "service address=12 Smith St; urgency level=to\u200bday", // an invisible mark in a value
    "preferred time=9:30; service address=12 Smith St",
  ];
  const REFUSED = [
    "just some words",
    "service address=12 Smith St; Wyong; urgency level=today",
    "service address=12 Smith St; problem description=tap leaking\nunder the sink",
    "service address=12 Smith St; service address=14 Smith St",
    "surname=Smith; last name=Jones",
    "email=a@example.com; email address=b@example.com",
  ];

  for (const s of ACCEPTED) {
    it(`accepted by the website, armed and confirmable by the gate: ${JSON.stringify(s)}`, async () => {
      expect(Array.isArray(parseBookingDetails(s)), "the website reads it").toBe(true);
      expect(await armed(s)).toEqual([true, true]);
    });
  }
  it("the same details across spacing, order and line breaks confirm each other", async () => {
    expect(await armed("service address=12 Smith St; urgency level=today", "Urgency Level: today\nservice_address = 12  Smith St")).toEqual([true, true]);
  });
  for (const s of REFUSED) {
    it(`refused by the website — unreadable or a field twice — and never armed by the gate: ${JSON.stringify(s)}`, async () => {
      const parsed = parseBookingDetails(s);
      const websiteRefuses = parsed === "unreadable" || (Array.isArray(parsed) && new Set(parsed.map((p) => p.key.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^surname$/, "lastname").replace(/^emailaddress$/, "email"))).size < parsed.length);
      expect(websiteRefuses, "the website refuses it").toBe(true);
      expect(await armed(s)).toEqual([false, false]);
    });
  }
});
