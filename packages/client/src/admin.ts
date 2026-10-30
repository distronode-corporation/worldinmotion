// Membership: creating a mesh, invites and the admin's decision on a join (with the person's
// SAS confirmation), joining, and revocation. Roster signing is serialised by a lock file.

import {
  admitJoin,
  b64u,
  CLOSE,
  createGenesisRosterWith,
  createRecoveryIdentity,
  createRecoveryKeys,
  recoveryCode as makeRecoveryCode,
  verifyRecoveryChain,
  parseRecoveryCode,
  createInvite,
  createJoinWith,
  hash,
  nextRoster,
  parseInvite,
  randomBytes,
  relayDialUrl,
  rosterRef,
  nextRosterWith,
  sasFor,
  signAuthWith,
  signRecoverAuth,
  ulid,
  verifyRosterChain,
  recoverySummary,
  deviceIdFromSignPub as deviceIdOf,
  isRecoveryName,
  isVectorKey,
  type JoinBody,
  type JoinedFrame,
  type ErrorFrame,
  type RecoverReadyFrame,
  type RelayFrame,
  type Roster,
} from "@worldinmotion/protocol";
import { join } from "node:path";
import { withLock } from "./fsx.ts";
import { Invites, PendingJoins, sameCode, screenJoin } from "./joins.ts";
import { SetupError, type Device, type Home } from "./home.ts";
import { DEFAULT_BREAKER, MeshFiles, type MeshConfig } from "./mesh.ts";
import { ClientError, relayRefusal, type MeshSession } from "./client.ts";
import { authRefusal, checkDialable, errorFor, Link, relayCode, type Dialer } from "./wire.ts";

export type RecoverySummary = ReturnType<typeof recoverySummary>;

export { Invites, type InviteRecord } from "./joins.ts";

function newConfig(mesh: string, relay: string, device: string, roster: Roster, tls?: string): MeshConfig {
  return { v: 1, mesh, relay, device, pin: rosterRef(roster), policy: {}, breaker: DEFAULT_BREAKER, share_cards: true, ...(tls === undefined ? {} : { tls }) };
}

/** A session `auth` for a one-off connection that only proves this device can connect, then says bye. */
function probeAuth(o: { relay: string; mesh: string; nonce: string; now: number; pin: Roster; device: Device }) {
  return signAuthWith(
    { relay: o.relay, mesh: o.mesh, nonce: o.nonce, at: o.now, session: { name: "create", kind: "cli", sid: ulid(), resume: b64u.encode(randomBytes(32)) }, pin: rosterRef(o.pin) },
    o.device.keyring,
  );
}

/**
 * Creates a mesh with this device as its first admin (SPEC section 11). Before anything is saved
 * here, the same connection authenticates as this device: a relay that routes this URL but
 * signs in under another spelling of it (`localhost` for `127.0.0.1`, a proxy's host name)
 * refuses that, and a mesh saved anyway could never connect.
 */
export async function createMesh(o: {
  home: Home;
  device: Device;
  relay: string;
  key?: string;
  dialer: Dialer;
  now: () => number;
  tls?: string;
  recovery?: boolean;
}): Promise<{ mesh: string; roster: Roster; recoveryCode?: string }> {
  checkDialable(o.relay, o.tls);
  const meshId = b64u.encode(randomBytes(16));
  // The recovery identity (SPEC section 4a): its code is returned once and never written down here.
  const recovery = o.recovery === false ? undefined : createRecoveryKeys(meshId, { now: o.now() });
  const genesis = await createGenesisRosterWith({ name: o.device.name, keyring: o.device.keyring, now: o.now(), meshId, ...(recovery === undefined ? {} : { recovery: recovery.record }) });
  const { link, hello } = await Link.open(o.dialer, relayDialUrl(o.relay, genesis.mesh), o.tls === undefined ? {} : { tlsPin: o.tls });
  try {
    const answer = await link.request({ t: "create", roster: genesis, ...(o.key === undefined ? {} : { key: o.key }) }, (f) => f.t === "roster" || errorFor("create")(f), 15_000);
    if (answer.t === "error") throw relayRefusal("the relay refused to create the mesh", answer);
    const auth = await probeAuth({ relay: o.relay, mesh: genesis.mesh, nonce: hello.nonce, now: o.now(), pin: genesis, device: o.device });
    const ready = await link.request(auth, (f) => f.t === "ready" || errorFor("auth")(f), 15_000);
    if (ready.t !== "ready") {
      throw new ClientError(`the relay created the mesh but refused this device's authentication: ${authRefusal(ready as ErrorFrame) ?? `code ${relayCode((ready as ErrorFrame).code)}`}. Nothing was saved on this device`, "auth_refused");
    }
    link.send({ t: "bye", ended: true });
    const files = new MeshFiles(o.home.meshDir(genesis.mesh), o.home.env);
    await files.createConfig(newConfig(genesis.mesh, o.relay, o.device.id, genesis, o.tls), [genesis]);
    // The code pins this genesis (revision 4, H3), so it can only be made now.
    const recoveryCode = recovery === undefined ? undefined : makeRecoveryCode(recovery.keys, { mesh: meshId, genesis: hash(genesis) });
    return { mesh: genesis.mesh, roster: genesis, ...(recoveryCode === undefined ? {} : { recoveryCode }) };
  } finally {
    link.close();
  }
}

/** Issues an invite from an admin session and registers its id and expiry with the relay. */
export async function issueInvite(session: MeshSession, o: { ttlMs: number; auto: boolean; now: () => number }): Promise<{ code: string; inviteId: string; exp: number }> {
  const me = session.roster.devices.find((d) => d.id === session.device.id);
  if (me?.role !== "admin") throw new ClientError("only an admin device can invite", "not_admin");
  const now = o.now();
  const tls = session.config.tls;
  const invite = createInvite({ relay: session.config.relay, mesh: session.config.mesh, pin: rosterRef(session.roster), exp: now + o.ttlMs, now, ...(tls === undefined ? {} : { tls }) });
  const invites = new Invites(session.mesh, session.files.env, o.now);
  await invites.put({ v: 1, id: invite.inviteId, exp: invite.exp, auto: o.auto, used: false, created: now, secret: b64u.encode(invite.secret) });
  const link = await session.ready();
  const refused = await link.request(
    { t: "invite.create", invite: invite.inviteId, exp: invite.exp },
    (f) => (f.t === "invite.created" && f.invite === invite.inviteId) || errorFor("invite.create")(f),
    10_000,
  );
  if (refused.t === "error") {
    await invites.remove(invite.inviteId);
    throw relayRefusal("the relay refused the invite", refused);
  }
  return { code: invite.code, inviteId: invite.inviteId, exp: invite.exp };
}

export type JoinPrompt = { name: string; id: string; sas: string };

export type JoinDecision = { outcome: "admitted" | "refused" | "ignored"; reason?: string; name?: string };

/**
 * The admin's side of a join (SPEC section 5): only an invite this device issued, unused and
 * unexpired by its own clock; proof, signature and id checked; the name free; then the person
 * confirms the SAS unless the invite was created with auto-accept.
 */
export async function decideJoin(session: MeshSession, body: JoinBody, confirm: (p: JoinPrompt) => Promise<boolean>, now: () => number): Promise<JoinDecision> {
  const invites = new Invites(session.mesh, session.files.env, now);
  const screened = await screenJoin(invites, session.roster, body, now());
  if (screened.outcome !== "ok") return screened;
  const { record, device, sas } = screened;
  if (!record.auto && !(await confirm({ name: device.name, id: device.id, sas }))) return { outcome: "refused", reason: "the person did not confirm", name: device.name };
  await publishRoster(session, (current) => nextRosterWith(current, { add: [admitJoin(device, now())] }, session.device.keyring, now()));
  await invites.markUsed(record.id);
  // Other requests on this invite (someone else's who also held the code) can never be admitted now.
  await new PendingJoins(session.mesh, session.files.env).remove(record.id);
  return { outcome: "admitted", name: device.name };
}

/**
 * Admits a device waiting to join (`wim devices admit`, a local UI's `admit`): the request from a
 * device named `name` whose comparison code is the one the person typed, read from the new
 * device's screen. The typed code picks the request, so one from a device that only took the same
 * name is never admitted, and an invite made with `--auto` gets no exception here.
 */
export async function admitPending(session: MeshSession, name: string, typed: string, now: () => number): Promise<JoinDecision> {
  const invites = new Invites(session.mesh, session.files.env, now);
  const waiting = (await new PendingJoins(session.mesh, session.files.env).list(session.roster, invites, now())).filter((p) => p.name === name);
  if (waiting.length === 0) throw new ClientError(`no device named ${name} is waiting to join`, "not_found");
  const match = waiting.find((p) => sameCode(typed, sasFor(p.body.device)));
  if (match === undefined) {
    throw new ClientError(
      `that is not the comparison code of ${name}'s request. Check the code on the new device; if it shows another one, the request is not from it, so do not admit it`,
      "mismatch",
    );
  }
  return decideJoin(session, match.body, async () => true, now);
}

/** Signs and publishes the next roster under the device's signing lock (SPEC section 4). */
export async function publishRoster(session: MeshSession, make: (current: Roster) => Roster | Promise<Roster>): Promise<Roster> {
  return withLock(session.mesh.rosterLock, async () => {
    await session.book.reload();
    const next = await make(session.roster);
    const h = hash(next);
    const link = await session.ready();
    const answer = (await link.request(
      { t: "roster.publish", roster: next },
      (f) => (f.t === "roster" && f.chain.some((r) => hash(r) === h)) || errorFor("roster.publish")(f),
      15_000,
    )) as RelayFrame;
    if (answer.t === "error") throw relayRefusal("the relay refused the roster", answer);
    const accepted = await session.book.accept([next]);
    if (!accepted.ok) throw new ClientError(`the new roster did not verify here: ${accepted.reason}`, accepted.reason);
    return next;
  }, session.files.env);
}

/** Revokes a device by name (admins only). */
export async function revokeDevice(session: MeshSession, name: string, now: () => number): Promise<Roster> {
  const target = session.roster.devices.find((d) => d.name === name);
  if (target === undefined) throw new ClientError(`no device named ${name}`, "not_found");
  if (target.id === session.device.id) throw new ClientError("a device cannot revoke itself", "invalid");
  return publishRoster(session, (current) => nextRosterWith(current, { revoke: [target.id] }, session.device.keyring, now()));
}

/**
 * Joins a mesh with an invite code (SPEC section 5): shows the SAS, waits for an admin to admit
 * this device, verifies the chain from the code's pin, and checks its own record is in the
 * newest roster before saving anything.
 */
export async function joinMesh(o: {
  home: Home;
  device: Device;
  code: string;
  dialer: Dialer;
  now: () => number;
  showSas: (sas: string) => void;
  waitMs?: number;
}): Promise<{ mesh: string; roster: Roster }> {
  const invite = parseInvite(o.code);
  const tls = invite.tls;
  checkDialable(invite.relay, tls);
  if ((await o.home.meshIds()).includes(invite.mesh)) throw new SetupError("this device is already in that mesh");
  const { link, hello } = await Link.open(o.dialer, relayDialUrl(invite.relay, invite.mesh), tls === undefined ? {} : { tlsPin: tls });
  try {
    const frame = await createJoinWith(invite, o.device.name, o.device.keyring, hello.nonce);
    o.showSas(sasFor(frame.device));
    const wait = Math.max(1000, Math.min(o.waitMs ?? Infinity, invite.exp - o.now()));
    const answer = (await link.request(frame, (f) => f.t === "joined" || errorFor("join")(f), wait)) as RelayFrame;
    if (answer.t === "error") throw relayRefusal("the join was refused", answer);
    const chain: Roster[] = [...(answer as JoinedFrame).chain];
    const first = verifyRosterChain(invite.pin, chain);
    if (!first.ok) throw new ClientError(`the relay's roster chain does not start at the invite's pin (${first.reason})`, first.reason);
    let newest = first.value;
    if ((answer as JoinedFrame).more) {
      // Authenticate with the newest verified roster as the pin, walk the rest, then end that session.
      newest = await walkAuthenticated(link, hello.nonce, o, invite, chain, newest);
    }
    if (!newest.devices.some((d) => d.id === o.device.id)) throw new ClientError("this device is not in the mesh's newest roster", "not_admitted");
    const files = new MeshFiles(o.home.meshDir(invite.mesh), o.home.env);
    await files.createConfig(newConfig(invite.mesh, invite.relay, o.device.id, newest, tls), chain);
    return { mesh: invite.mesh, roster: newest };
  } finally {
    link.close();
  }
}

async function walkAuthenticated(
  link: Link,
  nonce: string,
  o: { device: Device; now: () => number },
  invite: { relay: string; mesh: string },
  chain: Roster[],
  newest: Roster,
): Promise<Roster> {
  const auth = await signAuthWith(
    {
      relay: invite.relay,
      mesh: invite.mesh,
      nonce,
      at: o.now(),
      session: { name: "join", kind: "cli", sid: ulid(), resume: b64u.encode(randomBytes(32)) },
      pin: rosterRef(newest),
    },
    o.device.keyring,
  );
  const ready = await link.request(auth, (f) => f.t === "ready" || errorFor("auth")(f), 15_000);
  if (ready.t !== "ready") throw new ClientError("the relay refused this device after admitting it", "auth");
  let head = newest;
  for (;;) {
    const page = await link.request({ t: "roster.get", from: head.seq }, (f) => f.t === "roster" || errorFor("roster.get")(f), 15_000);
    if (page.t !== "roster") throw new ClientError("the relay would not serve the roster chain", "roster");
    const step = verifyRosterChain(rosterRef(head), page.chain);
    if (!step.ok) throw new ClientError(`the relay's roster chain does not verify (${step.reason})`, step.reason);
    chain.push(...page.chain.slice(1));
    head = step.value;
    if (!page.more) break;
  }
  link.send({ t: "bye", ended: true });
  return head;
}

/** The name for a new recovery record: `recovery-N`, the lowest N from 2 that no current device has. */
function nextRecoveryName(roster: Roster): string {
  const taken = new Set(roster.devices.map((d) => d.name));
  let n = 2;
  while (taken.has(`recovery-${n}`)) n++;
  return `recovery-${n}`;
}

/**
 * Replaces the mesh's recovery code from an admin device (SPEC section 4a): one roster that
 * revokes every current recovery record and adds a fresh one. Returns the new code, to be shown
 * once. The old code no longer works once the roster is published.
 */
export async function rotateRecovery(session: MeshSession, now: () => number): Promise<{ roster: Roster; recoveryCode: string }> {
  const me = session.roster.devices.find((d) => d.id === session.device.id);
  if (me?.role !== "admin") throw new ClientError("only an admin device can replace the recovery code", "not_admin");
  const genesis = await session.mesh.loadRoster(1);
  if (genesis === undefined) throw new ClientError("this device does not hold the mesh's first roster", "roster");
  const fresh = createRecoveryIdentity(session.config.mesh, { name: nextRecoveryName(session.roster), now: now(), genesis: hash(genesis) });
  try {
    const roster = await publishRoster(session, (current) => {
      const old = current.devices.filter((d) => isRecoveryName(d.name)).map((d) => d.id);
      return nextRosterWith(current, { add: [fresh.record], revoke: old }, session.device.keyring, now());
    });
    return { roster, recoveryCode: fresh.code };
  } finally {
    fresh.keys.signSec.fill(0);
    fresh.keys.boxSec.fill(0);
  }
}

/** Promotes a member to admin (admins only; SPEC section 4). */
export async function promoteDevice(session: MeshSession, name: string, now: () => number): Promise<Roster> {
  const target = session.roster.devices.find((d) => d.name === name);
  if (target === undefined) throw new ClientError(`no device named ${name}`, "not_found");
  if (target.role === "admin") throw new ClientError(`${name} is already an admin`, "invalid");
  return publishRoster(session, (current) => nextRosterWith(current, { promote: [target.id] }, session.device.keyring, now()));
}

/**
 * Recovers admin access with the recovery code (SPEC section 4a): verifies the whole chain from
 * the genesis the code pins, shows the person the newest roster and waits for confirmation, then
 * signs one roster that adds this device as an admin, adds a fresh recovery record, revokes the
 * used one and any devices named in `revoke`. Returns the new recovery code, shown once. The
 * recovery keys live only in memory and are wiped before returning.
 *
 * The chain fetch and the publish need a session the relay accepts. Relays refuse recovery
 * records (revision 4, M2) and wim/1 defines no other way for a device outside the roster to
 * publish, so against such a relay this fails at `auth` with a clear reason (reported as a SPEC
 * gap).
 */
export async function recoverMesh(o: {
  home: Home;
  device: Device;
  code: string;
  relay: string;
  tls?: string;
  revoke: string[];
  dialer: Dialer;
  now: () => number;
  confirm: (summary: RecoverySummary) => Promise<boolean>;
  /** How long to wait for each relay answer. */
  answerMs?: number;
}): Promise<{ mesh: string; roster: Roster; recoveryCode: string }> {
  const answerMs = o.answerMs ?? 15_000;
  const rec = parseRecoveryCode(o.code);
  try {
    // The published test vectors' secrets are public (SPEC section 16).
    if ([rec.signPub, rec.boxPub].some(isVectorKey)) throw new ClientError("refusing a recovery code built from a published test-vector key", "vector_key");
    checkDialable(o.relay, o.tls);
    if ((await o.home.meshIds()).includes(rec.mesh)) throw new SetupError("this device is already in that mesh");
    const recId = deviceIdOf(rec.signPub);
    const { link, hello } = await Link.open(o.dialer, relayDialUrl(o.relay, rec.mesh), o.tls === undefined ? {} : { tlsPin: o.tls });
    try {
      // The recovery connection (SPEC section 4a): no session, only roster.get and one publish.
      const ready = await link.request(
        signRecoverAuth({ relay: o.relay, mesh: rec.mesh, nonce: hello.nonce, at: o.now(), genesis: rec.genesis }, rec),
        (f) => f.t === "recover.ready" || errorFor("auth")(f),
        answerMs,
      );
      if (ready.t !== "recover.ready") throw relayRefusal("the relay refused the recovery connection", ready as ErrorFrame);
      const chain: Roster[] = [];
      for (let from = 1; ; ) {
        const page = await link.request({ t: "roster.get", from }, (f) => f.t === "roster" || errorFor("roster.get")(f), answerMs);
        if (page.t !== "roster") throw relayRefusal("the relay would not serve the roster chain", page as ErrorFrame);
        chain.push(...page.chain.filter((r) => r.seq >= from));
        from = chain.at(-1)!.seq + 1;
        // Walk up to the newest roster the relay named in `recover.ready`.
        if (!page.more || from > (ready as RecoverReadyFrame).roster.seq) break;
      }
      const verified = verifyRecoveryChain(o.code, chain);
      if (!verified.ok) throw new ClientError(`the roster chain does not match this recovery code (${verified.reason})`, verified.reason);
      const current = verified.value;
      if (!(await o.confirm(recoverySummary(chain)))) throw new ClientError("recovery cancelled; nothing was signed", "cancelled");
      const revoke = [recId];
      for (const name of o.revoke) {
        const d = current.devices.find((x) => x.name === name);
        if (d === undefined) throw new ClientError(`no device named ${name}`, "not_found");
        if (d.id !== recId) revoke.push(d.id);
      }
      const fresh = createRecoveryIdentity(rec.mesh, { name: nextRecoveryName(current), now: o.now(), genesis: rec.genesis });
      const me = { ...admitJoin({ id: o.device.id, name: o.device.name, sign: b64u.encode(o.device.keyring.signPub), box: b64u.encode(o.device.keyring.boxPub) }, o.now()), role: "admin" as const };
      const next = nextRoster(current, { add: [me, fresh.record], revoke }, { keys: rec }, o.now());
      // The relay may confirm with the new roster, and then closes the connection with 4000.
      const answer = await link
        .request({ t: "roster.publish", roster: next }, (f) => (f.t === "roster" && f.chain.some((r) => hash(r) === hash(next))) || errorFor("roster.publish")(f), answerMs)
        .catch(async () => (link.isOpen ? undefined : await link.closed));
      if (answer === undefined) throw new ClientError("the relay did not confirm the recovery roster", "unconfirmed");
      if (typeof answer.code === "number" && answer.code !== CLOSE.recovered) throw new ClientError(`the relay closed the recovery connection (${answer.code})`, "closed");
      if ("t" in answer && answer.t === "error") throw relayRefusal("the relay refused the recovery roster", answer);
      const files = new MeshFiles(o.home.meshDir(rec.mesh), o.home.env);
      await files.createConfig(newConfig(rec.mesh, o.relay, o.device.id, next, o.tls), [...chain, next]);
      return { mesh: rec.mesh, roster: next, recoveryCode: fresh.code };
    } finally {
      link.close();
    }
  } finally {
    rec.signSec.fill(0);
    rec.boxSec.fill(0);
  }
}
