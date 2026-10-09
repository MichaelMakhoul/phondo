import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, type ServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import { getPrimaryMembership } from "@/lib/auth/membership";
import { rateLimitDistributed } from "@/lib/security/rate-limiter";
import { getOrgCountry, validatePhone } from "@/lib/phone/validate-for-org";
import { isOwnerAssistantUiEnabled } from "@/lib/feature-flags";
import { PIN_REGEX, isWeakPin } from "@/lib/owner-assistant/pin-rules";
import { generatePinSalt, hashPin } from "@/lib/owner-assistant/pin";

/**
 * Owner assistant line (SCRUM-585, spec §6): the registered mobile + PIN that
 * lets the business owner ring their own Phondo number and reach the owner
 * assistant. One row per org in `owner_access` (migration 00171).
 *
 * Owner role only — not admin: the PIN authorises reading and changing every
 * booking by voice. The PIN is scrypt-hashed here with a per-row salt and
 * never selected, returned or logged; the voice server verifies it on the call.
 */

/** The only columns this route ever selects. pin_hash / pin_salt stay in the DB. */
const PUBLIC_COLUMNS = "id, phone_e164, pin_length, enabled, last_verified_at, updated_at";

const PIN_ERROR = "PIN must be 4 to 8 digits.";
const WEAK_PIN_ERROR = "Choose a PIN that's harder to guess — avoid repeats, runs like 1234, and common PINs.";

const putSchema = z.object({
  phone: z.string().trim().min(1).max(32).optional(),
  pin: z.string().regex(PIN_REGEX, PIN_ERROR).optional(),
  enabled: z.boolean().optional(),
});

interface OwnerAccessRow {
  id: string;
  phone_e164: string;
  pin_length: number;
  enabled: boolean;
  last_verified_at: string | null;
  updated_at: string;
}

interface AuthedOwner {
  organizationId: string;
  userId: string;
  /** The user-bound client, reused for the org-country lookup. */
  supabase: Awaited<ReturnType<typeof createClient>>;
}

function toApi(row: OwnerAccessRow) {
  return {
    configured: true as const,
    phoneE164: row.phone_e164,
    pinLength: row.pin_length,
    enabled: row.enabled,
    lastVerifiedAt: row.last_verified_at,
    updatedAt: row.updated_at,
  };
}

/** 404 while the feature is dark; 401 / 404 / 403 for anyone but the org owner. */
async function requireOwner(): Promise<AuthedOwner | NextResponse> {
  if (!isOwnerAssistantUiEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const membership = await getPrimaryMembership(supabase, user.id);
  if (!membership) {
    return NextResponse.json({ error: "No organization found" }, { status: 404 });
  }
  if (membership.role !== "owner") {
    return NextResponse.json(
      { error: "Only the business owner can manage the assistant line." },
      { status: 403 }
    );
  }
  return { organizationId: membership.organization_id, userId: user.id, supabase };
}

/**
 * Per-org cap on changes to the line (10/min, shared by PUT and DELETE;
 * fail-open like every "auth" profile). Returns the 429 to send, or null.
 */
async function writeLimitResponse(
  admin: ServiceRoleSupabaseClient,
  organizationId: string
): Promise<NextResponse | null> {
  const limit = await rateLimitDistributed(admin, organizationId, "owner-access", "auth");
  if (limit.allowed) return null;
  return NextResponse.json(
    { error: "Too many changes — try again in a minute." },
    { status: 429, headers: limit.headers }
  );
}

/**
 * Org, code and message only. A Postgres error's `details` holds the failing
 * row (pin_hash and pin_salt included) and must never reach a log.
 */
function logDbError(stage: string, organizationId: string, error: { code?: string; message?: string }) {
  console.error(`[OwnerAccess] ${stage} failed:`, {
    organizationId,
    errorCode: error.code,
    errorMessage: error.message,
  });
}

/** The message only — never the thrown value, and nothing from the request. */
function logUnexpected(verb: string, error: unknown) {
  console.error(`[OwnerAccess] ${verb} failed:`, error instanceof Error ? error.message : "non-Error thrown");
}

// GET /api/v1/owner-access
export async function GET() {
  try {
    const auth = await requireOwner();
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const { data, error } = await (admin as any)
      .from("owner_access")
      .select(PUBLIC_COLUMNS)
      .eq("organization_id", auth.organizationId)
      .maybeSingle();
    if (error) {
      logDbError("load", auth.organizationId, error);
      return NextResponse.json({ error: "Failed to load your assistant line" }, { status: 500 });
    }
    return NextResponse.json(data ? toApi(data as OwnerAccessRow) : { configured: false });
  } catch (error) {
    logUnexpected("GET", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PUT /api/v1/owner-access — create or patch. `pin` omitted ⇒ keep the stored one.
export async function PUT(request: Request) {
  try {
    const auth = await requireOwner();
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const limited = await writeLimitResponse(admin, auth.organizationId);
    if (limited) return limited;

    const parsed = putSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      const pinIssue = parsed.error.issues.some((i) => i.path[0] === "pin");
      return NextResponse.json({ error: pinIssue ? PIN_ERROR : "Invalid request." }, { status: 400 });
    }
    const { phone, pin, enabled } = parsed.data;

    // Tradie mobiles are public and caller ID can be spoofed, so the PIN is the
    // real second factor: refuse the guesses an attacker tries first. After the
    // format check above, before anything is read or written.
    if (pin !== undefined && isWeakPin(pin)) {
      return NextResponse.json({ error: WEAK_PIN_ERROR }, { status: 400 });
    }

    // The first save needs both halves; later patches may send any subset.
    // A read failure must not be mistaken for "no row yet" — surface it.
    const { data: existing, error: existingError } = await (admin as any)
      .from("owner_access")
      .select(PUBLIC_COLUMNS)
      .eq("organization_id", auth.organizationId)
      .maybeSingle();
    if (existingError) {
      logDbError("pre-save read", auth.organizationId, existingError);
      return NextResponse.json({ error: "Failed to save your assistant line" }, { status: 500 });
    }
    if (!existing && (!phone || !pin)) {
      return NextResponse.json(
        { error: "Enter your mobile number and choose a PIN to set up your assistant line." },
        { status: 400 }
      );
    }
    if (existing && phone === undefined && pin === undefined && enabled === undefined) {
      return NextResponse.json(toApi(existing as OwnerAccessRow));
    }

    const changes: Record<string, unknown> = {};

    if (phone !== undefined) {
      const country = await getOrgCountry(auth.organizationId, auth.supabase);
      const result = validatePhone(phone, country, "Mobile number");
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      changes.phone_e164 = result.value;
    }

    if (pin !== undefined) {
      // Fresh salt on every PIN change; the plaintext never leaves this block.
      const salt = generatePinSalt();
      changes.pin_salt = salt;
      changes.pin_hash = hashPin(pin, salt);
      changes.pin_length = pin.length;
    }

    if (enabled !== undefined) changes.enabled = enabled;

    // An existing row is patched with UPDATE, not upserted: Postgres checks
    // NOT NULL on the proposed row before it looks at ON CONFLICT, so upserting
    // just { organization_id, enabled } fails on phone_e164 / pin_hash / pin_salt
    // / pin_length even though the row exists (and the stored hash is never read
    // back to be re-sent). The first save upserts a complete row, so two
    // concurrent first saves converge on the later one instead of one failing.
    const table = (admin as any).from("owner_access");
    const { data, error } = existing
      ? await table
          .update(changes)
          .eq("organization_id", auth.organizationId)
          .select(PUBLIC_COLUMNS)
          .single()
      : await table
          .upsert(
            { organization_id: auth.organizationId, created_by: auth.userId, ...changes },
            { onConflict: "organization_id" }
          )
          .select(PUBLIC_COLUMNS)
          .single();
    if (error) {
      logDbError("save", auth.organizationId, error);
      return NextResponse.json({ error: "Failed to save your assistant line" }, { status: 500 });
    }
    return NextResponse.json(toApi(data as OwnerAccessRow));
  } catch (error) {
    logUnexpected("PUT", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/owner-access — remove the line entirely (idempotent).
export async function DELETE() {
  try {
    const auth = await requireOwner();
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const limited = await writeLimitResponse(admin, auth.organizationId);
    if (limited) return limited;

    const { error } = await (admin as any)
      .from("owner_access")
      .delete()
      .eq("organization_id", auth.organizationId);
    if (error) {
      logDbError("delete", auth.organizationId, error);
      return NextResponse.json({ error: "Failed to remove your assistant line" }, { status: 500 });
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    logUnexpected("DELETE", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
