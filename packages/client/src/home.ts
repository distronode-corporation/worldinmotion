// The device: its key file under WIM_HOME and the meshes it belongs to.

import { decodeKeys, deviceIdFromSignPub, encodeKeys, generateDeviceKeys, isName, isVectorKey, type DeviceKeys } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ensureDir, listDir, readJson, writeNew, type FsEnv } from "./fsx.ts";
import { dirProblem, keyFileProblem } from "./platform.ts";

export type Device = { name: string; id: string; keys: DeviceKeys };

/** Raised for a problem the person has to fix (a missing setup, unsafe permissions). */
export class SetupError extends Error {
  override readonly name = "SetupError";
}

export type HomeEnv = FsEnv & { uid: number | undefined };

/** The `WIM_HOME` tree (design.md, state on disk). */
export class Home {
  readonly root: string;
  readonly env: HomeEnv;
  constructor(root: string, env: HomeEnv) {
    this.root = root;
    this.env = env;
  }

  get devicePath(): string {
    return join(this.root, "device.json");
  }

  meshDir(mesh: string): string {
    return join(this.root, "meshes", mesh);
  }

  /** The device keys, refusing a key file that other users could read. */
  async loadDevice(): Promise<Device | undefined> {
    let facts;
    try {
      facts = await fs.lstat(this.devicePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const problem = keyFileProblem(
      { mode: facts.mode, uid: facts.uid, isFile: facts.isFile(), isSymlink: facts.isSymbolicLink() },
      this.env.platform,
      this.env.uid,
    );
    if (problem !== undefined) throw new SetupError(`refusing to use ${this.devicePath}: ${problem}`);
    const raw = (await readJson(this.devicePath)) as Record<string, unknown>;
    const keys = decodeKeys(raw);
    const name = raw["name"];
    if (!isName(name)) throw new SetupError(`${this.devicePath}: the device name is missing or invalid`);
    // The published test vectors' secrets are public (SPEC section 16).
    if ([keys.signPub, keys.boxPub].some(isVectorKey)) throw new SetupError(`refusing to use ${this.devicePath}: it holds a published test-vector key`);
    return { name, id: deviceIdFromSignPub(keys.signPub), keys };
  }

  async requireDevice(): Promise<Device> {
    const device = await this.loadDevice();
    if (device === undefined) {
      // The agent's server and a terminal find the same keys only with the same WIM_HOME, or the same CLAUDE_CONFIG_DIR.
      throw new SetupError(`this device is not set up (no device keys at ${this.devicePath}): run \`wim init\` first, with the same WIM_HOME and CLAUDE_CONFIG_DIR as the agent`);
    }
    return device;
  }

  /** Generates this device's keys. Refuses to replace an existing key file, also against a concurrent first run. */
  async createDevice(name: string): Promise<Device> {
    if (!isName(name)) throw new SetupError(`invalid device name ${JSON.stringify(name)}: use 1 to 32 of a-z, 0-9 and -`);
    const exists = new SetupError(`${this.devicePath} already exists`);
    if ((await this.loadDevice()) !== undefined) throw exists;
    await ensureDir(this.root);
    const keys = generateDeviceKeys();
    const encoded = JSON.parse(encodeKeys(keys)) as Record<string, unknown>;
    await writeNew(this.devicePath, `${JSON.stringify({ ...encoded, name })}\n`, this.env).catch((error: unknown) => {
      throw (error as NodeJS.ErrnoException).code === "EEXIST" ? exists : error;
    });
    return { name, id: deviceIdFromSignPub(keys.signPub), keys };
  }

  /** Problems with the state directory's own permissions, for `wim doctor`. */
  async rootProblem(): Promise<string | undefined> {
    const stat = await fs.stat(this.root);
    return dirProblem(stat.mode, this.env.platform);
  }

  async meshIds(): Promise<string[]> {
    const names = await listDir(join(this.root, "meshes"));
    const ids: string[] = [];
    for (const name of names.sort()) {
      if ((await readJson(join(this.root, "meshes", name, "mesh.json"))) !== undefined) ids.push(name);
    }
    return ids;
  }

  /** The mesh to use: the one asked for, or the only one. */
  async pickMesh(wanted: string | undefined): Promise<string> {
    const ids = await this.meshIds();
    if (wanted !== undefined && wanted !== "") {
      if (!ids.includes(wanted)) throw new SetupError(`this device is not in mesh ${wanted}`);
      return wanted;
    }
    if (ids.length === 0) throw new SetupError("this device is in no mesh: run `wim mesh create` or `wim join <code>`");
    if (ids.length > 1) throw new SetupError(`this device is in ${ids.length} meshes: set WIM_MESH or pass --mesh (${ids.join(", ")})`);
    return ids[0]!;
  }
}
