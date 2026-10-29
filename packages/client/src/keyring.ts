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
}

/**
 * Opens a scheme 2 box with a prekey secret in the clear. Only the prekey secret is needed (HPKE
 * mode_auth opens with the recipient's secret and the sender's public key).
 */
export function openWithClearPrekey(entry: { secret: Uint8Array }, req: OpenRequest): Opened {
  return openBox(undefined, () => entry.secret, req);
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
    // A sealed entry opens only in the signer, which this process is not using.
    openPrekey: async (entry, req) => ("secret" in entry ? openWithClearPrekey(entry, req) : "key_expired"),
    adopt: async (entry) => entry,
  };
}
