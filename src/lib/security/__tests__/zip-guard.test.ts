import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { totalDeclaredUncompressedSize } from "../zip-guard";

// SCRUM-446: the DOCX parse-bomb guard must report what a zip's central
// directory DECLARES without inflating anything. JSZip (the same reader
// mammoth uses) generates the fixtures, so the parser is validated against
// real archives rather than our own writer.

const CDFH_SIGNATURE = Buffer.from([0x50, 0x4b, 0x01, 0x02]); // "PK\x01\x02"

async function makeZip(
  files: Record<string, string>,
  options: { comment?: string } = {},
): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    comment: options.comment,
  });
}

describe("totalDeclaredUncompressedSize", () => {
  it("sums the declared sizes of all entries", async () => {
    const buf = await makeZip({
      "word/document.xml": "a".repeat(1000),
      "word/styles.xml": "b".repeat(234),
    });
    expect(totalDeclaredUncompressedSize(buf)).toBe(1234);
  });

  it("reports the full declared size of a highly-compressed archive (the bomb shape)", async () => {
    // 11MB of zeros deflates to a few KB — exactly how a bomb slips past a
    // compressed-size cap.
    const declared = 11 * 1024 * 1024;
    const buf = await makeZip({ "word/document.xml": "0".repeat(declared) });
    expect(buf.length).toBeLessThan(64 * 1024); // sanity: the archive itself is tiny
    expect(totalDeclaredUncompressedSize(buf)).toBe(declared);
  });

  it("still finds the central directory behind a trailing archive comment", async () => {
    const buf = await makeZip(
      { "word/document.xml": "x".repeat(500) },
      { comment: "innocuous-looking comment" },
    );
    expect(totalDeclaredUncompressedSize(buf)).toBe(500);
  });

  it("is not fooled by data prepended to the archive (JSZip tolerates it)", async () => {
    const zip = await makeZip({ "word/document.xml": "y".repeat(750) });
    const buf = Buffer.concat([Buffer.from("JUNK".repeat(100)), zip]);
    expect(totalDeclaredUncompressedSize(buf)).toBe(750);
  });

  it("returns Infinity for a ZIP64 size marker (entry declares >= 4GB)", async () => {
    const buf = await makeZip({ "word/document.xml": "z".repeat(100) });
    // Patch the single entry's uncompressed-size field (offset 24 in the
    // central directory file header) to the ZIP64 escape value.
    const cdfhPos = buf.lastIndexOf(CDFH_SIGNATURE);
    expect(cdfhPos).toBeGreaterThan(-1);
    buf.writeUInt32LE(0xffffffff, cdfhPos + 24);
    expect(totalDeclaredUncompressedSize(buf)).toBe(Infinity);
  });

  it("returns null for a buffer that is not a zip", () => {
    expect(totalDeclaredUncompressedSize(Buffer.from("%PDF-1.4 not a zip"))).toBeNull();
    expect(totalDeclaredUncompressedSize(Buffer.alloc(0))).toBeNull();
    expect(totalDeclaredUncompressedSize(Buffer.alloc(1024, 0xab))).toBeNull();
  });

  it("returns null when the declared central directory is corrupted", async () => {
    const buf = await makeZip({ "word/document.xml": "q".repeat(100) });
    // Stomp the central directory header signature so neither the physical
    // (eocd - size) nor the declared offset yields a readable directory.
    const cdfhPos = buf.lastIndexOf(CDFH_SIGNATURE);
    buf.writeUInt32LE(0xdeadbeef, cdfhPos);
    expect(totalDeclaredUncompressedSize(buf)).toBeNull();
  });

  it("returns 0 for an empty archive", async () => {
    const buf = await makeZip({});
    expect(totalDeclaredUncompressedSize(buf)).toBe(0);
  });
});
