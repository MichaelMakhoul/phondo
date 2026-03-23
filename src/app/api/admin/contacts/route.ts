import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformAdmin } from "@/lib/admin/admin-auth";

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = await isPlatformAdmin(user.id);
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 500);
  const offset = (page - 1) * limit;

  const adminSupabase = createAdminClient();
  const { data, error, count } = await (adminSupabase as any)
    .from("admin_contacts")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("[Admin Contacts] Failed to fetch contacts:", error);
    return NextResponse.json({ error: "Failed to fetch contacts" }, { status: 500 });
  }

  return NextResponse.json({ contacts: data ?? [], total: count ?? 0, page, limit });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = await isPlatformAdmin(user.id);
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: {
    name?: string;
    email?: string;
    company?: string | null;
    industry?: string | null;
    tags?: string[] | null;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.name?.trim() || !body.email?.trim()) {
    return NextResponse.json({ error: "Name and email are required" }, { status: 400 });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(body.email.trim())) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
  }

  const adminSupabase = createAdminClient();

  // Check email uniqueness
  const { data: existing } = await (adminSupabase as any)
    .from("admin_contacts")
    .select("id")
    .eq("email", body.email.trim())
    .limit(1);

  if (existing && existing.length > 0) {
    return NextResponse.json(
      { error: "A contact with this email already exists" },
      { status: 409 }
    );
  }

  const { data: contact, error } = await (adminSupabase as any)
    .from("admin_contacts")
    .insert({
      name: body.name.trim(),
      email: body.email.trim(),
      company: body.company?.trim() || null,
      industry: body.industry?.trim() || null,
      tags: body.tags || null,
      source: "manual",
    })
    .select()
    .single();

  if (error) {
    console.error("[Admin Contacts] Failed to create contact:", error);
    return NextResponse.json({ error: "Failed to create contact" }, { status: 500 });
  }

  return NextResponse.json({ contact }, { status: 201 });
}
