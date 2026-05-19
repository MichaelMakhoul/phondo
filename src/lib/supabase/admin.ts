import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Brand symbol marking a Supabase client constructed with the
 * service-role key. The brand is a phantom type — it exists only
 * at compile time and adds no runtime overhead.
 *
 * Code paths that MUST use service-role (e.g. the rate-limiter's
 * `check_rate_limit_bucket` RPC, which was REVOKE'd from
 * `authenticated` in migration 00136) accept this branded type
 * instead of `SupabaseClient<Database>`. A user-bound cookie client
 * cannot satisfy the brand, so a code reviewer no longer has to
 * scan every call site to confirm the right client was passed —
 * the typechecker enforces it.
 */
declare const __serviceRole: unique symbol;

/**
 * A Supabase client backed by the service-role JWT. Returned by
 * `createAdminClient()` and accepted by functions that bypass RLS
 * (rate-limiter RPC calls, cleanup crons, internal helpers).
 *
 * SCRUM-298: previously these functions accepted plain
 * `SupabaseClient<Database>`, and "this is a service-role client"
 * was enforced by docstring + code review. Now it's compile-time.
 */
export type ServiceRoleSupabaseClient = SupabaseClient<Database> & {
  readonly [__serviceRole]: true;
};

/**
 * Construct a service-role-keyed Supabase client.
 *
 * The brand is applied here via cast — runtime returns a regular
 * `SupabaseClient<Database>`. The cast is the ONLY safe place to
 * mint a branded value; callers that need to thread the brand
 * (e.g. tests) should receive an already-branded client rather
 * than re-cast.
 */
export function createAdminClient(): ServiceRoleSupabaseClient {
  const client = createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
  // The cast here is the brand-introduction point. Once stamped,
  // the typechecker propagates the brand through every variable.
  return client as ServiceRoleSupabaseClient;
}
