// What `wim ci` says when it starts (issue #159, B): its lines are relayed text, and a session holds
// relayed text unless its device's person trusts the sending device with `--relayed`. Each room
// member whose device would hold them is named, with the exact command for that device. Only this
// device's own policy is known here; another device's is on that device, so its members are named
// as holding the lines unless it already trusts this one that way.

import { sanitizeForDisplay } from "@worldinmotion/protocol";
import type { PeerRow } from "./client.ts";
import type { HeldFeedLimits, MeshConfig } from "./mesh.ts";
import { policyLevel } from "./render.ts";

/** The device part of an address (`session@device`). */
const deviceOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1);

/**
 * The warning lines for a `wim ci` session at `self` (its own address) posting to `rooms`, given
 * the peers the relay lists: none when no other session is in those rooms, or when every member is
 * on this device and this device already delivers relayed text to its own sessions.
 */
export function ciTrustLines(self: string, rooms: readonly string[], peers: readonly PeerRow[], config: MeshConfig, held: HeldFeedLimits): string[] {
  const here = deviceOf(self);
  const selfRelayed = policyLevel(config, config.device) === "deliver-relayed";
  const lines: string[] = [];
  for (const room of [...new Set(rooms)]) {
    const members = peers.filter((p) => p.address !== self && p.rooms.includes(room));
    const byDevice = new Map<string, string[]>();
    for (const p of members) byDevice.set(deviceOf(p.address), [...(byDevice.get(deviceOf(p.address)) ?? []), sanitizeForDisplay(p.address)]);
    for (const [device, names] of byDevice) {
      const who = `${room}: ${names.join(", ")}`;
      if (device === here) {
        if (!selfRelayed) lines.push(`  ${who} (this device) hold${names.length === 1 ? "s" : ""} them. Here, run: wim devices trust ${sanitizeForDisplay(here)} --relayed`);
      } else {
        lines.push(`  ${who} hold${names.length === 1 ? "s" : ""} them unless ${sanitizeForDisplay(device)} trusts ${sanitizeForDisplay(here)} with --relayed. On ${sanitizeForDisplay(device)}, run: wim devices trust ${sanitizeForDisplay(here)} --relayed`);
      }
    }
  }
  if (lines.length === 0) return [];
  return [
    "wim: warning: wim ci posts relayed text (what CI providers wrote), and a session holds relayed text unless its device trusts the sending device with --relayed:",
    ...lines,
    `Lines held anyway expire by themselves after ${held.maxAgeHours} hour${held.maxAgeHours === 1 ? "" : "s"} (heldFeeds in mesh.json), or once ${held.keep} newer ones wait; the person clears the rest with wim held refuse --from ${sanitizeForDisplay(self)}.`,
  ];
}
