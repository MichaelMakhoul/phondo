export type TranscriptRole = "user" | "assistant";

export interface TranscriptTurn {
  role: TranscriptRole;
  text: string;
  original?: string;
  language?: string;
}

export interface CleanedTranscript {
  turns: TranscriptTurn[]; // non-empty when present (writer drops to null otherwise)
}

/**
 * Runtime guard for `cleaned_transcript` JSONB rows. Drops malformed turns
 * silently and returns null if the entire structure is unusable. Use at every
 * DB→app boundary so the dashboard never crashes on a bad row.
 */
export function parseCleanedTranscript(value: unknown): CleanedTranscript | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.turns)) return null;

  const turns: TranscriptTurn[] = [];
  for (const t of obj.turns) {
    if (!t || typeof t !== "object") continue;
    const turn = t as Record<string, unknown>;
    if (turn.role !== "user" && turn.role !== "assistant") continue;
    if (typeof turn.text !== "string") continue;
    turns.push({
      role: turn.role,
      text: turn.text,
      original: typeof turn.original === "string" ? turn.original : undefined,
      language: typeof turn.language === "string" ? turn.language : undefined,
    });
  }

  return turns.length > 0 ? { turns } : null;
}
