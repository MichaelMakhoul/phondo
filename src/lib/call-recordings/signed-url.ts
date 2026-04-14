import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";

const BUCKET = "call-recordings";
const DEFAULT_EXPIRY_SECONDS = 60 * 10; // 10 minutes — enough for page load + playback

export async function createRecordingSignedUrl(
  storagePath: string,
  expiresIn: number = DEFAULT_EXPIRY_SECONDS,
): Promise<string | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, expiresIn);
  if (error || !data?.signedUrl) {
    console.error("[CallRecordings] createSignedUrl failed:", { storagePath, error });
    Sentry.withScope((scope) => {
      scope.setTag("service", "call-recordings");
      scope.setExtras({ storagePath });
      if (error) {
        Sentry.captureException(error);
      } else {
        Sentry.captureMessage("createSignedUrl returned no signedUrl", "error");
      }
    });
    return null;
  }
  return data.signedUrl;
}
