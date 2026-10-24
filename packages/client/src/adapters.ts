// Thin adapters from a mesh session to the interfaces of `wim bot`, `wim ci` and `wim a2a`.
// Everything they receive has passed the same checks, policy and breaker as any agent's items.

import type { MeshPort, MeshPeer, MeshResult, MeshTask, MeshMessage } from "@worldinmotion/a2a";
import type { BotIO, BotItem, SendOptions as BotSendOptions } from "@worldinmotion/bot";
import type { CiIO } from "@worldinmotion/ci";
import { accepted, ClientError, type Inbound, type MeshSession, type SendOutcome } from "./client.ts";

/** Each delivered item once, then marked taken so the spool stays empty and receipts go out. */
function onInbound(s: MeshSession, cb: (m: Inbound) => void): void {
  s.on("message", (m: Inbound) => {
    cb(m);
    void s.take(m.cursor);
  });
}

function requireDelivered(out: SendOutcome, to: string): SendOutcome {
  if (!out.results.some((r) => accepted(r.status))) {
    throw new ClientError(`not delivered to ${to}: ${out.results.map((r) => `${r.to} ${r.status}`).join(", ")}`, "undelivered");
  }
  return out;
}

export function botIO(s: MeshSession): BotIO {
  return {
    onItem(cb: (item: BotItem) => void): void {
      onInbound(s, (m) => {
        cb({
          kind: m.kind,
          from: m.peer,
          // The peer's self-reported kind: a label for the bot's own guards, never a trust input.
          fromKind: s.peers.get(m.peer)?.kind ?? "unknown",
          id: m.id,
          text: m.text,
          ...(m.reply_to === undefined ? {} : { reply_to: m.reply_to }),
          ...(m.deadline === undefined ? {} : { deadline: m.deadline }),
        });
      });
    },
    async send(to: string, text: string, opts: BotSendOptions = {}): Promise<void> {
      // A model wrote this text, not the session: always marked relayed (revision 4, H1).
      await s.send(to, text, {
        relayed: true,
        kind: opts.kind ?? "msg",
        ...(opts.reply_to === undefined ? {} : { reply_to: opts.reply_to }),
        ...(opts.status === undefined ? {} : { status: opts.status }),
      });
    },
  };
}

export function ciIO(s: MeshSession, log: (line: string) => void): CiIO {
  const joined = new Set<string>();
  return {
    async post(room: string, text: string): Promise<void> {
      if (!joined.has(room)) {
        await s.joinRoom(room);
        joined.add(room);
      }
      // Pipeline names, commit messages and logs come from elsewhere: relayed.
      await s.send(room, text, { relayed: true });
    },
    log,
  };
}

export function meshPort(s: MeshSession): MeshPort {
  return {
    async peers(): Promise<MeshPeer[]> {
      return (await s.listPeers()).map((p) => ({ address: p.address, kind: p.kind, status: p.status }));
    },
    async sendTask(to: string, text: string, opts: { deadline?: number }): Promise<{ id: string }> {
      // Every text through the gateway comes from an external agent: relayed.
      const out = await s.send(to, text, { kind: "task", relayed: true, ...(opts.deadline === undefined ? {} : { deadline: opts.deadline }) });
      return { id: requireDelivered(out, to).id };
    },
    onResult(cb: (r: MeshResult) => void): void {
      onInbound(s, (m) => {
        if (m.kind === "result" && m.reply_to !== undefined) cb({ reply_to: m.reply_to, status: m.status ?? "done", text: m.text, from: m.peer });
      });
    },
    onTask(cb: (t: MeshTask) => void): void {
      onInbound(s, (m) => {
        if (m.kind === "task") cb({ id: m.id, to: s.address, from: m.peer, text: m.text, ...(m.deadline === undefined ? {} : { deadline: m.deadline }) });
      });
    },
    async sendResult(to: string, taskId: string, status: MeshResult["status"], text: string): Promise<void> {
      requireDelivered(await s.send(to, text, { kind: "result", reply_to: taskId, status, relayed: true }), to);
    },
    onMessage(cb: (m: MeshMessage) => void): void {
      onInbound(s, (m) => {
        if (m.kind === "msg") cb({ id: m.id, to: s.address, from: m.peer, text: m.text });
      });
    },
  };
}
