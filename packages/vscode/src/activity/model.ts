// The messages between the extension and the activity webview. The extension sends one `state`
// message with everything to draw; the webview may send back only the few messages below, and
// each is checked against the store before it does anything.

import { ADDRESS_RE, clock, isTarget } from "../display.ts";
import { edges, groups, timeline, type Store, type TimelineRow } from "../state.ts";
import { layout, type GraphLayout } from "./graph.ts";

export const WINDOWS = [5, 15, 60] as const;
export type WindowMinutes = (typeof WINDOWS)[number];
export const TIMELINE_ROWS = 200;

export type ToWebview = {
  type: "state";
  connection: string;
  windowMinutes: WindowMinutes;
  windows: readonly number[];
  rows: TimelineRow[];
  graph: GraphLayout;
};

export type FromWebview =
  | { type: "ready" }
  | { type: "openThread"; peer: string; session: string }
  | { type: "selectSession"; address: string }
  | { type: "window"; minutes: WindowMinutes };

export function buildState(store: Store, now: number, windowMinutes: WindowMinutes): ToWebview {
  const list = edges(store, now, windowMinutes * 60_000);
  const status = (address: string): string => {
    if (address.startsWith("#")) return "room";
    if (store.pause(address, now) !== undefined) return "paused";
    return store.sessions.get(address)?.status ?? "offline";
  };
  return {
    type: "state",
    connection: store.connection.state,
    windowMinutes,
    windows: WINDOWS,
    rows: timeline(store, TIMELINE_ROWS, clock),
    graph: layout(groups(store, list), list, status),
  };
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/**
 * Checks a message from the webview. Anything not in the narrow set, or naming a peer or session
 * the store does not know, is dropped.
 */
export function parseFromWebview(x: unknown, store: Store): FromWebview | undefined {
  if (!isObj(x)) return undefined;
  switch (x.type) {
    case "ready":
      return { type: "ready" };
    case "openThread": {
      const { peer, session } = x;
      if (typeof peer !== "string" || typeof session !== "string" || !isTarget(peer) || !ADDRESS_RE.test(session)) return undefined;
      const known = store.messages.some((m) => m.session === session) && store.threadPeers().includes(peer);
      return known ? { type: "openThread", peer, session } : undefined;
    }
    case "selectSession": {
      const { address } = x;
      return typeof address === "string" && store.sessions.has(address) ? { type: "selectSession", address } : undefined;
    }
    case "window": {
      const minutes = WINDOWS.find((w) => w === x.minutes);
      return minutes === undefined ? undefined : { type: "window", minutes };
    }
    default:
      return undefined;
  }
}
