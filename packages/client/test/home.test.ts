import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Home, SetupError } from "../src/home.ts";
import { FS, scratch } from "./helpers.ts";

const uid = process.getuid?.();

async function home(): Promise<Home> {
  return new Home(await scratch("home"), { ...FS, uid });
}

describe("Home", () => {
  it("creates a private key file and loads it back", async () => {
    const h = await home();
    expect(await h.loadDevice()).toBeUndefined();
    await expect(h.requireDevice()).rejects.toThrow(SetupError);
    const d = await h.createDevice("laptop");
    expect((await fs.stat(h.devicePath)).mode & 0o777).toBe(0o600);
    const back = await h.requireDevice();
    expect(back.id).toBe(d.id);
    expect(back.name).toBe("laptop");
    await expect(h.createDevice("laptop")).rejects.toThrow(/already exists/);
    await expect(h.createDevice("Bad Name")).rejects.toThrow(/invalid device name/);
  });

  it("refuses a key file that group or others can read, or a link", async () => {
    const h = await home();
    await h.createDevice("laptop");
    await fs.chmod(h.devicePath, 0o644);
    await expect(h.loadDevice()).rejects.toThrow(/readable by group or others/);
    await fs.chmod(h.devicePath, 0o600);
    await fs.rename(h.devicePath, `${h.devicePath}.real`);
    await fs.symlink(`${h.devicePath}.real`, h.devicePath);
    await expect(h.loadDevice()).rejects.toThrow(/symbolic link/);
  });

  it("refuses a key file without a valid name", async () => {
    const h = await home();
    await h.createDevice("laptop");
    const raw = JSON.parse(await fs.readFile(h.devicePath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(h.devicePath, JSON.stringify({ ...raw, name: "NO" }), { mode: 0o600 });
    await expect(h.loadDevice()).rejects.toThrow(/device name/);
  });

  it("rethrows unexpected stat errors", async () => {
    const root = await scratch("home");
    await fs.writeFile(join(root, "file"), "x");
    const h = new Home(join(root, "file"), { ...FS, uid });
    await expect(h.loadDevice()).rejects.toThrow();
  });

  it("lists and picks meshes", async () => {
    const h = await home();
    await expect(h.pickMesh(undefined)).rejects.toThrow(/in no mesh/);
    await fs.mkdir(h.meshDir("m1"), { recursive: true });
    await fs.writeFile(join(h.meshDir("m1"), "mesh.json"), "{}");
    await fs.mkdir(h.meshDir("junk"), { recursive: true });
    expect(await h.meshIds()).toEqual(["m1"]);
    expect(await h.pickMesh(undefined)).toBe("m1");
    expect(await h.pickMesh("")).toBe("m1");
    expect(await h.pickMesh("m1")).toBe("m1");
    await expect(h.pickMesh("m9")).rejects.toThrow(/not in mesh m9/);
    await fs.mkdir(h.meshDir("m2"), { recursive: true });
    await fs.writeFile(join(h.meshDir("m2"), "mesh.json"), "{}");
    await expect(h.pickMesh(undefined)).rejects.toThrow(/2 meshes/);
  });

  it("reports the state directory's own permissions", async () => {
    const h = await home();
    await fs.chmod(h.root, 0o700);
    expect(await h.rootProblem()).toBeUndefined();
    await fs.chmod(h.root, 0o755);
    expect(await h.rootProblem()).toMatch(/chmod 700/);
  });
});
