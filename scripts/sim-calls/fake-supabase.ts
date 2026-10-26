/**
 * SCRUM-594 simulated calls: a stateful, in-memory stand-in for the Supabase
 * client, shared by BOTH sides of a simulated call — the voice server's
 * `getSupabase()` (call context, schedule snapshot, returning-caller counts)
 * and the Next.js `createAdminClient()` behind the real calendar tool
 * handlers. One store, so a booking the handler writes is what the next
 * snapshot reads, exactly as in production.
 *
 * It implements the PostgREST query surface those code paths use, with
 * Postgres semantics where they matter (timestamptz compares as instants,
 * `= NULL` matches nothing, ASC sorts NULLS LAST, `.single()` errors on 0 or
 * many rows), plus the two appointment constraints the handlers rely on:
 * `no_overlapping_appointments` (23P01) and the table-wide unique
 * confirmation code (23505). Anything outside that surface THROWS: a gap must
 * fail the run loudly, never quietly return rows production would not.
 */
import crypto from "crypto";

export type Row = Record<string, unknown>;
type PgError = { code: string; message: string; details?: string | null; hint?: string | null };
type Result = { data: unknown; error: PgError | null; count?: number | null; status: number };
type Filter = (row: Row) => boolean;

const ISO_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
/** Columns Postgres stores as timestamptz: returned as `…+00:00`, like PostgREST. */
const TIMESTAMP_COLUMN = /(_at|_time)$/;

/** PostgREST's rendering of a timestamptz: UTC, `+00:00`, milliseconds only when non-zero. */
export function pgTimestamp(value: unknown): unknown {
  if (typeof value !== "string" || !ISO_TS.test(value)) return value;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  return new Date(ms).toISOString().replace(/\.000Z$/, "+00:00").replace(/Z$/, "+00:00");
}

function isTimestamp(v: unknown): v is string {
  return typeof v === "string" && ISO_TS.test(v) && !Number.isNaN(Date.parse(v));
}

/** SQL `=`: NULL equals nothing; timestamps compare as instants. */
function sqlEq(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (isTimestamp(a) && isTimestamp(b)) return Date.parse(a) === Date.parse(b);
  if (typeof a === typeof b) return a === b;
  return String(a) === String(b);
}

/** SQL ordering for range filters and ORDER BY (NULL is handled by the callers). */
function sqlCmp(a: unknown, b: unknown): number {
  if (isTimestamp(a) && isTimestamp(b)) return Date.parse(a) - Date.parse(b);
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** LIKE/ILIKE pattern → anchored RegExp (`%` any run, `_` one char, `\x` literal x). */
function likeRegex(pattern: string, caseInsensitive: boolean): RegExp {
  let src = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      src += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (ch === "%") {
      src += "[\\s\\S]*";
    } else if (ch === "_") {
      src += "[\\s\\S]";
    } else {
      src += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${src}$`, caseInsensitive ? "i" : "");
}

/** Split on commas that are not inside parentheses (PostgREST `or=` / `in.()` syntax). */
function splitTopLevel(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** A PostgREST literal from an `or=` expression: `null`/`true`/`false`, else the raw text. */
function literal(raw: string): unknown {
  if (raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

function listLiteral(raw: string): unknown[] {
  const inner = raw.replace(/^\(/, "").replace(/\)$/, "");
  return splitTopLevel(inner).map((v) => literal(v.replace(/^"|"$/g, "")));
}

/** One `col.op.value` condition (or `col.not.op.value`) from an `or=` expression. */
function conditionFilter(cond: string): Filter {
  const m = /^([a-zA-Z0-9_.]+)\.(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|is|in)\.([\s\S]*)$/.exec(cond);
  if (!m) throw new Error(`fake-supabase: unsupported or() condition ${JSON.stringify(cond)}`);
  const [, col, not, op, raw] = m;
  const f = opFilter(col, op, op === "in" ? listLiteral(raw) : literal(raw));
  return not ? (r) => !f(r) : f;
}

function opFilter(col: string, op: string, value: unknown): Filter {
  const get = (r: Row) => r[col];
  switch (op) {
    case "eq":
      return (r) => sqlEq(get(r), value);
    case "neq":
      return (r) => get(r) !== null && get(r) !== undefined && value !== null && !sqlEq(get(r), value);
    case "gt":
      return (r) => get(r) != null && sqlCmp(get(r), value) > 0;
    case "gte":
      return (r) => get(r) != null && sqlCmp(get(r), value) >= 0;
    case "lt":
      return (r) => get(r) != null && sqlCmp(get(r), value) < 0;
    case "lte":
      return (r) => get(r) != null && sqlCmp(get(r), value) <= 0;
    case "like":
    case "ilike": {
      const re = likeRegex(String(value), op === "ilike");
      return (r) => typeof get(r) === "string" && re.test(get(r) as string);
    }
    case "is":
      if (value === null) return (r) => get(r) === null || get(r) === undefined;
      if (value === true || value === false) return (r) => get(r) === value;
      throw new Error(`fake-supabase: unsupported is.${String(value)}`);
    case "in": {
      const values = Array.isArray(value) ? value : listLiteral(String(value));
      return (r) => values.some((v) => sqlEq(get(r), v));
    }
    default:
      throw new Error(`fake-supabase: unsupported operator ${op}`);
  }
}

/** `a, b, rel!inner(c, d)` → plain columns + embedded relations. */
function parseSelect(cols: string): { columns: string[] | "*"; embeds: Array<{ table: string; inner: boolean; columns: string[] | "*" }> } {
  const parts = splitTopLevel(cols.replace(/\s+/g, " "));
  const columns: string[] = [];
  const embeds: Array<{ table: string; inner: boolean; columns: string[] | "*" }> = [];
  let star = false;
  for (const part of parts) {
    const embed = /^([a-z_]+)(!inner)?\(([^)]*)\)$/.exec(part);
    if (embed) {
      const inner = embed[3].trim();
      embeds.push({ table: embed[1], inner: Boolean(embed[2]), columns: inner === "*" ? "*" : splitTopLevel(inner) });
    } else if (part === "*") {
      star = true;
    } else if (/^[a-z_][a-z0-9_]*$/.test(part)) {
      columns.push(part);
    } else {
      throw new Error(`fake-supabase: unsupported select item ${JSON.stringify(part)}`);
    }
  }
  return { columns: star ? "*" : columns, embeds };
}

function project(row: Row, columns: string[] | "*"): Row {
  if (columns === "*") return { ...row };
  const out: Row = {};
  for (const c of columns) out[c] = row[c] === undefined ? null : row[c];
  return out;
}

/** The foreign key a child table uses for a parent (`practitioners` → `practitioner_id`). */
function foreignKeyFor(parent: string): string {
  return `${parent.replace(/s$/, "")}_id`;
}

/** Postgres overlap test for `tstzrange(start_time, appointment_end(...))`. */
function appointmentRange(r: Row): [number, number] {
  const start = Date.parse(String(r.start_time));
  const end = r.end_time != null ? Date.parse(String(r.end_time)) : start + Number(r.duration_minutes || 30) * 60_000;
  return [start, end];
}

export type WriteEvent = { table: string; op: "insert" | "update" | "delete"; rows: Row[]; at: number };

export class FakeDb {
  private tables = new Map<string, Row[]>();
  /** Every write, in order — the simulated call's audit trail of what the handlers did. */
  readonly writes: WriteEvent[] = [];

  seed(table: string, rows: Row[]): void {
    const list = this.rows(table);
    for (const r of rows) list.push(this.normalize({ ...r }));
  }

  rows(table: string): Row[] {
    let list = this.tables.get(table);
    if (!list) {
      list = [];
      this.tables.set(table, list);
    }
    return list;
  }

  normalize(row: Row): Row {
    for (const [k, v] of Object.entries(row)) {
      if (TIMESTAMP_COLUMN.test(k)) row[k] = pgTimestamp(v);
    }
    return row;
  }

  /** The two appointment constraints the booking handlers depend on. */
  checkAppointmentConstraints(candidate: Row, ignoreId?: unknown): PgError | null {
    const all = this.rows("appointments");
    if (candidate.confirmation_code != null) {
      const clash = all.find((r) => r.id !== ignoreId && r.confirmation_code === candidate.confirmation_code);
      if (clash) {
        return { code: "23505", message: 'duplicate key value violates unique constraint "appointments_confirmation_code_key"' };
      }
    }
    const active = (r: Row) => r.status === "confirmed" || r.status === "pending";
    if (active(candidate) && candidate.start_time != null) {
      const [s, e] = appointmentRange(candidate);
      const overlap = all.find((r) => {
        if (r.id === ignoreId || !active(r) || r.organization_id !== candidate.organization_id) return false;
        // 00149: org-wide for practitioner-less rows; a practitioner's own rows clash with each other.
        const samePool = (r.practitioner_id ?? null) === (candidate.practitioner_id ?? null);
        if (!samePool) return false;
        const [rs, re] = appointmentRange(r);
        return s < re && rs < e;
      });
      if (overlap) {
        return { code: "23P01", message: 'conflicting key value violates exclusion constraint "no_overlapping_appointments"' };
      }
    }
    return null;
  }

  client() {
    return { from: (table: string) => new Query(this, table) };
  }
}

class Query implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private filters: Filter[] = [];
  private embedFilters: Array<{ table: string; filter: Filter }> = [];
  private selectCols: string | null = null;
  private countMode: "exact" | null = null;
  private head = false;
  private orders: Array<{ col: string; asc: boolean; nullsFirst: boolean }> = [];
  private limitN: number | null = null;
  private rangeFrom: number | null = null;
  private payload: Row | Row[] | null = null;
  private returning = false;
  private mode: "many" | "single" | "maybeSingle" = "many";

  constructor(private db: FakeDb, private table: string) {}

  select(cols = "*", opts: { count?: "exact"; head?: boolean } = {}) {
    if (this.op !== "select") {
      this.returning = true;
      this.selectCols = cols;
      return this;
    }
    this.selectCols = cols;
    if (opts.count) this.countMode = opts.count;
    if (opts.head) this.head = true;
    return this;
  }

  insert(values: Row | Row[]) {
    this.op = "insert";
    this.payload = values;
    return this;
  }

  update(values: Row) {
    this.op = "update";
    this.payload = values;
    return this;
  }

  delete() {
    this.op = "delete";
    return this;
  }

  private add(col: string, op: string, value: unknown) {
    const dot = col.indexOf(".");
    if (dot > 0) {
      // A filter on an embedded relation (`practitioner_services.service_type_id`).
      this.embedFilters.push({ table: col.slice(0, dot), filter: opFilter(col.slice(dot + 1), op, value) });
    } else {
      this.filters.push(opFilter(col, op, value));
    }
    return this;
  }

  eq(col: string, value: unknown) { return this.add(col, "eq", value); }
  neq(col: string, value: unknown) { return this.add(col, "neq", value); }
  gt(col: string, value: unknown) { return this.add(col, "gt", value); }
  gte(col: string, value: unknown) { return this.add(col, "gte", value); }
  lt(col: string, value: unknown) { return this.add(col, "lt", value); }
  lte(col: string, value: unknown) { return this.add(col, "lte", value); }
  like(col: string, pattern: string) { return this.add(col, "like", pattern); }
  ilike(col: string, pattern: string) { return this.add(col, "ilike", pattern); }
  is(col: string, value: unknown) { return this.add(col, "is", value); }
  in(col: string, values: unknown[]) { return this.add(col, "in", values); }

  not(col: string, op: string, value: unknown) {
    const f = opFilter(col, op, op === "in" && typeof value === "string" ? listLiteral(value) : value);
    this.filters.push((r) => !f(r));
    return this;
  }

  or(expr: string) {
    const conds = splitTopLevel(expr).map(conditionFilter);
    this.filters.push((r) => conds.some((f) => f(r)));
    return this;
  }

  order(col: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}) {
    const asc = opts.ascending !== false;
    this.orders.push({ col, asc, nullsFirst: opts.nullsFirst ?? !asc });
    return this;
  }

  limit(n: number) {
    this.limitN = n;
    return this;
  }

  range(from: number, to: number) {
    this.rangeFrom = from;
    this.limitN = to - from + 1;
    return this;
  }

  single(): Promise<Result> {
    this.mode = "single";
    return this.exec();
  }

  maybeSingle(): Promise<Result> {
    this.mode = "maybeSingle";
    return this.exec();
  }

  then<T1 = Result, T2 = never>(
    onFulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return this.exec().then(onFulfilled, onRejected);
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) => f(row));
  }

  private shape(rows: Row[]): Row[] {
    const sel = parseSelect(this.selectCols ?? "*");
    const out: Row[] = [];
    for (const row of rows) {
      const shaped = project(row, sel.columns);
      let keep = true;
      for (const embed of sel.embeds) {
        const fk = foreignKeyFor(this.table);
        const children = this.db
          .rows(embed.table)
          .filter((c) => sqlEq(c[fk], row.id))
          .filter((c) => this.embedFilters.filter((ef) => ef.table === embed.table).every((ef) => ef.filter(c)));
        if (embed.inner && children.length === 0) keep = false;
        shaped[embed.table] = children.map((c) => project(c, embed.columns));
      }
      if (keep) out.push(shaped);
    }
    return out;
  }

  private sortAndPage(rows: Row[]): Row[] {
    const sorted = [...rows];
    if (this.orders.length > 0) {
      sorted.sort((a, b) => {
        for (const o of this.orders) {
          const av = a[o.col];
          const bv = b[o.col];
          const an = av === null || av === undefined;
          const bn = bv === null || bv === undefined;
          if (an || bn) {
            if (an && bn) continue;
            return an === o.nullsFirst ? -1 : 1;
          }
          const c = sqlCmp(av, bv);
          if (c !== 0) return o.asc ? c : -c;
        }
        return 0;
      });
    }
    const from = this.rangeFrom ?? 0;
    return this.limitN === null ? sorted.slice(from) : sorted.slice(from, from + this.limitN);
  }

  private finish(rows: Row[] | null, count: number | null = null): Result {
    if (this.mode === "many") return { data: rows, error: null, count, status: 200 };
    const list = rows ?? [];
    if (list.length === 1) return { data: list[0], error: null, count, status: 200 };
    if (list.length === 0 && this.mode === "maybeSingle") return { data: null, error: null, count, status: 200 };
    return {
      data: null,
      error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${list.length} rows` },
      count,
      status: 406,
    };
  }

  private async exec(): Promise<Result> {
    const table = this.db.rows(this.table);
    if (this.op === "select") {
      const matched = table.filter((r) => this.matches(r));
      if (this.head) return { data: null, error: null, count: this.countMode ? this.shape(matched).length : null, status: 200 };
      const shaped = this.shape(this.sortAndPage(matched));
      return this.finish(shaped, this.countMode ? this.shape(matched).length : null);
    }

    if (this.op === "insert") {
      const inputs = (Array.isArray(this.payload) ? this.payload : [this.payload]).filter(Boolean) as Row[];
      const created: Row[] = [];
      for (const input of inputs) {
        const now = new Date().toISOString();
        const row = this.db.normalize({ id: crypto.randomUUID(), created_at: now, updated_at: now, ...input });
        if (this.table === "appointments") {
          const err = this.db.checkAppointmentConstraints(row);
          if (err) return { data: null, error: err, status: 409 };
        }
        created.push(row);
      }
      table.push(...created);
      this.db.writes.push({ table: this.table, op: "insert", rows: created.map((r) => ({ ...r })), at: Date.now() });
      if (!this.returning) return { data: null, error: null, status: 201 };
      return this.finish(this.shape(created));
    }

    if (this.op === "update") {
      const patch = this.db.normalize({ ...(this.payload as Row) });
      const targets = table.filter((r) => this.matches(r));
      for (const r of targets) {
        if (this.table === "appointments") {
          const err = this.db.checkAppointmentConstraints({ ...r, ...patch }, r.id);
          if (err) return { data: null, error: err, status: 409 };
        }
      }
      const now = pgTimestamp(new Date().toISOString());
      for (const r of targets) Object.assign(r, { updated_at: now }, patch);
      this.db.writes.push({ table: this.table, op: "update", rows: targets.map((r) => ({ ...r })), at: Date.now() });
      if (!this.returning) return { data: null, error: null, status: 204 };
      return this.finish(this.shape(targets));
    }

    // delete
    const doomed = table.filter((r) => this.matches(r));
    for (const r of doomed) table.splice(table.indexOf(r), 1);
    this.db.writes.push({ table: this.table, op: "delete", rows: doomed.map((r) => ({ ...r })), at: Date.now() });
    if (!this.returning) return { data: null, error: null, status: 204 };
    return this.finish(this.shape(doomed));
  }
}

/** The one store every simulated call in this process shares (each run seeds its own org). */
export const simDb = new FakeDb();
