// The device: its key file under WIM_HOME and the meshes it belongs to.

import { b64u, decodeKeys, deviceIdFromSignPub, encodeKeys, generateDeviceKeys, isName, isVectorKey, type DeviceKeys } from "@worldinmotion/protocol";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { agentEndpoint, readAgentSettings } from "./agentpath.ts";
import { SetupError } from "./errors.ts";
import { ensureDir, listDir, readJson, writeNew, type FsEnv } from "./fsx.ts";
import { localDeviceKeyring, type DeviceKeyring } from "./keyring.ts";
import { dirProblem, keyFileProblem } from "./platform.ts";
import { SignerClient, signerKeyring, type SignerError } from "./signer.ts";
import { parseSealedKeyFile, type SealedKeyFile } from "./vault.ts";

/** This device: its roster name, its id, and the keyring that holds (or reaches) its secret keys. */
export type Device = { name: string; id: string; keyring: DeviceKeyring };

/** A device whose keys are in this process: its key file is plaintext. */
export type LocalDevice = Device & { keys: DeviceKeys };

function localDevice(name: string, keys: DeviceKeys): LocalDevice {
  return { name, id: deviceIdFromSignPub(keys.signPub), keys, keyring: localDeviceKeyring(keys) };
}

export { SetupError };

/** `requireSigner`: refuse a plaintext key file (`WIM_REQUIRE_SIGNER=1`, or `require_signer` in `agent/config.json`). */
export type HomeEnv = FsEnv & { uid: number | undefined; requireSigner?: boolean };

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

  /**
   * The key file as it is on disk, refusing one that other users could read: a plaintext one
   * (version 1) as a device with its keys, an encrypted one (version 2) as its public part.
   */
  async readKeyFile(): Promise<{ plain: LocalDevice } | { sealed: SealedKeyFile } | undefined> {
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
    if (raw["v"] === 2) return { sealed: parseSealedKeyFile(raw) };
    const keys = decodeKeys(raw);
    const name = raw["name"];
    if (!isName(name)) throw new SetupError(`${this.devicePath}: the device name is missing or invalid`);
    // The published test vectors' secrets are public (SPEC section 16).
    if ([keys.signPub, keys.boxPub].some(isVectorKey)) throw new SetupError(`refusing to use ${this.devicePath}: it holds a published test-vector key`);
    return { plain: localDevice(name, keys) };
  }

  /**
   * This device. With a plaintext key file, its keys are read here (unless the signer is required).
   * With an encrypted one, the running, unlocked signer holds them, and every secret-key operation
   * goes to it: this process never reads them.
   */
  async loadDevice(): Promise<Device | undefined> {
    const file = await this.readKeyFile();
    if (file === undefined) return undefined;
    if ("plain" in file) {
      if (this.env.requireSigner === true || (await readAgentSettings(this.root)).require_signer === true) {
        throw new SetupError(`${this.devicePath} is not encrypted, and this device requires the signer: run \`wim agent encrypt\`, then \`wim agent start\``);
      }
      return file.plain;
    }
    const sealed = file.sealed;
    const signPub = b64u.decode(sealed.signPub);
    const notRunning = `the device keys in ${this.devicePath} are encrypted and no signer is running: run \`wim agent start\` in your own terminal`;
    // Found again for each connection: the session outlives a signer restart.
    const client = new SignerClient({ endpoint: () => agentEndpoint(this.root, this.env, false), expect: signPub });
    let hello;
    try {
      hello = await client.hello();
    } catch (error) {
      throw new SetupError((error as Partial<SignerError>).code === "unavailable" ? notRunning : (error as Error).message);
    }
    if (hello.locked) {
      client.close();
      throw new SetupError("the signer is locked: run `wim agent unlock` in your own terminal");
    }
    return { name: sealed.name, id: sealed.id, keyring: signerKeyring(client, { signPub, boxPub: b64u.decode(sealed.boxPub) }) };
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
  async createDevice(name: string): Promise<LocalDevice> {
    if (!isName(name)) throw new SetupError(`invalid device name ${JSON.stringify(name)}: use 1 to 32 of a-z, 0-9 and -`);
    const exists = new SetupError(`${this.devicePath} already exists`);
    if ((await this.readKeyFile()) !== undefined) throw exists;
    await ensureDir(this.root);
    const keys = generateDeviceKeys();
    const encoded = JSON.parse(encodeKeys(keys)) as Record<string, unknown>;
    await writeNew(this.devicePath, `${JSON.stringify({ ...encoded, name })}\n`, this.env).catch((error: unknown) => {
      throw (error as NodeJS.ErrnoException).code === "EEXIST" ? exists : error;
    });
    return localDevice(name, keys);
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
