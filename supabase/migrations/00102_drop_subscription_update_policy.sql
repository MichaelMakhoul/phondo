-- Remove the overly permissive RLS UPDATE policy on subscriptions.
-- The policy allowed org admins to update ANY column, including plan_type,
-- calls_limit, status, and trial_end — enabling privilege escalation from
-- the browser Supabase SDK.
--
-- All legitimate subscription mutations happen server-side via service_role
-- (Stripe webhooks, API routes, billing-service.ts), so no client-side
-- UPDATE policy is needed.
DROP POLICY IF EXISTS "Org admins can update subscription" ON subscriptions;
