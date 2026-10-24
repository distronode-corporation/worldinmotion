import { promises as fs } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { main, parseArgs, parseDuration, toName, USAGE } from "../src/cli.ts";
import { MeshSession } from "../src/client.ts";
import { makeMesh, POSIX_VIEW, RELAY, RelayHarness, run, said, scratch, sessionOpts, sleep, term, until } from "./helpers.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f().catch(() => undefined);
});

describe("argument parsing", () => {
  it("parses flags, durations and names", () => {
    expect(parseArgs(["a", "--name", "x", "--auto", "--exp=2h", "--", "--not"])).toEqual({ positional: ["a", "--not"], flags: new Map<string, string | true>([["name", "x"], ["auto", true], ["exp", "2h"]]) });
    expect(() => parseArgs(["--name"])).toThrow(/needs a value/);
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("2d")).toBe(172_800_000);
    expect(() => parseDuration("soon")).toThrow(/not a duration/);
    expect(toName("My Host.local", "d")).toBe("my-host-local");
    expect(toName("---", "d")).toBe("d");
    expect(toName("a".repeat(40) + "-", "d")).toBe("a".repeat(32));
  });

  it("prints usage, the version, and refuses unknown commands", async () => {
    const t = term(await scratch("cli"), new RelayHarness());
    expect(await run(t)).toBe(2);
    expect(await run(t, "help")).toBe(0);
    expect(await run(t, "version")).toBe(0);
    expect(await run(t, "frobnicate")).toBe(2);
    expect(await run(t, "--name")).toBe(2);
    expect(said(t)).toContain(USAGE.split("\n")[0]);
    expect(said(t)).toContain("unknown command");
  });
});

describe("setting up", () => {
  it("init, mesh create with a recovery code on a terminal, invite with SAS confirmation, join", async () => {
    const relay = new RelayHarness();
    const a = term(await scratch("cli-a"), relay);
    expect(await run(a, "init", "--name", "laptop", "--relay", RELAY)).toBe(0);
    expect(said(a)).toMatch(/This device is laptop/);
    expect(said(a)).toMatch(/Recovery code \(shown once/);
    expect(said(a)).toMatch(/wimrec1_/);
    expect(await run(a, "init")).toBe(1);
    expect(said(a)).toMatch(/already exists/);

    const b = term(await scratch("cli-b"), relay);
    a.answers.push("y");
    const inviting = run(a, "invite", "--exp", "1h");
    await until(() => a.out.some((l) => l.includes("wim1_")));
    const code = a.out.find((l) => l.includes("wim1_"))!.trim();
    expect(await run(b, "join", code)).toBe(0);
    expect(await inviting).toBe(0);
    const sas = /Its code is (\S+)\./.exec(said(b))![1]!;
    expect(said(a)).toContain(`code ${sas}`);
    expect(said(a)).toMatch(/Admitted my-host-local/);
    expect(said(b)).toMatch(/Joined mesh/);

    // devices: list, trust, trust --relayed, untrust, errors
    expect(await run(a, "devices")).toBe(0);
    expect(said(a)).toMatch(/my-host-local {2}member .* {2}hold/);
    expect(await run(a, "devices", "trust", "my-host-local")).toBe(0);
    expect(await run(a, "devices", "trust", "my-host-local", "--relayed")).toBe(0);
    expect(said(a)).toMatch(/including text it relays/);
    expect(await run(a, "devices", "untrust", "my-host-local")).toBe(0);
    expect(await run(a, "devices", "trust")).toBe(1);
    expect(await run(a, "devices", "trust", "ghost")).toBe(1);
    expect(await run(a, "devices", "dance", "laptop")).toBe(1);
    expect(await run(a, "devices", "promote", "my-host-local")).toBe(0);
    expect(said(a)).toMatch(/Promoted my-host-local to admin/);
    expect(await run(b, "devices", "revoke", "laptop")).toBe(0);
    expect(said(b)).toMatch(/Revoked laptop/);
  }, 30_000);

  it("refuses a join when the person says the codes differ", async () => {
    const relay = new RelayHarness();
    const a = term(await scratch("cli-a"), relay);
    await run(a, "init", "--name", "laptop", "--relay", RELAY, "--no-recovery");
    const b = term(await scratch("cli-b"), relay);
    a.answers.push("n");
    const inviting = run(a, "invite", "--exp", "3s");
    await until(() => a.out.some((l) => l.includes("wim1_")));
    const code = a.out.find((l) => l.includes("wim1_"))!.trim();
    const joining = run(b, "join", code, "--name", "box");
    expect(await inviting).toBe(1);
    expect(said(a)).toMatch(/refused the join: the person did not confirm/);
    expect(await joining).toBe(1);
  }, 20_000);

  it("stops waiting for an invite when the person stops it, and joins need a code", async () => {
    const relay = new RelayHarness();
    const a = term(await scratch("cli-a"), relay);
    await run(a, "init", "--relay", RELAY, "--no-recovery");
    const inviting = run(a, "invite", "--auto");
    await until(() => a.out.some((l) => l.includes("wim1_")));
    a.stop.abort();
    expect(await inviting).toBe(1);
    expect(said(a)).toMatch(/not used/);
    expect(await run(a, "join")).toBe(1);
    expect(await run(a, "mesh", "list")).toBe(1);
    expect(await run(a, "mesh", "create")).toBe(1);
    expect(await run(a, "mesh", "create", "--relay", RELAY, "--key-env", "NOPE")).toBe(1);
    expect(said(a)).toMatch(/NOPE is not set/);
  });

  it("holds the recovery code for `wim recovery show` when an agent runs the command", async () => {
    const relay = new RelayHarness();
    const home = await scratch("cli-rec");
    const agent = term(home, relay, { isTTY: false }, { CLAUDECODE: "1" });
    await run(agent, "init", "--name", "box");
    const creating = run(agent, "mesh", "create", "--relay", RELAY);
    await until(() => agent.out.some((l) => l.includes("wim recovery show")), 5000);
    expect(said(agent)).not.toMatch(/wimrec1_/);
    expect(said(agent)).toMatch(/an agent is running this command/);
    // The agent itself cannot collect it.
    expect(await run(agent, "recovery", "show")).toBe(1);
    const person = term(home, relay);
    expect(await run(person, "recovery", "nope")).toBe(1);
    expect(await run(person, "recovery", "show")).toBe(0);
    expect(said(person)).toMatch(/wimrec1_/);
    expect(await creating).toBe(0);
    expect(said(agent)).toMatch(/The recovery code was shown/);
    expect(await run(person, "recovery", "show")).toBe(1);
    // A pipe, with nobody collecting the code before the person stops the command.
    const piped = term(await scratch("cli-pipe"), relay, { isTTY: false });
    await run(piped, "init", "--name", "pipe");
    const making = run(piped, "mesh", "create", "--relay", RELAY);
    await until(() => piped.out.some((l) => l.includes("not a terminal")), 5000);
    piped.stop.abort();
    expect(await making).toBe(0);
    expect(said(piped)).toMatch(/was not collected/);
  }, 20_000);
});

describe("using a mesh", () => {
  async function twoHomes() {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"]);
    const a = term(devices[0]!.root, relay);
    const b = term(devices[1]!.root, relay);
    return { relay, mesh, devices, a, b };
  }

  it("sends, watches, lists peers and reads history", async () => {
    const { a, b } = await twoHomes();
    const watching = run(b, "watch", "--as", "reader");
    await until(() => b.out.some((l) => l.startsWith("Watching as reader@two")), 5000);
    expect(await run(a, "send", "reader@two", "hello", "there")).toBe(0);
    expect(said(a)).toMatch(/reader@two: routed/);
    await until(() => b.out.some((l) => /<- cli@one msg: hello there/.test(l)), 5000);
    expect(await run(a, "peers")).toBe(0);
    expect(said(a)).toMatch(/reader@two {2}cli/);
    b.stop.abort();
    expect(await watching).toBe(0);
    expect(await run(a, "send", "x@nowhere", "hi")).toBe(1);
    expect(await run(a, "send", "reader@two")).toBe(1);
    expect(await run(a, "send", "reader@two", `sk-ant-${"x".repeat(40)}`)).toBe(1);
    expect(said(a)).toMatch(/anthropic_api_key/);
    expect(await run(a, "send", "reader@two", `sk-ant-${"x".repeat(40)}`, "--allow-secret")).toBe(0);
    expect(await run(b, "history")).toBe(0);
    expect(said(b)).toMatch(/== reader@two/);
    expect(await run(b, "history", "--session", "nobody")).toBe(0);
    expect(said(b)).toMatch(/No history\./);
    expect(await run(b, "history", "--peer", "cli@one", "--limit", "1")).toBe(0);
    // A queued item shown when watch starts.
    await run(a, "send", "reader@two", "while away");
    const again = run(b, "watch", "--as", "reader");
    await until(() => b.out.some((l) => l.includes("while away")), 5000);
    b.stop.abort();
    await again;
  }, 30_000);

  it("lists, approves, refuses and resumes held messages", async () => {
    const relay = new RelayHarness();
    const { mesh, devices } = await makeMesh(relay, ["one", "two"], { trust: false });
    const a = term(devices[0]!.root, relay);
    const b = term(devices[1]!.root, relay);
    expect(await run(b, "held")).toBe(0);
    expect(said(b)).toMatch(/Nothing is held/);
    // A session nobody runs: the CLI updates it on disk.
    const s = await MeshSession.open({ ...sessionOpts(devices[1]!, mesh, relay, { name: "inbox" }), sessionKey: "key:inbox" });
    s.start();
    await s.ready(3000);
    await run(a, "send", "inbox@two", "first");
    await run(a, "send", "inbox@two", "second");
    await until(async () => (await s.held.list()).length === 2);
    await s.stop();
    expect(await run(b, "held", "list")).toBe(0);
    const ids = b.out.filter((l) => / -> inbox /.test(l)).map((l) => l.split(" ")[0]!);
    expect(ids.length).toBe(2);
    expect(await run(b, "held", "approve", ids[0]!)).toBe(0);
    expect(await run(b, "held", "refuse", ids[1]!)).toBe(0);
    expect(await run(b, "held", "approve", ids[1]!)).toBe(1);
    expect(await run(b, "held", "approve")).toBe(1);
    expect(await run(b, "held", "resume", "not an address")).toBe(1);
    expect(await run(b, "held", "resume", "cli@one")).toBe(0);
    expect(await run(b, "held", "shrug", "x")).toBe(1);
    const back = await MeshSession.open({ ...sessionOpts(devices[1]!, mesh, relay, { name: "inbox" }), sessionKey: "key:inbox" });
    expect((await back.spool.unread()).filter((i) => i.kind === "msg").map((i) => i.rendered.includes("first"))).toEqual([true]);
    await back.stop();
  }, 20_000);

  it("runs doctor", async () => {
    const { a, relay } = await twoHomes();
    expect(await run(a, "doctor")).toBe(0);
    expect(said(a)).toMatch(/ok {7}device one/);
    expect(said(a)).toMatch(/authenticated; roster seq/);
    relay.now = () => Date.now() + 120_000;
    const skew = term(a.env["WIM_HOME"]!, relay);
    expect(await run(skew, "doctor")).toBe(1);
    expect(said(skew)).toMatch(/this clock is -?\d+ s off/);
    relay.now = Date.now;
    relay.down = true;
    const down = term(a.env["WIM_HOME"]!, relay);
    expect(await run(down, "doctor")).toBe(1);
    expect(said(down)).toMatch(/ECONNREFUSED/);
    const empty = term(await scratch("cli-empty"), relay);
    expect(await run(empty, "doctor")).toBe(1);
    expect(said(empty)).toMatch(/no device keys/);
    // A key file open to group and others (as a POSIX client reads Windows' mode 666).
    await fs.chmod(join(a.env["WIM_HOME"]!, "device.json"), 0o644);
    expect(await run(term(a.env["WIM_HOME"]!, relay, { platform: POSIX_VIEW }), "doctor")).toBe(1);
  }, 20_000);

  it("sends a test notification through notify.json", async () => {
    const { a } = await twoHomes();
    expect(await run(a, "notify-test")).toBe(1);
    await fs.writeFile(join(a.env["WIM_HOME"]!, "notify.json"), JSON.stringify({ provider: "command", command: ["true"] }));
    expect(await run(a, "notify-test")).toBe(0);
  });

  it("serves MCP over stdio until the client goes away", async () => {
    const { a, relay } = await twoHomes();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const t = term(a.env["WIM_HOME"]!, relay, { stdin, stdout });
    const lines: string[] = [];
    stdout.on("data", (d: Buffer) => lines.push(...d.toString().split("\n").filter((x) => x !== "")));
    const serving = main(["mcp"], { ...t.env, WIM_KIND: "claude-code", WIM_NAME: "agent", WIM_SESSION_KEY: "stdio" }, t.io);
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`);
    await until(() => lines.length > 0, 3000, "initialize answer");
    expect(JSON.parse(lines[0]!).result.serverInfo.name).toBe("worldinmotion");
    stdin.end();
    expect(await serving).toBe(0);
    // Without a device it still starts, to say so.
    const bare = term(await scratch("cli-bare"), new RelayHarness(), { stdin: new PassThrough(), stdout: new PassThrough() });
    const s2 = main(["mcp"], { ...bare.env, WIM_KIND: "BAD KIND" }, bare.io);
    await sleep(50);
    bare.stop.abort();
    expect(await s2).toBe(0);
  });

  it("runs bot, ci and a2a on their own sessions", async () => {
    const { a } = await twoHomes();
    const dir = await scratch("svc");
    await fs.writeFile(join(dir, "bot.json"), JSON.stringify({ model: "ollama:tiny", budget: { ledgerPath: join(dir, "ledger.json"), dailyTokens: 1000 } }));
    const bot = run(a, "bot", join(dir, "bot.json"));
    await until(() => a.out.some((l) => l.startsWith("bot running as bot@one")), 5000);
    a.stop.abort();
    expect(await bot).toBe(0);

    const ci = term(a.env["WIM_HOME"]!, new RelayHarness(), { fetch: (async () => new Response("[]", { status: 200 })) as typeof fetch });
    ci.io.dialer = a.io.dialer;
    await fs.writeFile(join(dir, "ci.json"), JSON.stringify({ statePath: join(dir, "ci-state.json"), sources: [{ type: "github", owner: "o", repo: "r" }] }));
    const ciRun = run(ci, "ci", join(dir, "ci.json"));
    await until(() => ci.out.some((l) => l.startsWith("ci running")), 5000);
    ci.stop.abort();
    expect(await ciRun).toBe(0);

    const gw = term(a.env["WIM_HOME"]!, new RelayHarness(), {}, { A2A_TOKEN: "t".repeat(40) });
    gw.io.dialer = a.io.dialer;
    await fs.writeFile(join(dir, "a2a.json"), JSON.stringify({ inbound: { port: 0, tokenEnv: "A2A_TOKEN" } }));
    const gwRun = run(gw, "a2a", join(dir, "a2a.json"));
    await until(() => gw.out.some((l) => l.startsWith("a2a gateway listening on http://127.0.0.1:")), 5000);
    gw.stop.abort();
    expect(await gwRun).toBe(0);
    await fs.writeFile(join(dir, "out.json"), JSON.stringify({ outbound: { agents: [] } }));
    const out = term(a.env["WIM_HOME"]!, new RelayHarness());
    out.io.dialer = a.io.dialer;
    out.stop.abort();
    const code = await run(out, "a2a", join(dir, "out.json"));
    expect([0, 1]).toContain(code);

    expect(await run(a, "bot")).toBe(1);
    await fs.writeFile(join(dir, "bad.json"), "{");
    expect(await run(a, "bot", join(dir, "bad.json"))).toBe(1);
    expect(said(a)).toMatch(/not valid JSON/);
  }, 30_000);

  it("explains recover's needs and the relay's refusal", async () => {
    const relay = new RelayHarness();
    const { recoveryCode } = await makeMesh(relay, ["lost"]);
    const t = term(await scratch("cli-recover"), relay);
    expect(await run(t, "recover")).toBe(1);
    t.answers.push("y");
    expect(await run(t, "recover", recoveryCode!, "--relay", RELAY, "--revoke", "lost")).toBe(0);
    expect(said(t)).toMatch(/Recovered mesh/);
  });
});
