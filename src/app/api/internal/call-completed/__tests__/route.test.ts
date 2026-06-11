import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-442: notificationStatus must report the sender's REAL outcome.
// Previously the route hardcoded "sent" after a resolved send — even when
// every channel was disabled by preference and nothing went out.

vi.mock("@/lib/utils/after-response", () => ({ runAfterResponse: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ from: vi.fn(), rpc: vi.fn() })),
}));
vi.mock("@/lib/spam/spam-detector", () => ({ analyzeCall: vi.fn() }));
vi.mock("@/lib/notifications/notification-service", () => ({
  sendMissedCallNotification: vi.fn(),
  sendFailedCallNotification: vi.fn(),
  sendUnsuccessfulCallNotification: vi.fn(),
}));
vi.mock("@/lib/sms/caller-sms", () => ({ sendMissedCallTextBack: vi.fn() }));
vi.mock("@/lib/integrations/webhook-delivery", () => ({ deliverWebhooks: vi.fn() }));
vi.mock("@/lib/security/rate-limiter", () => ({
  withRateLimit: vi.fn(() => ({ allowed: true, headers: {} })),
}));

import { sendMissedCallNotification } from "@/lib/notifications/notification-service";
import { POST } from "@/app/api/internal/call-completed/route";

const SECRET = "test-internal-secret";

/** A short, transcript-less, non-spam call — classifies as "missed". */
function missedCallRequest() {
  return new Request("http://localhost/api/internal/call-completed", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": SECRET,
    },
    body: JSON.stringify({
      callId: null,
      organizationId: "org-1",
      assistantId: null,
      callerPhone: "", // no spam analysis / text-back path
      status: "missed",
      durationSeconds: 5,
    }),
  });
}

describe("POST /api/internal/call-completed notificationStatus honesty (SCRUM-442)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_API_SECRET = SECRET;
  });

  it("reports 'sent' when the sender actually delivered a channel", async () => {
    vi.mocked(sendMissedCallNotification).mockResolvedValue("sent");

    const res = await POST(missedCallRequest());

    expect(res.status).toBe(200);
    expect((await res.json()).notificationStatus).toBe("sent");
    expect(sendMissedCallNotification).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1" }),
    );
  });

  it("reports 'skipped' when every channel was disabled by preference", async () => {
    vi.mocked(sendMissedCallNotification).mockResolvedValue("skipped");

    const res = await POST(missedCallRequest());

    expect(res.status).toBe(200);
    expect((await res.json()).notificationStatus).toBe("skipped");
  });

  it("reports 'failed' when the sender throws (wanted but undeliverable)", async () => {
    vi.mocked(sendMissedCallNotification).mockRejectedValue(
      new Error("missed-call: 0 notification channels delivered — wanted channel(s) unavailable: owner-email"),
    );

    const res = await POST(missedCallRequest());

    expect(res.status).toBe(200); // route still acks; failure is in the field
    expect((await res.json()).notificationStatus).toBe("failed");
  });
});
