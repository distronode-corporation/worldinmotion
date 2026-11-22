// The person's decisions on held messages from the command line. A session that a live process
// runs gets a marker file and applies the decision itself (it can send the receipt); a session
// nobody runs is updated on disk directly.

import { join, relative } from "node:path";
import { isPinned, loadCiRules } from "./cirules.ts";
import { covers, type Decision } from "./decisions.ts";
import { expiredFeedLines } from "./feeds.ts";
import { listFiles, writeAtomic, type FsEnv } from "./fsx.ts";
import { HeldBox, type HeldItem, type Verdict } from "./held.ts";
import { History, releasedFrame } from "./history.ts";
import { heldFeedLimits, type MeshConfig, type MeshFiles } from "./mesh.ts";
import { readBreakerFile, savePauses } from "./pauses.ts";
import { listSessions, SessionFiles, type SessionState } from "./session.ts";
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
 * Drops the held feed lines past their bound (feeds.ts) in every session no live process runs; a
 * session that runs drops its own (MeshSession reviewHeld). It takes each session's liveness lock
 * while it edits that session's held/, as a resume does, so a session that starts meanwhile reads
 * held/ after. Returns how many it dropped. Dropping never delivers anything.
 */
export async function expireOffline(mesh: MeshFiles, env: FsEnv, now: number): Promise<number> {
  const limits = heldFeedLimits(await mesh.loadConfig());
  let n = 0;
  for (const sid of await listSessions(mesh)) {
    const files = new SessionFiles(mesh, sid, env);
    // A session this process runs (a UI's events process) drops its own, as does one another process runs.
    if ((await files.holds()) || !(await files.claim())) continue;
    try {
      const box = new HeldBox(files.heldDir, env);
      for (const item of expiredFeedLines(await box.list(), limits, now)) {
        await box.remove(item.id);
        n++;
      }
    } finally {
      await files.release();
    }
  }
  return n;
}

/**
 * Applies decisions to one session that no live process holds. An approved item is framed and
 * flagged as the live session would frame it (`releasedFrame`), so reading it later starts the
 * `derived` window the same way. The session's state and spool are read once, at its first
 * approval, and its spool counter is written once, after its last (`done`): a resume of many
 * items costs only each item's own writes (#195). The counter only hints at the next number:
 * the spool numbers past every item on disk and the cursor anyway (Spool.open).
 */
class OfflineSession {
  private opened: Promise<{ state: SessionState | undefined; spool: Spool }> | undefined;
  private wrote = false;
  private readonly box: HeldBox;
  private readonly files: SessionFiles;
  private readonly config: MeshConfig;
  private readonly env: FsEnv;
  private readonly now: () => number;
  constructor(files: SessionFiles, config: MeshConfig, env: FsEnv, now: () => number) {
    this.files = files;
    this.config = config;
    this.env = env;
    this.now = now;
    this.box = new HeldBox(files.heldDir, env);
  }

  async apply(item: HeldItem, verdict: Verdict): Promise<void> {
    if (verdict === "refuse") return this.box.remove(item.id);
    this.opened ??= this.files.load().then(async (state) => ({ state, spool: await Spool.open(this.files.spoolDir, this.env, state?.spool ?? 0) }));
    const { spool } = await this.opened;
    // A CI notice was framed when it arrived, and only ever informs (SPEC section 18).
    const framed = item.ci === undefined ? releasedFrame(this.config, item.device, item.entry) : { rendered: item.rendered, relayed: true as const, informs: true as const };
    // In the spool before it leaves held/, as in a live session: if this stops in between, the
    // session's next process finds it delivered and only takes it out of held/.
    await spool.write({ kind: item.kind, from: item.from, device: item.device, id: item.id, at: item.at, ...framed });
    this.wrote = true;
    await this.box.markDelivered(item.id);
    await new History(this.files.historyPath, this.now).append(item.entry);
    await this.box.settle(item.id);
  }

  /** Records the spool's highest number in the session's state, once anything was written to it. */
  async done(): Promise<void> {
    if (!this.wrote) return;
    const { state, spool } = (await this.opened)!;
    if (state !== undefined) await this.files.save({ ...state, spool: spool.highest });
  }

  /** Runs `fn` with this session's decisions, then `done`, whether or not `fn` finished. */
  async run<T>(fn: (s: OfflineSession) => Promise<T>): Promise<T> {
    try {
      return await fn(this);
    } finally {
      await this.done();
    }
  }
}

/** Only the copies a signed decision covers, unchanged since the signer showed them; every copy without one. */
function coveredBy(decision: Decision | undefined, row: HeldRow): boolean {
  if (decision === undefined) return true;
  const { sid: _sid, session: _session, ...item } = row;
  return covers(decision, item);
}

/**
 * Approves or refuses a held message wherever it is held. Returns how many sessions held it. A CI
 * notice whose approval pins its rule's ids is approved only once `wim held approve`, at the
 * person's terminal, has pinned them (SPEC section 18); until then it stays held.
 *
 * `decision`: the signer's, when this device's keys are in it. Then only the copies it covers are
 * decided, and a session another process runs gets the decision file, never a mark.
 */
export async function decideHeld(mesh: MeshFiles, id: string, verdict: Verdict, env: FsEnv, now: () => number, skipSid?: string, decision?: Decision): Promise<number> {
  let n = 0;
  const config = await mesh.loadConfig();
  const rules = await loadCiRules(mesh.ciRulesPath).catch(() => []);
  for (const row of await listAllHeld(mesh, env)) {
    // The caller's own live session decides its items itself (it can send the receipt).
    if (row.id !== id || row.sid === skipSid || !coveredBy(decision, row)) continue;
    const pins = row.ci?.pins;
    if (verdict === "approve" && pins !== undefined && !isPinned(rules, row.ci!.rule, pins)) continue;
    const files = new SessionFiles(mesh, row.sid, env);
    // A file is fetched by the session itself when it next runs: nothing is downloaded here.
    const later = (await files.isLiveElsewhere()) || (verdict === "approve" && row.fileInfo !== undefined);
    const box = new HeldBox(files.heldDir, env);
    if (later && decision !== undefined) await box.leaveDecision(decision);
    else if (later) await box.mark(id, verdict);
    else await new OfflineSession(files, config, env, now).run((o) => o.apply(row, verdict));
    n++;
  }
  return n;
}

/**
 * Lifts a breaker pause on `peer` in every session, releasing what the breaker held. A session
 * another process runs gets a marker and does it itself; for any other, this takes the session's
 * liveness lock while it edits the files, so a session that starts meanwhile does not take back a
 * pause this is removing.
 */
export async function resumeEverywhere(mesh: MeshFiles, peer: string, env: FsEnv, now: () => number, skipSid?: string, decision?: Decision): Promise<number> {
  let released = 0;
  const config = await mesh.loadConfig();
  const device = peer.split("@")[1];
  for (const sid of (await listSessions(mesh)).filter((s) => s !== skipSid)) {
    const files = new SessionFiles(mesh, sid, env);
    // This process may run the session itself (a UI's events process): it holds the lock already.
    const ours = await files.holds();
    if (!ours && !(await files.claim())) {
      // With the keys in the signer, the session gets the signed resume; a marker would be refused.
      if (decision !== undefined) await new HeldBox(files.heldDir, env).leaveDecision(decision);
      else await writeAtomic(join(files.controlDir, `resume-${peer}`), "", env);
      continue;
    }
    try {
      released += await resumeOffline(files, device!, config, env, now, decision);
    } finally {
      if (!ours) await files.release();
    }
  }
  return released;
}

/**
 * The resume in one session no process runs. Its pauses on that device are over too (with a signed
 * resume, those that started by its time), so `wim held
 * list` stops showing them, the sessions told hear it lifted from the session's next process, and
 * the device's counts start over. Every other pause stays as written, a cool-down that ended
 * included: the next process releases it.
 */
async function resumeOffline(files: SessionFiles, device: string, config: MeshConfig, env: FsEnv, now: () => number, decision: Decision | undefined): Promise<number> {
  const box = new HeldBox(files.heldDir, env);
  // The breaker counts per sender device, so a resume releases that device's held items: with a
  // signed resume, only those it covers (what the person was shown).
  const items = (await box.list()).filter((item) => item.from.split("@")[1] === device && item.reason === "breaker" && (decision === undefined || covers(decision, item)));
  const file = await readBreakerFile(files.breakerPath);
  // A signed resume lifts only the pauses that started by its time: a copy played later lifts none that came after.
  const resumed = file.pauses.filter((p) => p.from.split("@")[1] === device && (decision === undefined || p.at <= decision.at));
  const ids = new Set([...resumed.map((p) => p.peer), ...(decision === undefined ? items.map((i) => i.device) : [])]);
  await savePauses(
    files.breakerPath,
    {
      pauses: file.pauses.filter((p) => !resumed.includes(p)),
      released: Object.fromEntries(Object.entries(file.released).filter(([id]) => !ids.has(id))),
      lifts: [...new Set([...file.lifts, ...resumed.flatMap((p) => p.told)])],
      counts: Object.fromEntries(Object.entries(file.counts).filter(([id]) => !ids.has(id))),
      wakes: Object.fromEntries(Object.entries(file.wakes).filter(([id]) => !ids.has(id))),
    },
    env,
  );
  await new OfflineSession(files, config, env, now).run(async (offline) => {
    for (const item of items) {
      if (item.fileInfo !== undefined && decision !== undefined) await box.leaveDecision(decision);
      else if (item.fileInfo !== undefined) await box.mark(item.id, "approve");
      else await offline.apply(item, "approve");
    }
  });
  return items.length;
}

/**
 * The mark files in this mesh's sessions that carry a decision without a signature: `held/<id>.approve`,
 * `.refuse` and `.resume`, and `control/resume-<peer>`. With the keys in the signer every one is
 * refused (`wim doctor` lists them); paths relative to the mesh directory.
 */
export async function unsignedMarks(mesh: MeshFiles, env: FsEnv): Promise<string[]> {
  const out: string[] = [];
  for (const sid of await listSessions(mesh)) {
    const files = new SessionFiles(mesh, sid, env);
    for (const name of await listFiles(files.heldDir)) if (/^[0-9A-Z]{26}\.(approve|refuse|resume)$/.test(name)) out.push(relative(mesh.dir, join(files.heldDir, name)));
    for (const name of await listFiles(files.controlDir)) if (name.startsWith("resume-") && !name.endsWith(".tmp")) out.push(relative(mesh.dir, join(files.controlDir, name)));
  }
  return out.sort();
}
