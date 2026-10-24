/** `45s`, `12m`, `1h 5m`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

/** `2 jobs failed: test, lint`, listing at most five names. */
export function jobList(names: string[], what: string): string {
  const unique = [...new Set(names)];
  const shown = unique.slice(0, 5).join(", ");
  const more = unique.length > 5 ? ` and ${unique.length - 5} more` : "";
  const noun = unique.length === 1 ? "job" : "jobs";
  return `${unique.length} ${noun} ${what}: ${shown}${more}`;
}

/** Milliseconds between two ISO timestamps, or undefined when either is missing or unparseable. */
export function between(start: string | null | undefined, end: string | null | undefined): number | undefined {
  const a = Date.parse(start ?? "");
  const b = Date.parse(end ?? "");
  return Number.isNaN(a) || Number.isNaN(b) ? undefined : b - a;
}

/** Whether a ref passes the source's optional `refs` filter. */
export function refAllowed(ref: string, refs: string[] | undefined): boolean {
  return refs === undefined || refs.includes(ref);
}
