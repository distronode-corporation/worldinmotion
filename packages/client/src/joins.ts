// The admin side of adding a device (SPEC section 5): the invite records, the checks a join
// request passes before a person is asked about it, the comparison code the person types, and
// the join requests an admin device keeps on disk until the person admits one
// (`wim devices pending`, `wim devices admit`).

import { b64u, isVectorKey, sasFor, verifyJoin, type JoinBody, type JoinDevice, type Roster } from "@worldinmotion/protocol";
import { join } from "node:path";
import { listFiles, readJson, removeFile, tryRemove, writeJson, type FsEnv } from "./fsx.ts";
import type { MeshFiles } from "./mesh.ts";

export type InviteRecord = {
  v: 1;
  id: string;
  exp: number;
  /** Recorded on this device only, never in the code (SPEC section 5). */
  auto: boolean;
  used: boolean;
  created: number;
  /** b64u; deleted once the invite is used or expired. */
  secret?: string;
};

/** The invite records of a mesh, with expired secrets deleted as they are found. */
export class Invites {
  private readonly files: MeshFiles;
  private readonly env: FsEnv;
  private readonly now: () => number;
  constructor(files: MeshFiles, env: FsEnv, now: () => number) {
    this.files = files;
    this.env = env;
    this.now = now;
  }

  private path(id: string): string {
    return join(this.files.invitesDir, `${id}.json`);
  }

  async get(id: string): Promise<InviteRecord | undefined> {
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return undefined;
    const raw = (await readJson(this.path(id))) as InviteRecord | undefined;
    if (raw === undefined) return undefined;
    if (raw.exp <= this.now() && raw.secret !== undefined) {
      const { secret: _s, ...rest } = raw;
      await writeJson(this.path(id), rest, this.env);
      return rest;
    }
    return raw;
  }

  async put(r: InviteRecord): Promise<void> {
    await writeJson(this.path(r.id), r, this.env);
  }

  /** Marks an invite used and deletes its secret (SPEC section 5). */
  async markUsed(id: string): Promise<void> {
    const r = await this.get(id);
    if (r === undefined) return;
    const { secret: _s, ...rest } = r;
    await this.put({ ...rest, used: true });
  }

  async remove(id: string): Promise<void> {
    await removeFile(this.path(id));
  }
}

/** What a join request is to this admin device, before any person is asked. */
export type Screened =
  | { outcome: "ignored" | "refused"; reason: string }
  | { outcome: "ok"; record: InviteRecord; device: JoinDevice; sas: string };

/**
 * The checks of SPEC section 5 that need no person: an invite this device issued, unused and
 * unexpired by its own clock; proof, signature and id; no published test-vector key; the name
 * free and the device new to the mesh.
 */
export async function screenJoin(invites: Invites, roster: Roster, body: JoinBody, now: number): Promise<Screened> {
  const record = await invites.get(body.invite);
  if (record === undefined) return { outcome: "ignored", reason: "not an invite this device issued" };
  if (record.used) return { outcome: "refused", reason: "the invite was already used" };
  if (record.exp <= now || record.secret === undefined) return { outcome: "refused", reason: "the invite has expired" };
  const v = verifyJoin(body, b64u.decode(record.secret));
  if (!v.ok) return { outcome: "refused", reason: v.reason };
  const device = v.value.device;
  // The published test vectors' secrets are public (SPEC section 16).
  if ([device.sign, device.box].some(isVectorKey)) return { outcome: "refused", reason: "the device holds a published test-vector key" };
  if (roster.devices.some((d) => d.name === device.name)) return { outcome: "refused", reason: `the name ${device.name} is taken` };
  if (roster.devices.some((d) => d.id === device.id) || roster.revoked.includes(device.id)) return { outcome: "refused", reason: "that device is already known" };
  return { outcome: "ok", record, device, sas: sasFor(device) };
}

/**
 * Whether what the person typed is the comparison code `sas` (`XXXXX-XXXXX`). Case, dashes and
 * spaces do not count, and the letters Crockford base32 leaves out read as the digits they look
 * like (I and L as 1, O as 0).
 */
export function sameCode(typed: string, sas: string): boolean {
  const norm = (s: string): string => s.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return norm(typed) === norm(sas);
}

/** A join request kept on disk for the person: never its comparison code, which the person types. */
export type PendingRow = { name: string; id: string; invite: string; at: number; exp: number };

type PendingFile = { v: 1; at: number; exp: number; body: JoinBody };

/** At most this many join requests wait on one device; the oldest goes first. */
export const PENDING_MAX = 16;

/**
 * Join requests this admin device received and screened, kept until a person admits one or its
 * invite is used or expires. Every session of the device writes here, so a request that arrived
 * while nobody was at `wim invite` is still there for `wim devices admit`.
 */
export class PendingJoins {
  private readonly files: MeshFiles;
  private readonly env: FsEnv;

  constructor(files: MeshFiles, env: FsEnv) {
    this.files = files;
    this.env = env;
  }

  private path(invite: string, device: string): string {
    return join(this.files.joinsDir, `${invite}.${device}.json`);
  }

  /** Keeps a screened request. True when it was not kept before. */
  async save(body: JoinBody, exp: number, now: number): Promise<boolean> {
    const path = this.path(body.invite, body.device.id);
    const fresh = (await readJson(path).catch(() => undefined)) === undefined;
    await writeJson(path, { v: 1, at: now, exp, body } satisfies PendingFile, this.env);
    const names = (await this.entries()).sort((x, y) => x.file.at - y.file.at).map((e) => e.name);
    for (const name of names.slice(0, Math.max(0, names.length - PENDING_MAX))) await tryRemove(join(this.files.joinsDir, name), this.env);
    return fresh;
  }

  private async entries(): Promise<Array<{ name: string; file: PendingFile }>> {
    const out: Array<{ name: string; file: PendingFile }> = [];
    for (const name of await listFiles(this.files.joinsDir)) {
      if (!name.endsWith(".json")) continue;
      const file = (await readJson(join(this.files.joinsDir, name)).catch(() => undefined)) as PendingFile | undefined;
      // A request is checked again when it is admitted; here it only has to read.
      if (typeof file?.at !== "number" || typeof file.exp !== "number" || verifyJoin(file.body).ok !== true) await tryRemove(join(this.files.joinsDir, name), this.env);
      else out.push({ name, file });
    }
    return out;
  }

  /**
   * The requests still waiting, oldest first, with their bodies. Dropped as they are found: one
   * whose invite expired or was used, and one whose device the roster already lists or revoked.
   */
  async list(roster: Roster, invites: Invites, now: number): Promise<Array<PendingRow & { body: JoinBody }>> {
    const rows: Array<PendingRow & { body: JoinBody }> = [];
    for (const { name, file } of await this.entries()) {
      const d = file.body.device;
      const known = roster.devices.some((x) => x.id === d.id) || roster.revoked.includes(d.id);
      const live = file.exp > now && (await invites.get(file.body.invite))?.used === false;
      if (known || !live) await tryRemove(join(this.files.joinsDir, name), this.env);
      else rows.push({ name: d.name, id: d.id, invite: file.body.invite, at: file.at, exp: file.exp, body: file.body });
    }
    return rows.sort((x, y) => x.at - y.at);
  }

  /** Drops every request on an invite (it was used), or one device's request on it. */
  async remove(invite: string, device?: string): Promise<void> {
    for (const name of await listFiles(this.files.joinsDir)) {
      if (name.startsWith(`${invite}.${device ?? ""}`)) await tryRemove(join(this.files.joinsDir, name), this.env);
    }
  }
}
