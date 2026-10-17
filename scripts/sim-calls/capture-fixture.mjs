#!/usr/bin/env node
/**
 * SCRUM-594 simulated calls: capture a business's setup (READ-ONLY) as the
 * fixture the simulator seeds its in-memory diary from.
 *
 *   node scripts/sim-calls/capture-fixture.mjs <organization-id> <out.json>
 *
 * Uses voice-server/.env's Supabase credentials (or SIM_ENV_FILE's) and only ever SELECTs. Contact
 * details (forwarding and transfer numbers, emails, billing ids) are replaced
 * or dropped; integration secrets are never selected. Keep the output out of
 * git anyway: it holds the business's prompt.
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const voiceDir = path.resolve(here, "../../voice-server");
const require = createRequire(path.join(voiceDir, "server.js"));
const { createClient } = require("@supabase/supabase-js");

const [orgId, out] = process.argv.slice(2);
if (!orgId || !out) {
  console.error("usage: node scripts/sim-calls/capture-fixture.mjs <organization-id> <out.json>");
  process.exit(2);
}

// SIM_ENV_FILE: another checkout's voice-server/.env (a git worktree has none of its own).
const env = Object.fromEntries(
  fs.readFileSync(process.env.SIM_ENV_FILE || path.join(voiceDir, ".env"), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
);
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const FAKE_FORWARD = "+61400000099";
const FAKE_TRANSFER = "+61400000098";

/** A copy of `row` without `keys`. */
function omit(row, keys) {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
}

async function rows(table, select, filter) {
  const { data, error } = await filter(supabase.from(table).select(select));
  if (error) throw new Error(`${table}: ${error.message}`);
  return data || [];
}

const organizations = (await rows("organizations", "*", (q) => q.eq("id", orgId))).map((o) =>
  omit(o, ["stripe_customer_id", "business_email", "business_phone", "sms_sender"]),
);
if (organizations.length !== 1) throw new Error(`organization ${orgId} not found`);

const fixture = {
  organizations,
  assistants: await rows("assistants", "*", (q) => q.eq("organization_id", orgId)),
  phone_numbers: (await rows("phone_numbers", "*", (q) => q.eq("organization_id", orgId).eq("is_active", true).eq("ai_enabled", true))).map((p) => ({
    ...omit(p, ["twilio_sid", "telnyx_connection_id"]),
    user_phone_number: p.user_phone_number ? FAKE_FORWARD : null,
    fallback_forward_number: p.fallback_forward_number ? FAKE_FORWARD : null,
  })),
  transfer_rules: (await rows("transfer_rules", "*", (q) => q.eq("organization_id", orgId))).map((t) => ({
    ...t,
    transfer_to_phone: t.transfer_to_phone ? FAKE_TRANSFER : null,
    destinations: Array.isArray(t.destinations) ? t.destinations.map((d) => ({ ...d, phone: FAKE_TRANSFER, phone_number: FAKE_TRANSFER })) : t.destinations,
  })),
  knowledge_bases: await rows("knowledge_bases", "*", (q) => q.eq("organization_id", orgId).eq("is_active", true)),
  calendar_integrations: await rows("calendar_integrations", "id, organization_id, provider, is_active", (q) => q.eq("organization_id", orgId)),
  service_types: await rows("service_types", "*", (q) => q.eq("organization_id", orgId)),
  practitioners: await rows("practitioners", "*", (q) => q.eq("organization_id", orgId)),
  blocked_times: await rows("blocked_times", "*", (q) => q.eq("organization_id", orgId).gte("end_time", new Date().toISOString())),
};
const practitionerIds = fixture.practitioners.map((p) => p.id);
fixture.practitioner_services = practitionerIds.length > 0 ? await rows("practitioner_services", "*", (q) => q.in("practitioner_id", practitionerIds)) : [];
if (fixture.phone_numbers.length !== 1) throw new Error(`expected one active AI phone number, found ${fixture.phone_numbers.length}`);

fs.writeFileSync(out, JSON.stringify(fixture, null, 1));
console.log(`wrote ${out}:`, Object.fromEntries(Object.entries(fixture).map(([k, v]) => [k, v.length])));
