// `wim ping` (SPEC section 12): a ping is answered by the receiving client itself with a pong,
// never by an agent. This module holds the answering side's budget and the asking side's report.

/** The limits on answering pings (SPEC section 9). */
export const PING = {
  /** A ping older than this is not answered: one that waited in an offline session's queue is stale. */
  freshMs: 60_000,
  /** Pongs a session sends to one device, and to all devices together, in a sliding minute. */
  perDevicePerMinute: 10,
  perSessionPerMinute: 60,
  /** How long `wim ping` waits for pongs by default. */
  waitMs: 5000,
} as const;

const MINUTE = 60_000;

/** One answering session's pong budget, per sender device and in total, over a sliding minute. */
export class PongBudget {
  private readonly byDevice = new Map<string, number[]>();
  private total: number[] = [];

  /** Whether a ping from `device`, sent at `at`, is answered now; counts it when it is. */
  allow(device: string, at: number, now: number): boolean {
    if (now - at > PING.freshMs) return false;
    const recent = (times: number[] | undefined): number[] => (times ?? []).filter((t) => now - t < MINUTE);
    const mine = recent(this.byDevice.get(device));
    this.total = recent(this.total);
    if (mine.length >= PING.perDevicePerMinute || this.total.length >= PING.perSessionPerMinute) {
      this.byDevice.set(device, mine);
      return false;
    }
    mine.push(now);
    this.total.push(now);
    this.byDevice.set(device, mine);
    return true;
  }
}

/** One pinged session: the relay's status for the ping, and the round trip when a pong came back. */
export type PingRow = { to: string; status: string; ms?: number };

/** The device name of an address (`name@device`). */
const deviceOf = (address: string): string => address.slice(address.indexOf("@") + 1);

function what(r: PingRow, waitMs: number): string {
  if (r.ms !== undefined) return `pong in ${r.ms} ms`;
  if (r.status === "routed") return `no pong in ${waitMs / 1000} s (an older client, or a session that is not reading)`;
  if (r.status === "offline") return "offline, not pinged";
  if (r.status === "queued") return "offline: the relay queued it, so no pong now";
  return r.status;
}

/**
 * The report `wim ping` prints: one row per pinged session, then one per device. A pong proves
 * both directions at once: this device sealed the ping and the other opened it, and the other
 * sealed the pong and this device opened it.
 */
export function pingReport(rows: readonly PingRow[], from: string, waitMs: number): string[] {
  const width = Math.max(...rows.map((r) => r.to.length));
  const lines = [`Pinged from ${from}:`, ...rows.map((r) => `  ${r.to.padEnd(width)}  ${what(r, waitMs)}`)];
  const devices = new Map<string, { asked: number; answered: number }>();
  for (const r of rows) {
    const d = devices.get(deviceOf(r.to)) ?? { asked: 0, answered: 0 };
    d.asked++;
    if (r.ms !== undefined) d.answered++;
    devices.set(deviceOf(r.to), d);
  }
  const here = deviceOf(from);
  lines.push(`Devices (a pong means ${here} -> device and device -> ${here} both work, encryption included):`);
  const nameWidth = Math.max(...[...devices.keys()].map((n) => n.length));
  for (const [name, d] of devices) {
    const verdict = d.answered > 0 ? `both directions ok (${d.answered} of ${d.asked} answered)` : "no answer";
    lines.push(`  ${name.padEnd(nameWidth)}  ${verdict}`);
  }
  return lines;
}
