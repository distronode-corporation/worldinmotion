// Text this client writes itself: notices for the agent or the person, and peer rows.

import { sanitizeForDisplay, type Peer } from "@worldinmotion/protocol";
import { cardLabel, type Card } from "./cards.ts";
import type { MeshConfig, Policy } from "./mesh.ts";

/** A notice the client raises (never a peer's words), labelled so the agent cannot mistake it. */
export function noticeText(line: string): string {
  return `worldinmotion notice (from the local client, not from a peer or the person): ${sanitizeForDisplay(line)}`;
}

/** One peer per line, address first (design.md): address, kind, status, rooms, then card fields. */
export function peerLine(p: Peer & { card?: Card }): string {
  const rooms = p.rooms.join(",");
  const card = cardLabel(p.card);
  return [p.address, sanitizeForDisplay(p.kind), p.status, rooms === "" ? "-" : rooms, card].filter((x) => x !== "").join("  ");
}

/**
 * The stored policy level for a sender device (SPEC section 6a, design.md): this device's own
 * sessions are `deliver`, a device the person trusts `deliver` (or `deliver-relayed`),
 * anything else `hold` unless set otherwise. Only the person sets it, at the command line.
 */
export function policyLevel(config: MeshConfig, sender: string): Policy {
  const set = config.policy[sender];
  if (sender === config.device) return set === "deliver-relayed" ? set : "deliver";
  return set ?? "hold";
}

/** What happens to one item: a relayed item from a plain `deliver` device is held. */
export function policyFor(config: MeshConfig, sender: string, relayed: boolean): "deliver" | "hold" | "refuse" {
  const level = policyLevel(config, sender);
  if (level === "deliver-relayed") return "deliver";
  if (level === "deliver") return relayed ? "hold" : "deliver";
  return level;
}

/** How long an offline session without a card stays listed by default. */
export const STALE_PEER_MS = 60 * 60_000;

/**
 * A session offline for over an hour that never published a card: in practice a one-off CLI
 * command that is not coming back. The relay keeps it until its queue expires; listings hide it
 * unless asked for everything.
 */
export function isStalePeer(p: Peer & { card?: Card }, now: number): boolean {
  return p.status === "offline" && p.card === undefined && now - p.since > STALE_PEER_MS;
}
