import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createRecordingSignedUrl } from "@/lib/call-recordings/signed-url";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });

  // RLS on `calls` filters by organization_id via org_members, so this
  // single query simultaneously authorises and fetches.
  const { data: call, error } = await (supabase as any)
    .from("calls")
    .select("id, recording_storage_path")
    .eq("id", id)
    .maybeSingle();

  if (error) return new NextResponse("db error", { status: 500 });
  if (!call) return new NextResponse("not found", { status: 404 });
  if (!call.recording_storage_path) {
    return NextResponse.json({ url: null });
  }

  const url = await createRecordingSignedUrl(call.recording_storage_path);
  if (!url) return new NextResponse("sign failed", { status: 500 });

  return NextResponse.json({ url, expiresIn: 600 });
}
