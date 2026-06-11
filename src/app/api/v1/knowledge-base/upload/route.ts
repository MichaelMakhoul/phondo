import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPrimaryMembership, isOrgAdminRole } from "@/lib/auth/membership";
import { withRateLimitDistributed } from "@/lib/security/rate-limiter";
import { createAdminClient } from "@/lib/supabase/admin";
import { totalDeclaredUncompressedSize } from "@/lib/security/zip-guard";

// NOTE (SCRUM-446): Vercel's request-body cap (~4.5MB on serverless) rejects
// oversized uploads BEFORE this handler runs, so the platform is currently
// the outer bound and this check is the in-route contract. Moving off Vercel
// removes that outer bound — revisit this limit deliberately if we do.
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_TEXT_LENGTH = 50_000;

/**
 * SCRUM-446: zip parse-bomb guard. mammoth (via JSZip) inflates
 * word/document.xml fully in memory BEFORE our MAX_TEXT_LENGTH truncation —
 * a few-KB DOCX declaring multi-GB entries would OOM the function. We read
 * the zip central directory (cheap, nothing is inflated) and reject archives
 * whose declared uncompressed total exceeds this bound. 10MB of OOXML markup
 * is far more than enough to yield 50k chars of extracted text.
 */
const MAX_DECLARED_UNCOMPRESSED_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * SCRUM-446: PDF analogue — a small PDF can declare tens of thousands of
 * (near-empty or object-reusing) pages; cap how many pdf-parse extracts text
 * from. (The cap bounds extraction work, not page iteration — pdf-parse
 * still walks the page tree.) 200 pages of normal text already lands well
 * past MAX_TEXT_LENGTH, so the cap doesn't cost legitimate documents
 * anything after truncation.
 */
const MAX_PDF_PAGES = 200;

/**
 * SCRUM-428 (finding #34): route by the file's MAGIC BYTES, not the
 * client-controlled MIME type / extension. PDFs start with "%PDF-"; DOCX is
 * an OOXML zip ("PK\x03\x04"). A mislabeled payload goes to the parser its
 * BYTES say it is — or is rejected — never the parser its name claims.
 */
function sniffFileKind(buffer: Buffer): "pdf" | "docx-zip" | "unknown" {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
    return "pdf";
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04
  ) {
    return "docx-zip";
  }
  return "unknown";
}

// POST /api/v1/knowledge-base/upload — upload a PDF or DOCX file
export async function POST(request: NextRequest) {
  try {
    // SCRUM-428 (finding #34): parsing PDFs/DOCX is CPU-heavy — bound per IP
    // with the DISTRIBUTED limiter (per-instance memory is reset by cold
    // starts and multiplied by lambda concurrency).
    const rl = await withRateLimitDistributed(
      createAdminClient(),
      request,
      "/api/v1/knowledge-base/upload",
      "expensive",
    );
    if (!rl.allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: rl.headers });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const membership = await getPrimaryMembership(supabase as any, user.id);

    if (!membership) {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }

    // Same gate as the other KB write routes (finding #35).
    if (!isOrgAdminRole(membership.role)) {
      return NextResponse.json(
        { error: "Only organization owners and admins can edit the knowledge base" },
        { status: 403 }
      );
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    // Cap to match createKBSchema's 200-char title (finding #36 — an
    // unbounded form field stored verbatim defeats the content cap).
    const title = ((formData.get("title") as string) || "").slice(0, 200);

    if (!file) {
      return NextResponse.json({ error: "File is required" }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: "File too large. Maximum size is 10MB." },
        { status: 400 }
      );
    }

    const fileType = file.type;
    const fileName = file.name;
    let extractedText = "";

    // Buffer once (size already bounded above), then dispatch on the bytes.
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > MAX_FILE_SIZE) {
      // Defense-in-depth: file.size is normally accurate, but the buffer is
      // the ground truth.
      return NextResponse.json(
        { error: "File too large. Maximum size is 10MB." },
        { status: 400 }
      );
    }

    const kind = sniffFileKind(buffer);
    if (kind === "pdf") {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        // Page cap (SCRUM-446) — see MAX_PDF_PAGES. Note `first` bounds which
        // pages get TEXT-EXTRACTED, not page iteration — pdf-parse still
        // walks the document's page tree. Extra pages would be dropped by
        // the MAX_TEXT_LENGTH truncation anyway.
        const textResult = await parser.getText({ first: MAX_PDF_PAGES });
        extractedText = textResult.text;
      } finally {
        // Release the worker even when getText() throws on a malformed PDF;
        // swallow destroy() errors so they can't mask the parse error.
        await parser.destroy().catch(() => {});
      }
    } else if (kind === "docx-zip") {
      // Parse-bomb check (SCRUM-446) — see MAX_DECLARED_UNCOMPRESSED_SIZE.
      // `null` means WE could not locate the central directory — but JSZip
      // (inside mammoth) is more permissive than our parser and may still
      // find one and inflate the entries. FAIL CLOSED: never hand a zip we
      // can't account for to mammoth.
      const declaredSize = totalDeclaredUncompressedSize(buffer);
      if (declaredSize === null) {
        return NextResponse.json(
          { error: "This file appears corrupted or unreadable. Please upload a valid DOCX file." },
          { status: 400 }
        );
      }
      if (declaredSize > MAX_DECLARED_UNCOMPRESSED_SIZE) {
        return NextResponse.json(
          { error: "Document content is too large to process. Please upload a smaller file." },
          { status: 400 }
        );
      }
      // A zip that isn't a real DOCX makes mammoth throw — caught below and
      // returned as the generic invalid-file message.
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      extractedText = result.value;
    } else {
      return NextResponse.json(
        { error: "Unsupported file type. Please upload a PDF or DOCX file." },
        { status: 400 }
      );
    }

    if (!extractedText.trim()) {
      return NextResponse.json(
        { error: "Could not extract text from file." },
        { status: 400 }
      );
    }

    // Truncate to max length
    let truncated = false;
    let originalLength = extractedText.length;
    if (extractedText.length > MAX_TEXT_LENGTH) {
      truncated = true;
      extractedText = extractedText.slice(0, MAX_TEXT_LENGTH);
    }

    const entryTitle = title || fileName.replace(/\.[^.]+$/, "");

    const { data: entry, error } = await (supabase as any)
      .from("knowledge_bases")
      .insert({
        organization_id: membership.organization_id,
        assistant_id: null,
        title: entryTitle,
        source_type: "document",
        content: extractedText,
        metadata: {
          // Client-controlled strings — cap before storing.
          fileName: fileName.slice(0, 255),
          fileSize: file.size,
          fileType: fileType.slice(0, 255),
        },
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      console.error("Failed to save uploaded KB entry:", error);
      return NextResponse.json(
        { error: "Failed to save uploaded document" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ...entry,
      ...(truncated && {
        warning: `Document was truncated from ${originalLength} to ${MAX_TEXT_LENGTH} characters. Consider splitting into multiple documents.`,
      }),
    }, { status: 201 });
  } catch (error) {
    console.error("Error uploading file:", error);
    const message = error instanceof Error ? error.message : "";
    if (message.includes("password") || message.includes("encrypted")) {
      return NextResponse.json(
        { error: "This file appears to be password-protected. Please upload an unprotected version." },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to process file. Please ensure the file is a valid PDF or DOCX." },
      { status: 500 }
    );
  }
}
