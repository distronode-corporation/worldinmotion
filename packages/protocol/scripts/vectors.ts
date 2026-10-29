/*
 * Deterministic test vectors for wim/1 (SPEC section 16). Every random input comes from a fixed,
 * labelled byte stream, so running this twice gives byte-identical files. Another implementation
 * checks itself by reproducing these values exactly.
 *
 * `buildVectors` returns the file contents; `write-vectors.ts` writes them, and
 * `test/vectors.test.ts` regenerates them in memory and compares with the committed files.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import {
  b64u,
  canon,
  canonBytes,
  createGenesisRoster,
  createInvite,
  createJoin,
  createRecoveryKeys,
  deviceIdFromSignPub,
  deviceKeysFromSecrets,
  hash,
  joinProof,
  makeDeviceRecord,
  nextRoster,
  openBlob,
  openMessage,
  parseInvite,
  parseJson,
  parseRecoveryCode,
  recoveryCode,
  sasFor,
  sealBlob,
  sealMessage,
  sha256,
  signObject,
  utf8,
  verifyNextRoster,
  verifyObject,
  verifyRecoveryChain,
  createPrekey,
  prekeyId,
  verifyPrekey,
  type DeviceKeys,
  type Prekey,
  type Roster,
  type SendFrame,
  type SignType,
} from "../src/index.ts";
import { hpkeSealAuth } from "../src/hpke.ts";
import { withRandomSource } from "../src/ids.ts";

const T = 1760000000000;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`vectors: ${what}`);
}

/** A fixed byte stream: SHA-256(label || counter) blocks, concatenated. */
function stream(label: string): (n: number) => Uint8Array {
  let counter = 0;
  let buffer = new Uint8Array(0);
  return (n) => {
    while (buffer.length < n) {
      const block = sha256(utf8(`${label} ${counter++}`));
      const next = new Uint8Array(buffer.length + block.length);
      next.set(buffer);
      next.set(block, buffer.length);
      buffer = next;
    }
    const out = buffer.slice(0, n);
    buffer = buffer.slice(n);
    return out;
  };
}

function fixedKeys(name: string): DeviceKeys {
  return deviceKeysFromSecrets(sha256(utf8(`wim vectors ${name} sign`)), sha256(utf8(`wim vectors ${name} box`)));
}

const MESH = b64u.encode(sha256(utf8("wim vectors mesh")).subarray(0, 16));
const alice = fixedKeys("alice");
const bob = fixedKeys("bob");
const carol = fixedKeys("carol");
const dave = fixedKeys("dave");
const id = (k: DeviceKeys) => deviceIdFromSignPub(k.signPub);

/**
 * Pretty JSON with a trailing newline, in ASCII only: everything from DEL up is written as a JSON
 * escape, so no invisible or non-ASCII character lands in a committed file. Parsing gives the same
 * values either way.
 */
function json(value: unknown): string {
  const text = JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `${text}\n`;
}

function canonVectors() {
  const valid: Array<[string, string]> = [
    ['{"b":1,"a":2}', ""],
    ['{"\\ue000":1,"\\ud83d\\ude00":2,"a":3,"A":4,"_":5,"1":6}', ""],
    ['"\\u0001\\b\\f\\n\\r\\t\\"\\\\/\\u007f\\u00e9\\u4e2d"', ""],
    ["[-0,0,1,-9007199254740991,9007199254740991]", ""],
    ['{"z":{"y":[3,{"b":null,"a":true}]},"a":"x","e":false}', ""],
    ['{ "a" : [ 1 , 2 ] ,\n "b" : { } , "c" : [ ] }', ""],
    ['"caf\\u0065\\u0301 vs caf\\u00e9"', ""],
  ];
  const out = valid.map(([input]) => {
    const parsed = parseJson(input);
    check(parsed.ok, `canon input parses: ${input}`);
    return { json: input, canon: canon((parsed as { value: unknown }).value) };
  });
  const invalid: Array<{ json: string; reason: string }> = [
    { json: "1.5", reason: "not an integer" },
    { json: "9007199254740992", reason: "outside the safe integer range" },
    { json: "-9007199254740992", reason: "outside the safe integer range" },
    { json: '{"a":0.1}', reason: "not an integer" },
    { json: '"\\ud800"', reason: "unpaired surrogate" },
    { json: '["a\\udc00b"]', reason: "unpaired surrogate" },
    { json: '{"a":1,"a":2}', reason: "duplicate key (refused by the JSON parser)" },
    { json: '{"a":1,"\\u0061":2}', reason: "duplicate key after unescaping (refused by the JSON parser)" },
    { json: "[".repeat(65) + "]".repeat(65), reason: "nesting deeper than 64" },
  ];
  for (const v of invalid) {
    const parsed = parseJson(v.json);
    let refused = !parsed.ok;
    if (parsed.ok) {
      try {
        canon(parsed.value);
      } catch {
        refused = true;
      }
    }
    check(refused, `canon refuses ${v.json.slice(0, 20)}`);
  }
  return {
    description: "Each valid `json` text, parsed (refusing duplicate keys), encodes to `canon`. Each invalid one is refused.",
    valid: out,
    invalid,
    not_representable_in_json: [
      "NaN and the infinities",
      "undefined inside an array, and sparse arrays",
      "bigint, functions and symbols",
      "objects that are not plain (dates, maps, typed arrays, class instances) or have symbol keys",
      "cyclic values",
    ],
  };
}

function b64uVectors() {
  const inputs = ["", "66", "666f", "666f6f", "666f6f62", "666f6f6261", "666f6f626172", "fbff", "00", "ffffffff"];
  const valid = inputs.map((h) => {
    const bytes = new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
    return { hex: h, b64u: b64u.encode(bytes) };
  });
  const invalid = [
    { b64u: "Z", reason: "impossible length" },
    { b64u: "Zg==", reason: "padding" },
    { b64u: "Zm+v", reason: "standard alphabet character" },
    { b64u: "Zm/v", reason: "standard alphabet character" },
    { b64u: "Zh", reason: "non-zero trailing bits" },
    { b64u: "Zm9", reason: "non-zero trailing bits" },
    { b64u: " Zg", reason: "whitespace" },
    { b64u: "Zg\n", reason: "whitespace" },
  ];
  for (const v of invalid) {
    let refused = false;
    try {
      b64u.decode(v.b64u);
    } catch {
      refused = true;
    }
    check(refused, `b64u refuses ${JSON.stringify(v.b64u)}`);
  }
  return { description: "base64url without padding; decoders accept only the canonical form.", valid, invalid };
}

function keysVectors() {
  return {
    description: "Ed25519 seed and X25519 secret to public keys and device id (b64u(SHA-256(signPub)), first 22 characters).",
    keys: Object.entries({ alice, bob, carol, dave }).map(([name, k]) => ({
      name,
      signSec: hex(k.signSec),
      boxSec: hex(k.boxSec),
      signPub: b64u.encode(k.signPub),
      boxPub: b64u.encode(k.boxPub),
      id: id(k),
    })),
  };
}

function signVectors() {
  const objects: Record<SignType, Record<string, unknown>> = {
    roster: { mesh: MESH, seq: 1, prev: null, devices: [], revoked: [], by: id(alice), at: T },
    send: { t: "send", id: "01K70000000000000000005E0D", seq: 1, at: T },
    auth: { t: "auth", v: 1, relay: "wss://relay.example", at: T },
    join: { t: "join", mesh: MESH, invite: "AAAAAAAAAAAAAAAAAAAAAA" },
    prekey: { mesh: MESH, device: id(alice), id: "AAAAAAAAAAAAAAAAAAAAAA", at: T, until: T + 2 * 86400000 },
  };
  const cases = (Object.keys(objects) as SignType[]).map((type) => {
    const signed = signObject(type, objects[type]!, alice.signSec);
    const bytes = new Uint8Array([...utf8(`wim/1 ${type}\n`), ...canonBytes(objects[type])]);
    check(ed25519.verify(b64u.decode(signed.sig), bytes, alice.signPub), `sign ${type}`);
    return { type, signer: "alice", object: objects[type], signed_bytes_utf8: new TextDecoder().decode(bytes), sig: signed.sig };
  });
  const send = signObject("send", objects.send, alice.signSec);
  const tampered = [
    { type: "send", object: { ...objects.send, seq: 2 }, sig: send.sig, why: "object changed after signing" },
    { type: "auth", object: objects.send, sig: send.sig, why: "signature of another type" },
    { type: "send", object: objects.send, sig: signObject("send", objects.send, bob.signSec).sig, why: "signed by bob, checked against alice" },
  ];
  for (const t of tampered) check(!verifyObject(t.type as SignType, { ...t.object, sig: t.sig }, alice.signPub), `tamper ${t.why}`);
  return {
    description: "Ed25519 over UTF-8('wim/1 ' + type + '\\n') followed by canon(object without sig). Every tampered case must fail against alice's key.",
    cases,
    tampered: tampered.map((t) => ({ ...t, valid: false })),
  };
}

function boxVectors() {
  const header = {
    t: "send",
    mesh: MESH,
    id: "01K70000000000000000000B01",
    from: { device: id(alice), session: "writer", sid: "01K700000000000000000005D1" },
    to: ["reviewer@bob"],
    seq: 1,
    at: T,
    roster: { seq: 1, hash: b64u.encode(sha256(utf8("wim vectors roster ref"))) },
  };
  const plaintext = canon({ v: 1, kind: "msg", id: header.id, from: header.from, to: header.to, at: T, roster: header.roster, text: "hello" });
  const nonce = sha256(utf8("wim vectors box nonce")).subarray(0, 24);
  const shared = x25519.getSharedSecret(alice.boxSec, bob.boxPub);
  const key = hkdf(nobleSha256, shared, utf8(MESH), utf8(`wim/1 box ${id(alice)} ${id(bob)}`), 32);
  const aad = sha256(canonBytes(header));
  const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(utf8(plaintext));
  return {
    description: "One box: X25519(alice box secret, bob box public), HKDF-SHA256(salt = mesh id, info = 'wim/1 box ' + sender id + ' ' + recipient id), XChaCha20-Poly1305 with AAD = SHA-256(canon(header)).",
    sender: "alice",
    recipient: "bob",
    mesh: MESH,
    header,
    nonce: b64u.encode(nonce),
    shared_secret: b64u.encode(shared),
    box_key: b64u.encode(key),
    aad: b64u.encode(aad),
    plaintext,
    ciphertext: b64u.encode(ciphertext),
  };
}

function rosterVectors() {
  return withRandomSource(stream("wim vectors roster"), () => {
    const recoveryKeys = createRecoveryKeys(MESH, { now: T });
    const genesis = createGenesisRoster({ name: "alice", keys: alice, now: T, meshId: MESH, recovery: recoveryKeys.record });
    const recovery = { record: recoveryKeys.record, code: recoveryCode(recoveryKeys.keys, { mesh: MESH, genesis: hash(genesis) }) };
    const r2 = nextRoster(genesis, { add: [makeDeviceRecord("bob", bob, "member", T + 1)] }, { keys: alice }, T + 1);
    const r3 = nextRoster(r2, { promote: [id(bob)] }, { keys: alice }, T + 2);
    const r4 = nextRoster(r3, { add: [makeDeviceRecord("carol", carol, "member", T + 3)], revoke: [id(alice)] }, { keys: bob }, T + 3);
    const r5 = nextRoster(r4, { add: [makeDeviceRecord("dave", dave, "admin", T + 4)] }, { keys: parseRecoveryCode(recovery.code, MESH) }, T + 4);
    const chain: Roster[] = [genesis, r2, r3, r4, r5];
    check(verifyRecoveryChain(recovery.code, chain.slice(0, 4)).ok, "recovery chain");
    for (let i = 1; i < chain.length; i++) check(verifyNextRoster(chain[i - 1]!, chain[i]).ok, `roster step ${i}`);

    const resign = (r: Record<string, unknown>, k: DeviceKeys) => signObject("roster", r, k.signSec);
    const base = { ...r3, seq: r3.seq + 1, prev: hash(r3), by: id(bob), at: T + 9 };
    const invalid = [
      { prev: 3, roster: resign({ ...base, seq: 5 }, bob), reason: "roster_wrong_seq" },
      { prev: 3, roster: resign({ ...base, prev: hash(r2) }, bob), reason: "roster_wrong_prev" },
      { prev: 3, roster: resign({ ...base, by: id(carol) }, carol), reason: "roster_signer_not_admin" },
      { prev: 3, roster: { ...resign(base, bob), at: T + 10 }, reason: "roster_bad_signature" },
      {
        prev: 3,
        roster: resign({ ...base, devices: r3.devices.map((d) => (d.id === id(alice) ? { ...d, role: "member" } : d)) }, bob),
        reason: "roster_device_changed",
      },
      { prev: 4, roster: resign({ ...r4, seq: 5, prev: hash(r4), revoked: [], at: T + 9 }, bob), reason: "roster_revocation_undone" },
      {
        prev: 3,
        roster: resign({ ...base, devices: r3.devices.filter((d) => d.id !== id(alice)) }, bob),
        reason: "roster_device_dropped",
      },
    ];
    for (const v of invalid) {
      const result = verifyNextRoster(chain[v.prev - 1]!, v.roster);
      check(!result.ok && result.reason === v.reason, `roster invalid ${v.reason}: got ${JSON.stringify(result).slice(0, 80)}`);
    }
    return {
      description: "A chain: genesis (alice plus a recovery record), add bob, promote bob, bob adds carol and revokes alice, the recovery identity adds dave as admin. Each invalid successor is checked against roster `prev` (a seq in the chain) and must fail with `reason`.",
      recovery: { code: recovery.code, record: recovery.record },
      chain: chain.map((r) => ({ roster: r, hash: hash(r) })),
      invalid,
    };
  });
}

function inviteVectors() {
  return withRandomSource(stream("wim vectors invite"), () => {
    const pin = { seq: 1, hash: b64u.encode(sha256(utf8("wim vectors roster ref"))) };
    const tls = b64u.encode(sha256(utf8("wim vectors spki")));
    const invite = createInvite({ relay: "wss://relay.example", mesh: MESH, pin, exp: T + 3600000, now: T, tls });
    const code = parseInvite(invite.code);
    const helloNonce = b64u.encode(sha256(utf8("wim vectors hello nonce")));
    const join = createJoin(code, "carol", carol, helloNonce);
    check(join.proof === joinProof(invite.secret, join.device), "join proof");
    return {
      description: "An invite code with a TLS pin, its id, and carol's join on a connection whose hello nonce is join.nonce: proof = HMAC-SHA256(secret, canon(device)), sig of type join over { t, mesh, invite, device, nonce }, and the short authentication string.",
      secret: b64u.encode(invite.secret),
      code: invite.code,
      decoded: { relay: code.relay, mesh: code.mesh, pin: code.pin, exp: code.exp, tls: code.tls },
      invite_id: invite.inviteId,
      join,
      sas: sasFor(join.device),
    };
  });
}

function messageVectors() {
  return withRandomSource(stream("wim vectors message"), () => {
    const genesis = createGenesisRoster({ name: "alice", keys: alice, now: T, meshId: MESH });
    const roster = nextRoster(genesis, { add: [makeDeviceRecord("bob", bob, "member", T)] }, { keys: alice }, T);
    const frame = sealMessage({
      roster,
      sender: { deviceId: id(alice), keys: alice },
      session: "writer",
      sid: "01K700000000000000000005D1",
      to: ["reviewer@bob"],
      seq: 1,
      at: T,
      id: "01K700000000000000000005G1",
      text: "please review the diff",
      recipients: [id(bob)],
    });
    const me = { deviceId: id(bob), keys: bob, address: "reviewer@bob", sid: "01K700000000000000000005D2" };
    const opened = openMessage(frame, { roster, me, now: T });
    check(opened.ok, "message opens");
    const resigned = (f: Record<string, unknown>) => signObject("send", f, alice.signSec) as SendFrame;
    const box = frame.boxes[id(bob)]!;
    const flipped = b64u.decode(box.c);
    flipped[0]! ^= 1;
    const tampers: Array<{ why: string; frame: unknown; reason: string; now?: number; address?: string }> = [
      { why: "header changed", frame: { ...frame, seq: 2 }, reason: "bad_signature" },
      { why: "header changed and re-signed", frame: resigned({ ...frame, seq: 2 }), reason: "decrypt_failed" },
      { why: "ciphertext altered and re-signed", frame: resigned({ ...frame, boxes: { [id(bob)]: { ...box, c: b64u.encode(flipped) } } }), reason: "decrypt_failed" },
      { why: "signed by bob", frame: signObject("send", frame, bob.signSec), reason: "bad_signature" },
      { why: "another mesh", frame: { ...frame, mesh: b64u.encode(new Uint8Array(16)) }, reason: "wrong_mesh" },
      { why: "not addressed to this session", frame, reason: "not_addressed", address: "other@bob" },
      { why: "too old", frame, reason: "too_old", now: T + 47 * 3600000 + 1 },
      { why: "too new", frame, reason: "too_new", now: T - 600001 },
    ];
    for (const v of tampers) {
      const result = openMessage(v.frame, { roster, me: { ...me, address: v.address ?? me.address }, now: v.now ?? T });
      check(!result.ok && result.reason === v.reason, `message tamper ${v.why}`);
    }
    return {
      description: "alice seals a scheme 1 (v0.1, static-static) message to reviewer@bob, as receivers still accept during the migration window (SPEC section 6b). Bob's session (address reviewer@bob, clock `now`) opens it to `plaintext`. Each tamper case must fail with `reason`, given the same roster and the `now` and `address` shown (or the defaults).",
      roster,
      receiver: { device: "bob", address: me.address, sid: me.sid },
      now: T,
      frame,
      plaintext: (opened as { value: unknown }).value,
      tampers: tampers.map((v) => ({ why: v.why, now: v.now ?? T, address: v.address ?? me.address, reason: v.reason, frame: v.frame })),
    };
  });
}

const HOUR = 3600000;

/** Alice's and bob's prekeys for the vectors: made an hour before T, from a fixed stream. */
function vectorPrekeys(): { alice: { prekey: Prekey; secret: Uint8Array }; bob: { prekey: Prekey; secret: Uint8Array } } {
  return withRandomSource(stream("wim vectors prekey"), () => ({
    alice: createPrekey({ mesh: MESH, deviceId: id(alice), signSec: alice.signSec, at: T - HOUR }),
    bob: createPrekey({ mesh: MESH, deviceId: id(bob), signSec: bob.signSec, at: T - HOUR }),
  }));
}

function prekeyVectors() {
  const pks = vectorPrekeys();
  const genesis = createGenesisRoster({ name: "alice", keys: alice, now: T, meshId: MESH });
  const roster = nextRoster(genesis, { add: [makeDeviceRecord("bob", bob, "member", T)] }, { keys: alice }, T);
  check(verifyPrekey(pks.bob.prekey, roster, T).ok, "bob's prekey verifies");

  // One box by hand, with every intermediate value.
  const header = {
    t: "send",
    mesh: MESH,
    id: "01K70000000000000000000B02",
    from: { device: id(alice), session: "writer", sid: "01K700000000000000000005D1" },
    to: ["reviewer@bob"],
    seq: 1,
    at: T,
    roster: { seq: 2, hash: hash(roster) },
  };
  const plaintext = canon({ v: 1, kind: "msg", id: header.id, from: header.from, to: header.to, at: T, roster: header.roster, text: "hello" });
  const info = `wim/1 box2 ${MESH} ${id(alice)} ${id(bob)} ${pks.bob.prekey.id}`;
  const aad = sha256(canonBytes(header));
  const ephemeral = sha256(utf8("wim vectors box2 ephemeral"));
  const trace = hpkeSealAuth({ pkR: b64u.decode(pks.bob.prekey.pub), skS: alice.boxSec, info: utf8(info), aad, plaintext: utf8(plaintext), ephemeral });

  // A whole frame, as sealMessage makes it.
  const message = withRandomSource(stream("wim vectors message2"), () => {
    const frame = sealMessage({
      roster,
      sender: { deviceId: id(alice), keys: alice },
      session: "writer",
      sid: "01K700000000000000000005D1",
      to: ["reviewer@bob"],
      seq: 1,
      at: T,
      id: "01K700000000000000000005G2",
      text: "please review the diff",
      recipients: [id(bob)],
      prekeys: { [id(bob)]: pks.bob.prekey },
      prekey: pks.alice.prekey,
    });
    const me = { deviceId: id(bob), keys: bob, address: "reviewer@bob", sid: "01K700000000000000000005D2" };
    const lookup = (pid: string) => (pid === pks.bob.prekey.id ? pks.bob.secret : undefined);
    const opened = openMessage(frame, { roster, me: { ...me, prekey: lookup }, now: T });
    check(opened.ok, "message2 opens");
    const box = frame.boxes[id(bob)] as { s: 2; p: string; e: string; c: string };
    const resigned = (f: Record<string, unknown>) => signObject("send", f, alice.signSec) as SendFrame;
    const otherE = b64u.encode(x25519.getPublicKey(sha256(utf8("wim vectors other ephemeral"))));
    const tampers: Array<{ why: string; frame: unknown; reason: string; held: string[]; legacy?: boolean }> = [
      { why: "bob no longer holds the prekey secret (deleted after 72 hours)", frame, reason: "key_expired", held: [] },
      { why: "ephemeral key replaced and re-signed", frame: resigned({ ...frame, boxes: { [id(bob)]: { ...box, e: otherE } } }), reason: "decrypt_failed", held: [pks.bob.prekey.id] },
      { why: "header changed and re-signed", frame: resigned({ ...frame, seq: 2 }), reason: "decrypt_failed", held: [pks.bob.prekey.id] },
      { why: "box names another prekey bob holds", frame: resigned({ ...frame, boxes: { [id(bob)]: { ...box, p: pks.alice.prekey.id } } }), reason: "decrypt_failed", held: [pks.bob.prekey.id, pks.alice.prekey.id] },
      { why: "re-signed by bob, who is not the sender", frame: signObject("send", frame, bob.signSec), reason: "bad_signature", held: [pks.bob.prekey.id] },
    ];
    for (const v of tampers) {
      const held = (pid: string) => (v.held.includes(pid) ? (pid === pks.bob.prekey.id ? pks.bob.secret : pks.alice.secret) : undefined);
      const result = openMessage(v.frame, { roster, me: { ...me, prekey: held }, now: T });
      check(!result.ok && result.reason === v.reason, `message2 tamper ${v.why}`);
    }
    return { frame, me, plaintext: (opened as { value: unknown }).value, tampers };
  });

  const forged = signObject("prekey", { ...pks.bob.prekey, pub: pks.alice.prekey.pub, id: pks.alice.prekey.id }, alice.signSec);
  const invalid: Array<{ why: string; prekey: unknown; now: number; reason: string }> = [
    { why: "signed by alice, published as bob's", prekey: forged, now: T, reason: "bad_signature" },
    { why: "id not derived from pub", prekey: { ...pks.bob.prekey, id: pks.alice.prekey.id }, now: T, reason: "bad_id" },
    { why: "replayed into another mesh", prekey: { ...pks.bob.prekey, mesh: b64u.encode(new Uint8Array(16)) }, now: T, reason: "wrong_mesh" },
    { why: "validity longer than 48 hours", prekey: signObject("prekey", { ...pks.bob.prekey, until: pks.bob.prekey.at + 48 * HOUR + 1 }, bob.signSec), now: T, reason: "bad_window" },
    { why: "expired: fewer than 10 minutes before until", prekey: pks.bob.prekey, now: pks.bob.prekey.until - 10 * 60000, reason: "expired" },
    { why: "made more than 10 minutes in the future", prekey: pks.bob.prekey, now: pks.bob.prekey.at - 10 * 60000 - 1, reason: "not_yet" },
  ];
  for (const v of invalid) {
    const r = verifyPrekey(v.prekey, roster, v.now);
    check(!r.ok && r.reason === v.reason, `prekey invalid ${v.why}`);
  }

  return {
    description:
      "Scheme 2 boxes (SPEC section 6b). `prekeys` are alice's and bob's signed prekeys (type prekey, signed by each device's own sign key) with their secrets. `box` is one box by hand: RFC 9180 HPKE mode_auth, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305, to bob's prekey, authenticated by alice's roster box key, with a fixed ephemeral secret, info as given and AAD = SHA-256(canon(header)). `message` is a whole frame from sealMessage carrying alice's prekey as `pk`; bob opens it to `plaintext` while he holds his prekey secret, and each tamper must fail with `reason` when he holds only the prekey ids listed in `held`. Each `invalid_prekeys` entry must fail verifyPrekey at `now` with `reason`.",
    roster,
    prekeys: {
      alice: { prekey: pks.alice.prekey, secret: b64u.encode(pks.alice.secret), id_rule: "b64u(SHA-256(pub)) cut to 22", id: prekeyId(b64u.decode(pks.alice.prekey.pub)) },
      bob: { prekey: pks.bob.prekey, secret: b64u.encode(pks.bob.secret), id_rule: "b64u(SHA-256(pub)) cut to 22", id: prekeyId(b64u.decode(pks.bob.prekey.pub)) },
    },
    box: {
      sender: "alice",
      recipient: "bob",
      header,
      info,
      aad: b64u.encode(aad),
      ephemeral_secret: b64u.encode(ephemeral),
      enc: b64u.encode(trace.enc),
      shared_secret: b64u.encode(trace.sharedSecret),
      key: b64u.encode(trace.key),
      base_nonce: b64u.encode(trace.nonce),
      plaintext,
      ciphertext: b64u.encode(trace.ciphertext),
      box: { s: 2, p: pks.bob.prekey.id, e: b64u.encode(trace.enc), c: b64u.encode(trace.ciphertext) },
    },
    message: {
      receiver: { device: "bob", address: message.me.address, sid: message.me.sid },
      now: T,
      frame: message.frame,
      plaintext: message.plaintext,
      tampers: message.tampers.map((v) => ({ why: v.why, held: v.held, reason: v.reason, frame: v.frame })),
    },
    invalid_prekeys: invalid,
  };
}

function blobVectors() {
  return withRandomSource(stream("wim vectors blob"), () => {
    const size = 256 * 1024 + 5;
    const file = Uint8Array.from({ length: size }, (_, i) => i % 251);
    const sealed = sealBlob(file, { blob: "01K70000000000000000000B10" });
    check(openBlob(sealed).ok, "blob opens");
    return {
      description: "A 2-chunk file whose byte i is i mod 251 (262149 bytes). Each chunk: XChaCha20-Poly1305 under `key` and its nonce, AAD = UTF-8('wim/1 blob ' + blob + ' ' + index + ' ' + (last ? '1' : '0')). The first ciphertext is given by length and SHA-256 to keep this file small.",
      file: { rule: "byte i = i mod 251", size, sha256: sealed.sha256 },
      blob: sealed.blob,
      key: sealed.key,
      chunks: sealed.chunks.map((c) => ({
        index: c.index,
        last: c.last,
        n: c.n,
        aad: `wim/1 blob ${sealed.blob} ${c.index} ${c.last ? "1" : "0"}`,
        ciphertext_bytes: b64u.decode(c.data).length,
        ciphertext_sha256: b64u.encode(sha256(b64u.decode(c.data))),
        ...(c.index === 1 ? { ciphertext: c.data } : {}),
      })),
    };
  });
}

/** Public keys (b64u) of every fixed key in the vectors, signing and box, sorted. */
export function vectorPublicKeys(): string[] {
  const recovery = withRandomSource(stream("wim vectors roster"), () => createRecoveryKeys(MESH, { now: T }).keys);
  const pks = vectorPrekeys();
  return [alice, bob, carol, dave, recovery]
    .flatMap((k) => [b64u.encode(k.signPub), b64u.encode(k.boxPub)])
    .concat([pks.alice.prekey.pub, pks.bob.prekey.pub])
    .sort();
}

/** Every vectors file, by name, as the exact text to commit. */
export function buildVectors(): Record<string, string> {
  return {
    "canon.json": json(canonVectors()),
    "b64u.json": json(b64uVectors()),
    "keys.json": json(keysVectors()),
    "sign.json": json(signVectors()),
    "box.json": json(boxVectors()),
    "roster.json": json(rosterVectors()),
    "invite.json": json(inviteVectors()),
    "message.json": json(messageVectors()),
    "prekey.json": json(prekeyVectors()),
    "blob.json": json(blobVectors()),
  };
}
