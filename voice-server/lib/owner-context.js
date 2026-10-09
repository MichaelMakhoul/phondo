// voice-server/lib/owner-context.js
"use strict";
const { getSupabase } = require("./supabase");

/**
 * The soft exit for a query that errored or threw: warn, then give up the name.
 * Logs the step and the error MESSAGE only, never the error object or any row,
 * so the owner's name and user id cannot reach the logs. A plain miss (no owner
 * row, no profile) is not an error and stays silent.
 * @param {string} step
 * @param {{ message?: string } | null | undefined} err an Error or a PostgREST error object
 * @returns {null}
 */
function failSoft(step, err) {
  console.warn(`[OwnerContext] ${step} failed (non-fatal):`, err && err.message);
  return null;
}

/**
 * SCRUM-587: first name for the owner greeting ("Hi Dave, what do you need?").
 * org_members.user_id references auth.users, which PostgREST can't embed
 * through, so two small queries. Fail-SOFT: any miss or error → null → the
 * greeting says "Hi there". Only runs on a verified owner call.
 * @param {string} organizationId
 * @param {{ supabase?: any }} [deps] - injectable for tests
 * @returns {Promise<string|null>}
 */
async function loadOwnerFirstName(organizationId, deps = {}) {
  try {
    const supabase = deps.supabase || getSupabase();
    const { data: member, error: memberErr } = await supabase
      .from("org_members")
      .select("user_id")
      .eq("organization_id", organizationId)
      .eq("role", "owner")
      .limit(1)
      .maybeSingle();
    if (memberErr) return failSoft("org_members lookup", memberErr);
    if (!member || !member.user_id) return null;
    const { data: profile, error: profileErr } = await supabase
      .from("user_profiles")
      .select("full_name")
      .eq("id", member.user_id)
      .maybeSingle();
    if (profileErr) return failSoft("user_profiles lookup", profileErr);
    if (!profile || typeof profile.full_name !== "string") return null;
    const first = profile.full_name.trim().split(/\s+/)[0];
    return first ? first.slice(0, 40) : null;
  } catch (err) {
    return failSoft("loadOwnerFirstName", err);
  }
}

module.exports = { loadOwnerFirstName };
