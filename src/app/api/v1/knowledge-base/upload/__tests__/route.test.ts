import { describe, it, expect, vi, beforeEach } from "vitest";
import JSZip from "jszip";
import type { NextRequest } from "next/server";

/**
 * SCRUM-446: parse-bomb hardening for the KB document upload route.
 *
 * mammoth inflates word/document.xml fully in memory before the route's
 * 50k-char truncation runs, so a tiny DOCX declaring multi-GB entries must
 * be rejected from the zip central directory alone — BEFORE mammoth ever
 * sees the buffer.
 */

const mocks = vi.hoisted(() => ({
  extractRawText: vi.fn(async () => ({ value: "extracted docx text" })),
  getText: vi.fn(async () => ({ text: "extracted pdf text" })),
  destroy: vi.fn(async () => {}),
  getPrimaryMembership: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/security/rate-limiter", () => ({
  withRateLimitDistributed: vi.fn(async () => ({ allowed: true, headers: {} })),
}));
vi.mock("@/lib/auth/membership", () => ({
  getPrimaryMembership: mocks.getPrimaryMembership,
  isOrgAdminRole: (role: string) => role === "owner" || role === "admin",
}));
// The route imports both parsers dynamically; vi.mock intercepts those too.
vi.mock("mammoth", () => ({
  extractRawText: mocks.extractRawText,
  default: { extractRawText: mocks.extractRawText },
}));
vi.mock("pdf-parse", () => ({
  PDFParse: class {
    getText = mocks.getText;
    destroy = mocks.destroy;
  },
}));

import { createClient } from "@/lib/supabase/server";
import { POST } from "../route";

function fakeSupabase(user: { id: string } | null = { id: "user-1" }) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  Object.assign(builder, {
    insert: chain,
    select: chain,
    single: async () => ({
      data: { id: "kb-1", title: "Doc", source_type: "document" },
      error: null,
    }),
  });
  return {
    auth: { getUser: async () => ({ data: { user } }) },
    from: () => builder,
  };
}

function makeRequest(content: Buffer | string, name: string, type: string): NextRequest {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  const formData = new FormData();
  formData.append("file", new File([new Uint8Array(bytes)], name, { type }));
  return new Request("http://localhost/api/v1/knowledge-base/upload", {
    method: "POST",
    body: formData,
  }) as unknown as NextRequest;
}

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function makeDocxZip(documentXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("POST /api/v1/knowledge-base/upload (SCRUM-446 parse-bomb guard)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createClient).mockResolvedValue(fakeSupabase() as never);
    mocks.getPrimaryMembership.mockResolvedValue({
      organization_id: "org-1",
      role: "owner",
    });
  });

  it("rejects a zip bomb (tiny archive, >10MB declared) with 400 before mammoth runs", async () => {
    // 11MB of zeros deflates to a few KB — passes the compressed-size cap,
    // must be caught by the declared-uncompressed-size guard.
    const bomb = await makeDocxZip("0".repeat(11 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(64 * 1024); // sanity: the upload itself is tiny

    const res = await POST(makeRequest(bomb, "bomb.docx", DOCX_MIME));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/too large to process/i);
    expect(mocks.extractRawText).not.toHaveBeenCalled();
  });

  it("rejects a ZIP64-marked entry (declares >= 4GB) with 400 before mammoth runs", async () => {
    const buf = await makeDocxZip("z".repeat(100));
    // Patch the entry's uncompressed-size field in the central directory
    // file header ("PK\x01\x02", size at offset 24) to the ZIP64 escape.
    const cdfhPos = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buf.writeUInt32LE(0xffffffff, cdfhPos + 24);

    const res = await POST(makeRequest(buf, "bomb64.docx", DOCX_MIME));
    expect(res.status).toBe(400);
    expect(mocks.extractRawText).not.toHaveBeenCalled();
  });

  it("rejects a zip bomb hidden behind >64KB of trailing junk (whole-buffer EOCD scan)", async () => {
    // Reviewer repro: JSZip scans the WHOLE buffer for the EOCD, so a tiny
    // honest-header bomb plus >65557 bytes of trailing junk used to make the
    // guard return null and fall through to mammoth, which inflated the bomb.
    const bomb = await makeDocxZip("0".repeat(11 * 1024 * 1024));
    const padded = Buffer.concat([bomb, Buffer.alloc(70 * 1024, 0x41)]);

    const res = await POST(makeRequest(padded, "bomb.docx", DOCX_MIME));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/too large to process/i);
    expect(mocks.extractRawText).not.toHaveBeenCalled();
  });

  it("400s a PK-prefixed buffer with no readable central directory (fail closed, mammoth never runs)", async () => {
    // Starts with the DOCX local-header magic so it routes to the zip branch,
    // but contains no EOCD — the guard returns null and the route must NOT
    // fall through to mammoth (JSZip is more permissive than the guard).
    const corrupt = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(512, 0xab),
    ]);

    const res = await POST(makeRequest(corrupt, "corrupt.docx", DOCX_MIME));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/corrupted or unreadable/i);
    expect(mocks.extractRawText).not.toHaveBeenCalled();
  });

  it("still accepts a normal small docx", async () => {
    const docx = await makeDocxZip("<w:document>hello</w:document>");

    const res = await POST(makeRequest(docx, "handbook.docx", DOCX_MIME));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "kb-1" });
    expect(mocks.extractRawText).toHaveBeenCalledTimes(1);
  });

  it("caps PDF parsing to the first 200 pages (MAX_PDF_PAGES)", async () => {
    const res = await POST(
      makeRequest("%PDF-1.4 fake pdf bytes", "doc.pdf", "application/pdf"),
    );
    expect(res.status).toBe(201);
    expect(mocks.getText).toHaveBeenCalledWith({ first: 200 });
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("403s a member-role user before touching any parser (SCRUM-428 gate)", async () => {
    mocks.getPrimaryMembership.mockResolvedValue({
      organization_id: "org-1",
      role: "member",
    });
    const docx = await makeDocxZip("<w:document>hello</w:document>");

    const res = await POST(makeRequest(docx, "handbook.docx", DOCX_MIME));
    expect(res.status).toBe(403);
    expect(mocks.extractRawText).not.toHaveBeenCalled();
  });
});
