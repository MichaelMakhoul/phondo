import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// SCRUM-597 (client simulation round 2): a moved booking's text must say it MOVED.
// "Your appointment … is confirmed for <new time>" reads as the old booking
// re-confirmed, and the customer may turn up at the old time. The dashboard's
// reschedule text (SCRUM-399 send_sms) asks for the moved wording.
const route = readFileSync(join(process.cwd(), "src/app/api/v1/appointments/[id]/route.ts"), "utf-8");

describe("the dashboard's reschedule text", () => {
  it("is sent as a move", () => {
    const call = route.slice(route.indexOf("await sendAppointmentConfirmationSMS("), route.indexOf("if (smsResult && smsResult.sent === false)"));
    expect(call).toMatch(/inserted\.id,\s*(\/\/[^\n]*\n\s*)*\{ moved: true \}\s*\);/);
  });
});
