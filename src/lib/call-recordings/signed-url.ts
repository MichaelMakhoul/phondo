// src/lib/call-recordings/signed-url.ts
import { createClient } from "@supabase/supabase-js";

const BUCKET = "call-recordings";
const DEFAULT_EXPIRY_SECONDS = 60 * 10; // 10 minutes — enough for page load + playback

export async function createRecordingSignedUrl(
  storagePath: string,
  expiresIn: number = DEFAULT_EXPIRY_SECONDS,
): Promise<string | null> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, expiresIn);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}
