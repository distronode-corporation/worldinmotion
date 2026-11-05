import { promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DSN_SHAPE, readDsn } from "../packages/client/scripts/dsn.mjs";
import { bakedDsn } from "../packages/client/src/crash.ts";

// The crash-report address is committed (CONTRIBUTING.md, Crash reports), so every bundle carries
// it. These check that the committed file is one address the client takes, that the bundle step
// refuses anything else, that the committed plugin bundle carries it, and that CI can never send.
// The assertions compare booleans, so a failure never prints the address.
const root = join(import.meta.dirname, "..");
const DSN_FILE = join(root, "packages", "client", "crash-report-dsn.txt");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("the committed crash-report address", () => {
  it("is one line holding one DSN that bakedDsn and the bundle step both take", async () => {
    const text = readFileSync(DSN_FILE, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trimEnd().includes("\n")).toBe(false);
    const dsn = await readDsn(DSN_FILE);
    expect(bakedDsn(text) === dsn).toBe(true);
    // The organisation's EU ingest host and the worldinmotion project.
    expect(/^https:\/\/[0-9a-f]{32}@o4511933949083648\.ingest\.de\.sentry\.io\/4512381403856976$/.test(dsn)).toBe(true);
  });

  it("is in the committed plugin bundle, and the bundle reads no global for it", async () => {
    const bundle = read("plugins/claude-code/dist/client.mjs");
    expect(bundle.includes(JSON.stringify(await readDsn(DSN_FILE)))).toBe(true);
    expect(bundle.includes("__WIM_SENTRY_DSN__")).toBe(false);
  });

  it("refuses a malformed file in the bundle step, the same way bakedDsn does", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "wim-dsn-"));
    const file = join(dir, "crash-report-dsn.txt");
    for (const bad of [
      "",
      "\n",
      "not a dsn\n",
      "http://0123456789abcdef0123456789abcdef@o1.ingest.de.sentry.io/1\n",
      "https://o1.ingest.de.sentry.io/1\n",
      "https://key:secret@o1.ingest.de.sentry.io/1\n",
      "https://0123456789abcdef0123456789abcdef@o1.ingest.de.sentry.io/1/extra\n",
      "https://0123456789abcdef0123456789abcdef@o1.ingest.de.sentry.io/1\nhttps://0123456789abcdef0123456789abcdef@o1.ingest.de.sentry.io/2\n",
      "https://NOTHEX0123456789ab@o1.ingest.de.sentry.io/1\n",
    ]) {
      await fs.writeFile(file, bad);
      await expect(readDsn(file), JSON.stringify(bad)).rejects.toThrow(/does not hold one https Sentry DSN/);
      expect(bakedDsn(bad), JSON.stringify(bad)).toBeUndefined();
      expect(DSN_SHAPE.test(bad.trim())).toBe(false);
    }
    await expect(readDsn(join(dir, "missing.txt"))).rejects.toThrow(/ENOENT/);
    const good = "https://0123456789abcdef0123456789abcdef@o1.ingest.de.sentry.io/1";
    await fs.writeFile(file, ` ${good}\r\n`);
    expect(await readDsn(file)).toBe(good);
    expect(bakedDsn(good)).toBe(good);
  });
});

describe("CI never sends a crash report", () => {
  it("sets WIM_NO_CRASH_REPORTS for the whole of ci.yml, and nothing sets it to anything else", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toMatch(/^env:\n {2}WIM_NO_CRASH_REPORTS: "1"\n/m);
    expect(ci.match(/WIM_NO_CRASH_REPORTS:/g)).toHaveLength(1);
  });

  it("passes no crash-report secret to any workflow: the address is the committed file", () => {
    for (const name of ["ci.yml", "release.yml"]) {
      expect(read(`.github/workflows/${name}`), name).not.toMatch(/WIM_SENTRY_DSN/);
    }
  });
});
