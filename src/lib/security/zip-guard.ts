/**
 * SCRUM-446: zip "parse bomb" guard for DOCX uploads.
 *
 * mammoth (via JSZip) inflates word/document.xml FULLY in memory before any
 * of our text truncation runs — a few-KB zip declaring multi-GB entries (a
 * classic zip bomb) can OOM the function. The zip central directory records
 * each entry's uncompressed size WITHOUT inflating anything, so we read it
 * ourselves and let the caller reject oversized archives up front. (JSZip is
 * in the tree via mammoth, but its public API doesn't expose the declared
 * sizes — they only live on the internal `_data` object — so we parse the
 * directory directly. Format reference: PKWARE APPNOTE.TXT; all multi-byte
 * fields are little-endian.)
 */

// End of Central Directory record: "PK\x05\x06". 22 fixed bytes plus a
// variable-length comment (max 65535), so it lives in the last ~64KB.
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_LENGTH = 0xffff;

// Central directory file header: "PK\x01\x02". 46 fixed bytes plus three
// variable-length fields (file name, extra field, comment).
const CDFH_SIGNATURE = 0x02014b50;
const CDFH_MIN_SIZE = 46;

// A 32-bit field of 0xFFFFFFFF means "see the ZIP64 extra field" — the real
// value is >= 4GB (or the archive is pathological). No legitimate sub-10MB
// DOCX needs ZIP64, so callers treat Infinity as over any sane bound.
const ZIP64_MARKER = 0xffffffff;

/**
 * Sum of the uncompressed sizes every entry DECLARES in the zip central
 * directory.
 *
 * Returns:
 * - the declared total in bytes for a readable central directory;
 * - `Infinity` when any size field carries the ZIP64 marker (>= 4GB);
 * - `null` when no central directory can be located (not a zip / truncated /
 *   corrupted) — callers should fall through to the real parser, whose own
 *   error handling already covers malformed files.
 *
 * Note: declared sizes are attacker-controlled metadata. This blocks the
 * standard bomb construction (honest headers, huge compression ratio); it is
 * a cheap pre-filter, not a substitute for the upstream request-size cap.
 */
export function totalDeclaredUncompressedSize(buffer: Buffer): number | null {
  // Locate the EOCD by scanning backwards across the comment region.
  let eocdPos = -1;
  const scanFloor = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT_LENGTH);
  for (let pos = buffer.length - EOCD_MIN_SIZE; pos >= scanFloor; pos--) {
    if (buffer.readUInt32LE(pos) === EOCD_SIGNATURE) {
      eocdPos = pos;
      break;
    }
  }
  if (eocdPos === -1) return null;

  const cdSize = buffer.readUInt32LE(eocdPos + 12);
  const cdOffset = buffer.readUInt32LE(eocdPos + 16);
  if (cdSize === ZIP64_MARKER || cdOffset === ZIP64_MARKER) return Infinity;
  if (cdSize > eocdPos) return null; // directory can't be larger than what precedes the EOCD

  // The directory physically ends where the EOCD begins, so its real start is
  // `eocdPos - cdSize` even when data was prepended to the archive (JSZip
  // tolerates that, shifting all offsets — mirror it or a bomb could hide
  // behind a junk prefix). Fall back to the declared offset for exotic but
  // valid layouts.
  let cdStart = eocdPos - cdSize;
  if (cdSize >= 4 && buffer.readUInt32LE(cdStart) !== CDFH_SIGNATURE) {
    if (cdOffset + cdSize <= eocdPos && buffer.readUInt32LE(cdOffset) === CDFH_SIGNATURE) {
      cdStart = cdOffset;
    } else {
      return null;
    }
  }

  const cdEnd = cdStart + cdSize;
  let total = 0;
  let pos = cdStart;
  while (pos < cdEnd) {
    if (pos + CDFH_MIN_SIZE > cdEnd) return null;
    if (buffer.readUInt32LE(pos) !== CDFH_SIGNATURE) return null;

    const uncompressedSize = buffer.readUInt32LE(pos + 24);
    if (uncompressedSize === ZIP64_MARKER) return Infinity;
    total += uncompressedSize;

    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    pos += CDFH_MIN_SIZE + nameLength + extraLength + commentLength;
  }
  return total;
}
