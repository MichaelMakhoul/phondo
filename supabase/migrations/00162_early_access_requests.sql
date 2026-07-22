-- Early-access / demo requests captured from the private-beta signup page
-- ("Request early access") and any future lead surface. The button used to be
-- a mailto: link that silently did nothing for most visitors; it now posts to
-- /api/v1/early-access, which writes here via the service-role admin client.
--
-- These rows are PLATFORM-level leads holding caller PII (name, email, phone),
-- NOT tied to any customer organization — so, unlike callback_requests, there
-- is deliberately NO org-scoped read policy. RLS is on with a service-role
-- insert policy only: the founder reads leads via the notification email and
-- the Supabase dashboard (service role), never any customer.
create table if not exists early_access_requests (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  full_name     text not null,
  business_name text,
  email         text not null,
  phone         text,
  message       text,
  source        text not null default 'signup_page',
  status        text not null default 'new'
);

alter table early_access_requests enable row level security;

-- Only the service role (the public API route's admin client) may insert.
-- No select/update/delete policies -> no anon or authenticated access at all.
create policy "Service role can insert early access requests"
  on early_access_requests
  for insert
  with check ((select auth.role()) = 'service_role');

comment on table early_access_requests is
  'Early-access/demo requests from the private-beta signup page and future lead surfaces. Platform-level PII; service-role writes only, no org-scoped read policy by design (SCRUM early-access capture).';
comment on column early_access_requests.source is
  'Where the lead came from: signup_page | phone | other';
comment on column early_access_requests.status is
  'Lead pipeline: new | contacted | converted | archived';

create index if not exists early_access_requests_created_at_idx
  on early_access_requests (created_at desc);
create index if not exists early_access_requests_status_idx
  on early_access_requests (status);
