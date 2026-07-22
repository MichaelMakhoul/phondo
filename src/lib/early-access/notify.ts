/**
 * Emails the founder when a new early-access request comes in.
 *
 * Best-effort by contract: the lead is already persisted before this runs, so
 * a delivery failure must NOT fail the request — the caller logs and moves on.
 * Reuses the same Resend client + EMAIL_API_KEY/EMAIL_FROM as admin-alerts.
 */
import { Resend } from "resend";
import { escapeHtml } from "@/lib/security/validation";
import type { EarlyAccessData } from "./validate";

/** Thrown on a real send failure so the route can log it (lead is already saved). */
export class EarlyAccessNotifyError extends Error {}

function recipient(): string | null {
  return process.env.EARLY_ACCESS_NOTIFY_EMAIL || process.env.ADMIN_ALERT_EMAIL || null;
}

export async function sendEarlyAccessNotification(data: EarlyAccessData): Promise<void> {
  const apiKey = process.env.EMAIL_API_KEY;
  const to = recipient();

  // No key or no recipient configured -> nothing we can do; the row is still
  // saved. Warn loudly so this is fixable, but don't throw (not the lead's fault).
  if (!apiKey) {
    console.warn("[EarlyAccess] EMAIL_API_KEY not set — new lead saved but no email sent:", data.email);
    return;
  }
  if (!to) {
    console.warn("[EarlyAccess] No EARLY_ACCESS_NOTIFY_EMAIL/ADMIN_ALERT_EMAIL — lead saved but no email sent:", data.email);
    return;
  }

  const fromEmail = process.env.EMAIL_FROM || "notifications@phondo.ai";

  const rows: Array<[string, string | null]> = [
    ["Name", data.full_name],
    ["Business", data.business_name],
    ["Email", data.email],
    ["Phone", data.phone],
    ["Message", data.message],
  ];
  const html = `<h2>New early-access request</h2><table cellpadding="6" style="border-collapse:collapse">${rows
    .filter(([, v]) => v)
    .map(
      ([label, v]) =>
        `<tr><td style="font-weight:600;vertical-align:top">${label}</td><td>${escapeHtml(String(v))}</td></tr>`,
    )
    .join("")}</table><p style="color:#64748b;font-size:12px">Sent from the Phondo private-beta signup page.</p>`;

  const text = rows
    .filter(([, v]) => v)
    .map(([label, v]) => `${label}: ${v}`)
    .join("\n");

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: fromEmail,
    to: [to],
    replyTo: data.email, // reply goes straight to the prospect
    subject: `Early access: ${data.full_name}${data.business_name ? ` (${data.business_name})` : ""}`,
    html,
    text,
  });

  if (error) {
    throw new EarlyAccessNotifyError(typeof error === "string" ? error : JSON.stringify(error));
  }
}
