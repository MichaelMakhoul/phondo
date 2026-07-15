-- SCRUM-550: post-call re-transcription keeps both transcripts.
-- raw_transcript preserves Gemini's original when `transcript` is overwritten
-- by the accurate Deepgram version; transcript_source marks which pipeline
-- produced `transcript` (NULL == legacy Gemini) and is the idempotency guard.
alter table calls add column if not exists raw_transcript text;
alter table calls add column if not exists transcript_source text;
comment on column calls.raw_transcript is 'Gemini original transcript, preserved when transcript is replaced by Deepgram re-transcription (SCRUM-550)';
comment on column calls.transcript_source is 'Which pipeline produced calls.transcript: deepgram | gemini | NULL(=legacy gemini) (SCRUM-550)';
