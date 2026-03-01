/**
 * Admin Alerts
 *
 * Sends email + SMS alerts to the platform admin when critical services
 * go down or recover. Uses the same Resend/Twilio clients as the
 * notification service.
 */

import { Resend } from "resend";
import Twilio from "twilio";

export async function sendAdminAlert(
  type: "down" | "recovered",
  service: string,
  message: string
): Promise<void> {
  const email = process.env.ADMIN_ALERT_EMAIL;
  const phone = process.env.ADMIN_ALERT_PHONE;

  if (!email && !phone) {
    console.warn("[AdminAlert] No ADMIN_ALERT_EMAIL or ADMIN_ALERT_PHONE configured — skipping alert");
    return;
  }

  const channels: Promise<void>[] = [];

  if (email) {
    channels.push(sendAlertEmail(email, type, service, message));
  }

  if (phone) {
    channels.push(sendAlertSMS(phone, type, service, message));
  }

  const results = await Promise.allSettled(channels);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[AdminAlert] Alert delivery failed:", result.reason);
    }
  }
}

async function sendAlertEmail(
  to: string,
  type: "down" | "recovered",
  service: string,
  message: string
): Promise<void> {
  const apiKey = process.env.EMAIL_API_KEY;
  if (!apiKey) {
    console.warn("[AdminAlert] EMAIL_API_KEY not set — cannot send alert email");
    return;
  }

  const fromEmail = process.env.EMAIL_FROM || "notifications@holarecep.com";
  const emoji = type === "down" ? "[DOWN]" : "[RECOVERED]";
  const subject = `${emoji} Hola Recep — ${service}`;

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: fromEmail,
    to,
    subject,
    html: `
      <h2 style="color: ${type === "down" ? "#dc2626" : "#16a34a"};">
        ${type === "down" ? "Service Down" : "Service Recovered"}
      </h2>
      <p><strong>Service:</strong> ${service}</p>
      <p><strong>Details:</strong> ${message}</p>
      <p><strong>Time:</strong> ${new Date().toISOString()}</p>
    `,
  });

  if (error) {
    throw new Error(`Resend error: ${error.message}`);
  }

  console.log("[AdminAlert] Email sent:", { to, subject });
}

async function sendAlertSMS(
  to: string,
  type: "down" | "recovered",
  service: string,
  message: string
): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !from) {
    console.warn("[AdminAlert] Twilio credentials not set — cannot send alert SMS");
    return;
  }

  const prefix = type === "down" ? "[DOWN]" : "[OK]";
  const body = `${prefix} Hola Recep: ${service} — ${message}`;

  const client = Twilio(accountSid, authToken);
  await client.messages.create({ body, to, from });

  console.log("[AdminAlert] SMS sent:", { to, prefix });
}
