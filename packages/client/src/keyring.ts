// The device's keyring as the client uses it: the protocol's Keyring (sign, seal, open), plus the
// device's prekeys (SPEC section 6b), which the keyring makes and opens so that their secrets stay
// wherever the device keys are: in this process for a plaintext key file, in the signer (`wim
// agent`) for an encrypted one.

import { createPrekey, deviceIdFromSignPub, localKeyring, openBox, type DeviceKeys, type Keyring, type Opened, type OpenRequest, type Prekey } from "@worldinmotion/protocol";

/**
 * One of this device's prekeys as `prekeys.json` keeps it: with its secret in the clear (made by a
 * process that holds the device keys), or sealed by the signer, which alone can open it.
 */
export type PrekeyEntry = { prekey: Prekey; secret: Uint8Array } | { prekey: Prekey; sealed: string };

export interface DeviceKeyring extends Keyring {
  /** `local`: the keys are in this process. `signer`: they are in the `wim agent` signer. */
  readonly kind: "local" | "signer";
  /** Makes and signs a new prekey for `mesh`, made at `at`. */
  newPrekey(mesh: string, at: number): Promise<PrekeyEntry>;
  /** Opens a scheme 2 box with the entry of the prekey it names. */
  openPrekey(entry: PrekeyEntry, req: OpenRequest): Promise<Opened>;
  /** The entry as this keyring stores it: a signer seals a secret in the clear; a local keyring keeps it. */
  adopt(entry: PrekeyEntry): Promise<PrekeyEntry>;
  /** Lets go of what the keyring holds open (a signer's connection); it reconnects if used again. */
  close(): void;
}

/**
 * Opens a scheme 2 box with a prekey secret in the clear. Only the prekey secret is needed (HPKE
 * mode_auth opens with the recipient's secret and the sender's public key).
 */
export function openWithClearPrekey(entry: { secret: Uint8Array }, req: OpenRequest): Opened {
  return openBox(undefined, () => entry.secret, req);
}

/**
 * Thrown by a process holding the plaintext keys for a prekey the signer sealed: the device's key
 * file was encrypted (`wim agent encrypt`) while this process ran, and only a restart, through the
 * signer, opens what was sealed to that prekey.
 */
export class NeedsSigner extends Error {
  override readonly name = "NeedsSigner";
  constructor() {
    super("this device's keys were encrypted (wim agent encrypt) while this session was running: restart it so it uses the signer; messages it cannot open meanwhile are not acknowledged, and the relay delivers them again");
  }
}

/** The keyring of a device whose key file is plaintext: the keys are in this process. */
export function localDeviceKeyring(keys: DeviceKeys): DeviceKeyring {
  const ring = localKeyring(keys);
  const deviceId = deviceIdFromSignPub(keys.signPub);
  return {
    kind: "local",
    signPub: ring.signPub,
    boxPub: ring.boxPub,
    sign: ring.sign,
    seal: ring.seal,
    open: ring.open,
    newPrekey: async (mesh, at) => createPrekey({ mesh, deviceId, signSec: keys.signSec, at }),
    // A sealed entry opens only in the signer, which this process is not using: the key file
    // was encrypted while it ran. Not "key_expired", which would drop the message for good.
    openPrekey: async (entry, req) => {
      if ("sealed" in entry) throw new NeedsSigner();
      return openWithClearPrekey(entry, req);
    },
    adopt: async (entry) => entry,
    // Nothing is held open: the keys are in this process.
    close: () => undefined,
  };
}
