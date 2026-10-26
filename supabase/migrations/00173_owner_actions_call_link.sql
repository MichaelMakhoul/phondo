-- SCRUM-599: the owner's assistant can block out time and mark callbacks done.
-- The owner's recap email lists what each assistant call changed, built from the
-- records rather than the AI's words. Bookings are linked through
-- appointment_events.call_id; these two columns do the same for diary blocks and
-- for callbacks the assistant marked done.
--
-- Additive and nullable. No policy changes: both tables keep their existing RLS,
-- and only the service role writes these columns.

ALTER TABLE public.blocked_times
  ADD COLUMN IF NOT EXISTS created_on_call_id uuid REFERENCES public.calls(id) ON DELETE SET NULL;

ALTER TABLE public.callback_requests
  ADD COLUMN IF NOT EXISTS completed_on_call_id uuid REFERENCES public.calls(id) ON DELETE SET NULL;

-- The recap looks a call's changes up by these.
CREATE INDEX IF NOT EXISTS idx_blocked_times_created_on_call
  ON public.blocked_times (created_on_call_id)
  WHERE created_on_call_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_callback_requests_completed_on_call
  ON public.callback_requests (completed_on_call_id)
  WHERE completed_on_call_id IS NOT NULL;
