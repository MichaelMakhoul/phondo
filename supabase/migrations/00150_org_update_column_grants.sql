-- SCRUM-421 (audit finding #8): the "Org admins can update organizations"
-- UPDATE policy has no column restriction, so any org admin could rewrite
-- security/billing-controlled columns (stripe_customer_id, parent_org_id,
-- slug, type) on their own org via PostgREST. With a forged
-- stripe_customer_id, the billing portal route would open a session against
-- someone else's Stripe customer.
--
-- Note on WITH CHECK: for UPDATE policies Postgres implicitly reuses USING as
-- the WITH CHECK when it is omitted, so the NEW row already had to satisfy
-- is_org_admin(). The substantive fix is therefore COLUMN-LEVEL privileges;
-- the explicit WITH CHECK below is documentation, not a behavior change.
--
-- Fix:
--   1. Make the implicit WITH CHECK explicit on the UPDATE policy.
--   2. Replace the blanket UPDATE grant for `authenticated` with a column
--      allowlist covering exactly what the app's user-scoped clients write
--      (settings forms, onboarding, sms_sender backfill). Locked columns —
--      id, slug, type, parent_org_id, stripe_customer_id, created_at,
--      updated_at — become service-role-only (the checkout route's
--      stripe_customer_id write switches to the admin client in the same PR;
--      billing-service already uses it). updated_at is set by trigger, which
--      bypasses column privileges.
--   3. Same allowlist for INSERT (same hole via a different verb — app code
--      only creates orgs through the create_organization_with_owner
--      SECURITY DEFINER RPC, which is unaffected), plus slug/type which the
--      row legitimately needs at creation.
--   4. Strip all write privileges from `anon` — RLS already blocks anon
--      writes (auth.uid() IS NULL), this is defense-in-depth.

-- 1. Explicit WITH CHECK (matches the implicit behavior; documents intent)
ALTER POLICY "Org admins can update organizations" ON public.organizations
  WITH CHECK (is_org_admin(id, (SELECT auth.uid())));

-- 2. Column-level UPDATE allowlist for authenticated
REVOKE UPDATE ON public.organizations FROM authenticated;
GRANT UPDATE (
  name,
  logo_url,
  primary_color,
  industry,
  business_name,
  business_phone,
  business_address,
  business_website,
  business_email,
  business_state,
  timezone,
  business_hours,
  country,
  default_appointment_duration,
  recording_consent_mode,
  recording_disclosure_text,
  appointment_verification_fields,
  send_customer_confirmations,
  sms_sender
) ON public.organizations TO authenticated;

-- 3. Column-level INSERT allowlist for authenticated (slug/type are needed
--    at creation; id/created_at/updated_at come from defaults/triggers;
--    stripe_customer_id and parent_org_id stay service-role-only)
REVOKE INSERT ON public.organizations FROM authenticated;
GRANT INSERT (
  name,
  slug,
  type,
  logo_url,
  primary_color,
  industry,
  business_name,
  business_phone,
  business_address,
  business_website,
  business_email,
  business_state,
  timezone,
  business_hours,
  country,
  default_appointment_duration,
  recording_consent_mode,
  recording_disclosure_text,
  appointment_verification_fields,
  send_customer_confirmations,
  sms_sender
) ON public.organizations TO authenticated;

-- 4. anon has no business writing organizations at all
REVOKE INSERT, UPDATE, DELETE ON public.organizations FROM anon;
