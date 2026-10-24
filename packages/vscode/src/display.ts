// Plain-text helpers for peer data. Every text, preview, address, card field and file name that
// reaches this extension was written by another agent, so it is shown as plain text only, with
// characters that can hide or reorder text made visible.

// The same set as sanitizeForDisplay in @worldinmotion/protocol (a test holds the two equal):
// C0 controls other than tab and newline, DEL, C1 controls, the soft hyphen, bidirectional
// controls, zero-width and invisible format characters, line and paragraph separators, Unicode
// tag characters, the variation selector supplement, and unpaired surrogates. The class is built
// from numbers so this file holds no invisible characters itself.
const RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008],
  [0x000b, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
  [0xd800, 0xdfff],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];
const BACKSLASH = String.fromCharCode(0x5c);
const ELLIPSIS = String.fromCharCode(0x2026);
const point = (n: number): string => `${BACKSLASH}u{${n.toString(16)}}`;
const HIDDEN = new RegExp(`[${RANGES.map(([a, b]) => `${point(a)}-${point(b)}`).join("")}]`, "gu");

function escapeHidden(c: string): string {
  return `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`;
}

/** Escapes hidden and control characters visibly, as `<U+XXXX>`. Tabs and newlines are kept. */
export function visible(text: string): string {
  return text.replace(HIDDEN, escapeHidden);
}

/** One line for a label or a description: hidden characters escaped, whitespace runs folded. */
export function oneLine(text: string, max = 120): string {
  const line = visible(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}${ELLIPSIS}` : line;
}

/**
 * For a QuickPick, a tree label or the status bar, which render `$(name)` as an icon: breaks the
 * pattern so a peer's text cannot draw an icon.
 */
export function noIcons(text: string): string {
  return text.replaceAll("$(", "$ (");
}

/**
 * For a notification, which renders `[label](target)` as a link (command links included):
 * breaks the pattern, as well as icons, and folds the text to one line.
 */
export function notice(text: string, max = 300): string {
  return noIcons(oneLine(text, max)).replaceAll("](", "] (");
}

/** The device part of `name@device`, or `""` for a room or anything without one. */
export function deviceOf(address: string): string {
  const at = address.lastIndexOf("@");
  return address.startsWith("#") || at < 0 ? "" : address.slice(at + 1);
}

/** The name part of `name@device`. */
export function nameOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? address : address.slice(0, at);
}

export const ADDRESS_RE = /^[a-z0-9][a-z0-9-]{0,31}@[a-z0-9][a-z0-9-]{0,31}$/;
export const ROOM_RE = /^#[a-z0-9][a-z0-9-]{0,31}$/;
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** An address or room in the client's own grammar, safe to name in a notification. */
export function isTarget(text: string): boolean {
  return ADDRESS_RE.test(text) || ROOM_RE.test(text);
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** Local wall-clock time, `HH:MM:SS`. */
export function clock(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Local date and time, `YYYY-MM-DD HH:MM:SS`. */
export function stamp(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(at)}`;
}

/** A short duration: `850 ms`, `4.2 s`, `3 min`, `2 h`. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}

/** A file size: `512 B`, `3.4 KiB`, `1.2 MiB`. */
export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
