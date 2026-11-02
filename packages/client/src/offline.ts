// The person's decisions on held messages from the command line. A session that a live process
// runs gets a marker file and applies the decision itself (it can send the receipt); a session
// nobody runs is updated on disk directly.

import { join } from "node:path";
import { writeAtomic, type FsEnv } from "./fsx.ts";
import { HeldBox, type HeldItem, type Verdict } from "./held.ts";
import { History, releasedFrame } from "./history.ts";
import type { MeshConfig, MeshFiles } from "./mesh.ts";
import { listSessions, SessionFiles } from "./session.ts";
import { Spool } from "./spool.ts";

export type HeldRow = HeldItem & { sid: string; session: string };

/** Every held message of every session of a mesh on this device. */
export async function listAllHeld(mesh: MeshFiles, env: FsEnv): Promise<HeldRow[]> {
  const rows: HeldRow[] = [];
  for (const sid of await listSessions(mesh)) {
    const files = new SessionFiles(mesh, sid, env);
    const name = (await files.load())?.name ?? "?";
    for (const item of await new HeldBox(files.heldDir, env).list()) rows.push({ ...item, sid, session: name });
  }
  return rows.sort((a, b) => a.at - b.at);
}

/**
 * Applies a decision to one session that no live process holds. An approved item is framed and
 * flagged as the live session would frame it (`releasedFrame`), so reading it later starts the
 * `derived` window the same way.
 */
async function applyOffline(files: SessionFiles, item: HeldItem, verdict: Verdict, config: MeshConfig, env: FsEnv, now: () => number): Promise<void> {
  const box = new HeldBox(files.heldDir, env);
  await box.remove(item.id);
  if (verdict === "refuse") return;
  const state = await files.load();
  const spool = await Spool.open(files.spoolDir, env, state?.spool ?? 0);
  await spool.write({ kind: item.kind, from: item.from, device: item.device, id: item.id, at: item.at, ...releasedFrame(config, item.device, item.entry) });
  if (state !== undefined) await files.save({ ...state, spool: spool.highest });
  await new History(files.historyPath, now).append(item.entry);
}

/** Approves or refuses a held message wherever it is held. Returns how many sessions held it. */
export async function decideHeld(mesh: MeshFiles, id: string, verdict: Verdict, env: FsEnv, now: () => number, skipSid?: string): Promise<number> {
  let n = 0;
  const config = await mesh.loadConfig();
  for (const row of await listAllHeld(mesh, env)) {
    // The caller's own live session decides its items itself (it can send the receipt).
    if (row.id !== id || row.sid === skipSid) continue;
    const files = new SessionFiles(mesh, row.sid, env);
    // A file is fetched by the session itself when it next runs: nothing is downloaded here.
    const later = (await files.isLiveElsewhere()) || (verdict === "approve" && row.fileInfo !== undefined);
    if (later) await new HeldBox(files.heldDir, env).mark(id, verdict);
    else await applyOffline(files, row, verdict, config, env, now);
    n++;
  }
  return n;
}

/** Lifts a breaker pause on `peer` in every session, releasing what the breaker held. */
export async function resumeEverywhere(mesh: MeshFiles, peer: string, env: FsEnv, now: () => number, skipSid?: string): Promise<number> {
  let released = 0;
  const config = await mesh.loadConfig();
  for (const sid of (await listSessions(mesh)).filter((s) => s !== skipSid)) {
    const files = new SessionFiles(mesh, sid, env);
    if (await files.isLiveElsewhere()) {
      await writeAtomic(join(files.controlDir, `resume-${peer}`), "", env);
      continue;
    }
    const box = new HeldBox(files.heldDir, env);
    for (const item of await box.list()) {
      // The breaker counts per sender device, so a resume releases that device's held items.
      if (item.from.split("@")[1] !== peer.split("@")[1] || item.reason !== "breaker") continue;
      if (item.fileInfo !== undefined) await box.mark(item.id, "approve");
      else await applyOffline(files, item, "approve", config, env, now);
      released++;
    }
  }
  return released;
}
