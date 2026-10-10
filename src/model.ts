// Reading and writing of <event> and <task> blocks. The rules mirror
// notificator/core/parsing.py: what is an error there is an error here.

export type Kind = "event" | "task";
export type ViewMode = "row" | "card";

export const COLORS = ["blue", "green", "purple", "red", "orange", "yellow", "pink", "cyan"] as const;

const SCALAR_FIELDS = [
  "uid", "summary", "start", "end", "due", "description",
  "location", "recurrence", "calendar_id", "tasklist", "time_zone",
];
const WRITE_ORDER = [
  "uid", "summary", "start", "end", "due", "description",
  "location", "recurrence", "attendees", "calendar_id", "tasklist", "time_zone",
];
const META_KEYS = ["view", "color"];
// An <event> or <task> block that has no other such block inside it.
const BLOCK_RE = /<(event|task)\b[^>]*>(?:(?!<(?:event|task)\b)[\s\S])*?<\/\1>/g;
const FENCE_OPEN_RE = /^[ \t]*(?:`{3,}|~{3,})[ \t]*\w*\s*$/;
const FENCE_CLOSE_RE = /^[ \t]*(?:`{3,}|~{3,})\s*$/;
const UID_RE =/^[A-Za-z0-9]+$/;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::\d{2})?)?$/;
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const FREQ_LABELS: Record<string, string> = {
  "FREQ=DAILY": "каждый день",
  "FREQ=WEEKLY": "каждую неделю",
  "FREQ=MONTHLY": "каждый месяц",
  "FREQ=YEARLY": "каждый год",
};

export interface Block {
  // What the panel replaces: the block with the `#` that switches it off, if it has one.
  from: number;
  to: number;
  // Where the opening tag starts.
  tagFrom: number;
  kind: Kind;
  // The text from the opening tag to the closing one.
  raw: string;
  // The parser skips the block: there is a `#` before its opening tag.
  disabled: boolean;
  // Whitespace the block's line starts with; lines written back get the same.
  indent: string;
  // Nothing else is on the block's lines.
  alone: boolean;
  // The block is the whole content of a code fence; `from` and `to` take the fence in.
  fenced: boolean;
}

export interface Item {
  kind: Kind;
  // Attributes of the opening tag, kept as they were written.
  attrs: string;
  fields: Record<string, string>;
  attendees: string[];
  // Display settings from the `<!-- view: card; color: blue -->` comment.
  meta: Record<string, string>;
  // Tags and comments this plugin does not know, kept as they were written.
  extra: string[];
  disabled: boolean;
  // Why the block could not be read; the fields are empty then.
  error?: string;
}

export interface Edit {
  from: number;
  to: number;
  insert: string;
}

export function findBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const m of text.matchAll(BLOCK_RE)) {
    const tagFrom = m.index ?? 0;
    const lineStart = text.lastIndexOf("\n", tagFrom - 1) + 1;
    const before = text.slice(lineStart, tagFrom);
    const trimmed = before.trim();
    const plain = trimmed === "" || trimmed === "#";
    const tagTo = tagFrom + m[0].length;
    const lineEnd = endOfLine(text, tagTo);
    const block: Block = {
      from: trimmed === "#" ? lineStart + before.indexOf("#") : tagFrom,
      to: tagTo,
      tagFrom,
      kind: m[1] as Kind,
      raw: m[0],
      disabled: trimmed.startsWith("#") || trimmed.endsWith("#"),
      indent: plain ? (/^[ \t]*/.exec(before)?.[0] ?? "") : "",
      alone: plain && text.slice(tagTo, lineEnd).trim() === "",
      fenced: false,
    };
    if (block.alone && lineStart > 0 && lineEnd < text.length) {
      const prevStart = text.lastIndexOf("\n", lineStart - 2) + 1;
      const prev = text.slice(prevStart, lineStart - 1);
      const next = text.slice(lineEnd + 1, endOfLine(text, lineEnd + 1));
      if (FENCE_OPEN_RE.test(prev) && FENCE_CLOSE_RE.test(next)) {
        block.fenced = true;
        block.indent = /^[ \t]*/.exec(prev)?.[0] ?? "";
        block.from = prevStart + block.indent.length;
        block.to = lineEnd + 1 + next.trimEnd().length;
      }
    }
    blocks.push(block);
  }
  return blocks;
}

function endOfLine(text: string, pos: number): number {
  const end = text.indexOf("\n", pos);
  return end === -1 ? text.length : end;
}

export function newItem(kind: Kind): Item {
  return { kind, attrs: "", fields: {}, attendees: [], meta: {}, extra: [], disabled: false };
}

export function parseItem(raw: string, disabled = false): Item {
  const kind: Kind = raw.startsWith("<task") ? "task" : "event";
  const item = newItem(kind);
  item.disabled = disabled;
  item.attrs = /^<(?:event|task)\b([^>]*)>/.exec(raw)?.[1] ?? "";
  // The parser drops lines that start with `#` before it looks for blocks.
  const clean = raw.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");

  let root: Element | null = null;
  try {
    const doc = new DOMParser().parseFromString(clean, "application/xml");
    if (!doc.querySelector("parsererror")) root = doc.documentElement;
  } catch {
    root = null;
  }
  if (!root) {
    item.error = "некорректный XML";
    return item;
  }

  const serializer = new XMLSerializer();
  const seen = new Set<string>();
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === 8) {
      const meta = parseMeta(node.nodeValue ?? "");
      if (meta) Object.assign(item.meta, meta);
      else item.extra.push(`<!--${node.nodeValue}-->`);
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    const tag = el.tagName;
    if (seen.has(tag)) {
      item.error = `тег <${tag}> указан более одного раза`;
      return item;
    }
    seen.add(tag);
    const text = (el.textContent ?? "").trim();
    if (tag === "attendees") {
      // <attendees><email>a@b.c</email>...</attendees>; the child tag name is not significant.
      item.attendees = el.children.length
        ? Array.from(el.children).map((c) => (c.textContent ?? "").trim()).filter(Boolean)
        : splitList(text);
    } else if (SCALAR_FIELDS.includes(tag)) {
      if (el.children.length) {
        item.error = `тег <${tag}> не должен содержать вложенных тегов`;
        return item;
      }
      if (text) item.fields[tag] = text;
    } else {
      item.extra.push(serializer.serializeToString(el));
    }
  }
  return item;
}

export function serializeItem(item: Item, indent = ""): string {
  const lines = [`<${item.kind}${item.attrs}>`];
  const meta = META_KEYS.filter((key) => item.meta[key]).map((key) => `${key}: ${item.meta[key]}`);
  if (meta.length) lines.push(`  <!-- ${meta.join("; ")} -->`);
  for (const name of WRITE_ORDER) {
    if (name === "attendees") {
      if (item.attendees.length) lines.push(`  <attendees>${escapeXml(item.attendees.join("; "))}</attendees>`);
    } else if (item.fields[name]?.trim()) {
      lines.push(`  <${name}>${escapeXml(item.fields[name].trim())}</${name}>`);
    }
  }
  for (const extra of item.extra) lines.push(`  ${extra}`);
  lines.push(`</${item.kind}>`);
  return lines.join("\n").replace(/\n/g, "\n" + indent);
}

/** What notificator would reject in this block. `otherUids` are the uids of the file's other blocks. */
export function validate(item: Item, otherUids: ReadonlySet<string> = new Set()): string[] {
  if (item.error) return [item.error];
  const errors: string[] = [];
  const f = item.fields;
  if (!f.uid) errors.push("не задан uid");
  else if (!UID_RE.test(f.uid)) errors.push("uid должен состоять только из латинских букв и цифр");
  else if (otherUids.has(f.uid)) errors.push(`uid ${f.uid} уже используется в этом файле`);
  if (!f.summary) errors.push("не задано название");

  if (item.kind === "event") {
    if (f.due) errors.push("у события не может быть due: время события задаётся в start");
    if (!f.start) errors.push("не задано начало");
    const start = parseIso(f.start), end = parseIso(f.end);
    if (start && end && end.at <= start.at) errors.push("конец должен быть позже начала");
    for (const email of item.attendees) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push(`некорректный email участника: ${email}`);
    }
  } else if (f.start) {
    errors.push("у задачи не может быть start: срок задачи задаётся в due");
  }

  if (f.time_zone && !isTimeZone(f.time_zone)) errors.push(`неизвестный часовой пояс: ${f.time_zone}`);
  if (/^[ \t]*#/m.test(f.description ?? "")) {
    errors.push("строка описания не может начинаться с #: такие строки сервис пропускает");
  }
  return errors;
}

/** A date written as `2026-11-18` or `2026-11-18 10:00`; anything else is free text for the service to read. */
export function parseIso(value: string | undefined): { date: string; time: string | null; at: Date } | null {
  const m = ISO_RE.exec((value ?? "").trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const at = new Date(+y, +mo - 1, +d, +(h ?? 0), +(mi ?? 0));
  if (at.getMonth() !== +mo - 1 || at.getDate() !== +d) return null;
  return { date: `${y}-${mo}-${d}`, time: h ? `${h}:${mi}` : null, at };
}

/** When the event is or the task is due, as the panel shows it. */
export function formatWhen(item: Item, now = new Date()): string {
  const f = item.fields;
  if (item.kind === "task") {
    const due = parseIso(f.due);
    if (due) return `до ${day(due.at, now, false)}`;
    return f.due ? `до ${f.due}` : "";
  }
  const start = parseIso(f.start), end = parseIso(f.end);
  if (!start) return [f.start, f.end].filter(Boolean).join(" – ");
  const from = `${day(start.at, now, true)} · ${clock(start.at)}`;
  if (!f.end) return from;
  if (!end) return `${from} – ${f.end}`;
  if (end.date === start.date) return `${from}–${clock(end.at)}`;
  return `${day(start.at, now, false)} ${clock(start.at)} – ${day(end.at, now, false)} ${clock(end.at)}`;
}

export function recurrenceLabel(recurrence: string | undefined): string {
  const rule = normalizeRecurrence(recurrence);
  return rule ? (FREQ_LABELS[rule] ?? "повторяется") : "";
}

export function normalizeRecurrence(recurrence: string | undefined): string {
  return (recurrence ?? "").trim().replace(/^RRULE:/i, "").toUpperCase();
}

/**
 * The change that replaces the block whose text is `raw` with `next`, or removes it when `next` is null.
 * Of several identical blocks the one closest to `near` is taken. Null when the block is gone.
 */
export function locateEdit(
  text: string, raw: string, near: number, next: { raw: string; disabled: boolean } | null,
): Edit | null {
  let target: Block | null = null;
  for (const block of findBlocks(text)) {
    if (block.raw !== raw) continue;
    if (!target || Math.abs(block.from - near) < Math.abs(target.from - near)) target = block;
  }
  if (!target) return null;
  if (next !== null) {
    // A block with text on its lines cannot get a fence without moving that text.
    const insert = blockText(next.raw, next.disabled, target.alone, target.indent);
    return { from: target.from, to: target.to, insert };
  }
  // A removed block takes its line with it when nothing else is on that line.
  const lineStart = text.lastIndexOf("\n", target.from - 1) + 1;
  const alone = text.slice(lineStart, target.from).trim() === "";
  if (alone && text[target.to] === "\n") return { from: lineStart, to: target.to + 1, insert: "" };
  return { from: target.from, to: target.to, insert: "" };
}

export function applyEdit(text: string, edit: Edit): string {
  return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
}

/**
 * The text of a block as it goes into the file: switched off blocks get `#` before the tag,
 * and a block on lines of its own goes into an xml code fence.
 */
export function blockText(raw: string, disabled: boolean, fenced: boolean, indent = ""): string {
  const body = (disabled ? "#" : "") + raw;
  return fenced ? `\`\`\`xml\n${indent}${body}\n${indent}\`\`\`` : body;
}

/** The changes that put every block that can have a fence and has none into one, last block first. */
export function fenceEdits(text: string): Edit[] {
  return findBlocks(text)
    .filter((block) => block.alone && !block.fenced)
    .reverse()
    .map((block) => ({
      from: block.from, to: block.to, insert: blockText(block.raw, block.disabled, true, block.indent),
    }));
}

export function newUid(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** uids of the blocks that are switched on, with how many times each occurs. */
export function uidCounts(text: string, blocks: Block[] = findBlocks(text)): Map<string, number> {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    if (block.disabled) continue;
    const uid = /<uid>\s*([A-Za-z0-9]+)\s*<\/uid>/.exec(block.raw)?.[1];
    if (uid) counts.set(uid, (counts.get(uid) ?? 0) + 1);
  }
  return counts;
}

function parseMeta(comment: string): Record<string, string> | null {
  const meta: Record<string, string> = {};
  for (const part of comment.split(";")) {
    const m = /^\s*([a-z_]+)\s*:\s*(\S+)\s*$/.exec(part);
    if (!m || !META_KEYS.includes(m[1])) return null;
    meta[m[1]] = m[2];
  }
  return meta;
}

function splitList(text: string): string[] {
  return text.split(";").map((part) => part.trim()).filter(Boolean);
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

function day(at: Date, now: Date, weekday: boolean): string {
  const year = at.getFullYear() === now.getFullYear() ? "" : ` ${at.getFullYear()}`;
  return `${weekday ? WEEKDAYS[at.getDay()] + ", " : ""}${at.getDate()} ${MONTHS[at.getMonth()]}${year}`;
}

function clock(at: Date): string {
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}
