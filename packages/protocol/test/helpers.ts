import {
  createGenesisRoster,
  deviceIdFromSignPub,
  generateDeviceKeys,
  makeDeviceRecord,
  nextRoster,
  type DeviceKeys,
  type DeviceRecord,
  type Roster,
} from "../src/index.ts";

export const T0 = 1760000000000;

export type Device = { name: string; id: string; keys: DeviceKeys; record: DeviceRecord };

export function device(name: string, role: DeviceRecord["role"] = "member", added = T0): Device {
  const keys = generateDeviceKeys();
  return { name, id: deviceIdFromSignPub(keys.signPub), keys, record: makeDeviceRecord(name, keys, role, added) };
}

/** A mesh with an admin and the given members, built by real roster updates. */
export function mesh(memberNames: string[] = []): { admin: Device; members: Device[]; chain: Roster[] } {
  const admin = device("admin", "admin");
  const chain = [createGenesisRoster({ name: admin.name, keys: admin.keys, now: T0 })];
  const members: Device[] = [];
  for (const name of memberNames) {
    const member = device(name);
    members.push(member);
    chain.push(nextRoster(chain.at(-1)!, { add: [member.record] }, admin, T0 + chain.length));
  }
  return { admin, members, chain };
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
