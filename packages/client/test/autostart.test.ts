// The login item, the native passphrase prompt and the OS keyring of `wim agent`, each platform's
// branch run here by passing the platform: nothing touches a real keyring, dialog or login item.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  askGui,
  autostartStatus,
  disableAutostart,
  enableAutostart,
  execArg,
  GUI_ASK,
  guiPrompts,
  keyringAccount,
  keyringClear,
  keyringKind,
  keyringRead,
  keyringStore,
  loginItem,
  NO_KEYRING,
  psEncoded,
  psQuote,
  runProgram,
  type AutostartOptions,
  type Run,
  type RunResult,
} from "../src/autostart.ts";
import { scratch } from "./helpers.ts";

type Call = { cmd: string; args: readonly string[]; input: string | undefined };

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const failed = (stderr = "", code: number | null = 1): RunResult => ({ code, stdout: "", stderr });
const missing = (): Error => Object.assign(new Error("spawn x ENOENT"), { code: "ENOENT" });

/** A stand-in for running programs: `answer` decides each call's result; every call is recorded. */
function programs(answer: (cmd: string, args: readonly string[], input: string | undefined) => RunResult | Error | Promise<RunResult>): { run: Run; calls: Call[] } {
  const calls: Call[] = [];
  const run: Run = async (cmd, args, input) => {
    calls.push({ cmd, args, input });
    const r = await answer(cmd, args, input);
    if (r instanceof Error) throw r;
    return r;
  };
  return { run, calls };
}

const hex = (s: string): string => Buffer.from(s, "utf8").toString("hex");
const FS = { platform: process.platform, pid: process.pid };

async function options(platform: string, run: Run, env: Record<string, string | undefined> = {}): Promise<AutostartOptions> {
  const home = await scratch("autostart");
  return { platform, homedir: home, env, root: join(home, "state dir"), programs: { platform, run, wim: ["/usr/bin/node", "/opt/wim/wim.mjs"] }, fsEnv: FS };
}

describe("runProgram", () => {
  it("passes stdin and returns the exit code, stdout and stderr", async () => {
    const r = await runProgram(process.execPath, ["-e", 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(s.toUpperCase());process.stderr.write("e");process.exit(3)})'], "pass");
    expect(r).toEqual({ code: 3, stdout: "PASS", stderr: "e" });
  });

  it("gives no stdin by default, survives a child that never reads it, and rejects a program that is not there", async () => {
    expect(await runProgram(process.execPath, ["-e", "process.stdin.on('data',()=>{}).on('end',()=>process.stdout.write('eof'))"])).toEqual({ code: 0, stdout: "eof", stderr: "" });
    expect((await runProgram(process.execPath, ["-e", "process.exit(0)"], "x".repeat(1 << 20))).code).toBe(0);
    await expect(runProgram("wim-no-such-program-here", [])).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("the native passphrase prompt", () => {
  it("is a dialog per platform, with zenity before kdialog elsewhere", () => {
    const mac = guiPrompts("darwin", GUI_ASK);
    expect(mac.map((p) => p.cmd)).toEqual(["osascript"]);
    expect(mac[0]!.args[1]).toContain("with hidden answer");
    expect(guiPrompts("linux", "T").map((p) => [p.cmd, ...p.args])).toEqual([
      ["zenity", "--entry", "--hide-text", "--title=worldinmotion", "--text=T"],
      ["kdialog", "--title", "worldinmotion", "--password", "T"],
    ]);
    const win = guiPrompts("win32", "it's");
    expect(win[0]!.cmd).toBe("powershell.exe");
    const script = Buffer.from(win[0]!.args[2]!, "base64").toString("utf16le");
    expect(script).toContain("Get-Credential -UserName 'worldinmotion' -Message 'it''s'");
    expect(script).toContain("GetNetworkCredential().Password");
  });

  it("returns what was typed, without the newline the tool adds", async () => {
    const { run } = programs(() => ok("pass phrase\n"));
    expect(await askGui("darwin", run, GUI_ASK)).toBe("pass phrase");
    const crlf = programs(() => ok("pass phrase\r\n"));
    expect(await askGui("win32", crlf.run, GUI_ASK)).toBe("pass phrase");
    const bare = programs(() => ok(" spaces kept "));
    expect(await askGui("win32", bare.run, GUI_ASK)).toBe(" spaces kept ");
  });

  it("tries the next tool when one is not installed, and says when none is", async () => {
    const one = programs((cmd) => (cmd === "zenity" ? missing() : ok("p\n")));
    expect(await askGui("linux", one.run, GUI_ASK)).toBe("p");
    expect(one.calls.map((c) => c.cmd)).toEqual(["zenity", "kdialog"]);
    const none = programs(() => missing());
    await expect(askGui("linux", none.run, GUI_ASK)).rejects.toThrow(/no passphrase prompt is available here.*zenity or kdialog/);
  });

  it("refuses a cancelled prompt, and passes on a failure that is not a missing tool", async () => {
    const cancel = programs(() => failed("", 1));
    await expect(askGui("linux", cancel.run, GUI_ASK)).rejects.toThrow("the passphrase prompt was cancelled");
    expect(cancel.calls).toHaveLength(1);
    const broken = programs(() => Object.assign(new Error("EACCES"), { code: "EACCES" }));
    await expect(askGui("darwin", broken.run, GUI_ASK)).rejects.toThrow("EACCES");
  });

  it("quotes and encodes for PowerShell", () => {
    expect(psQuote("a'b")).toBe("'a''b'");
    expect(psQuote("C:\\Users\\O\u2019Brien \u2018x\u201A\u201B")).toBe("'C:\\Users\\O\u2019\u2019Brien \u2018\u2018x\u201A\u201A\u201B\u201B'");
    expect(Buffer.from(psEncoded("é"), "base64").toString("utf16le")).toBe("é");
  });
});

describe("the keyring", () => {
  it("is the keychain on macOS, libsecret elsewhere, and none on Windows", () => {
    expect(keyringKind("darwin")).toBe("keychain");
    expect(keyringKind("linux")).toBe("libsecret");
    expect(keyringKind("freebsd")).toBe("libsecret");
    expect(keyringKind("win32")).toBeUndefined();
  });

  it("names one account per state directory, in hex", () => {
    expect(keyringAccount("/a")).toMatch(/^[0-9a-f]{16}$/);
    expect(keyringAccount("/a")).not.toBe(keyringAccount("/b"));
  });

  it("stores in the keychain over stdin, trusting no application, and checks it is there", async () => {
    const p = programs(() => ok());
    await keyringStore("darwin", p.run, "acct", "pässword");
    expect(p.calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ["security", "delete-generic-password", "-a", "acct", "-s", "worldinmotion-signer"],
      ["security", "-i"],
      ["security", "find-generic-password", "-a", "acct", "-s", "worldinmotion-signer"],
    ]);
    // The passphrase is in no command line, only on stdin, and the item trusts no application.
    expect(p.calls.flatMap((c) => c.args).join(" ")).not.toContain(hex("pässword"));
    expect(p.calls[1]!.input).toBe(`add-generic-password -a acct -s worldinmotion-signer -l worldinmotion-signer -T "" -w ${hex("pässword")}\n`);
  });

  it("stores in libsecret over stdin", async () => {
    const p = programs(() => ok());
    await keyringStore("linux", p.run, "acct", "pass");
    expect(p.calls).toEqual([{ cmd: "secret-tool", args: ["store", "--label=worldinmotion-signer", "service", "worldinmotion-signer", "account", "acct"], input: hex("pass") }]);
  });

  it("says when storing fails, when the tool is missing, and that Windows has no keyring here", async () => {
    await expect(keyringStore("linux", programs(() => failed("Cannot create an item in a locked collection\n")).run, "a", "p")).rejects.toThrow(
      "the keyring did not store the passphrase: Cannot create an item in a locked collection",
    );
    await expect(keyringStore("darwin", programs((_c, args) => (args[0] === "find-generic-password" ? failed("", 44) : ok())).run, "a", "p")).rejects.toThrow("exit code 44");
    await expect(keyringStore("linux", programs(() => missing()).run, "a", "p")).rejects.toThrow("secret-tool is not installed (the libsecret-tools package)");
    await expect(keyringStore("darwin", programs(() => missing()).run, "a", "p")).rejects.toThrow(/^security is not installed$/);
    await expect(keyringStore("win32", programs(() => ok()).run, "a", "p")).rejects.toThrow(NO_KEYRING);
    await expect(keyringStore("linux", programs(() => Object.assign(new Error("EACCES"), { code: "EACCES" })).run, "a", "p")).rejects.toThrow("EACCES");
  });

  it("reads back what was stored, in either keyring", async () => {
    const mac = programs(() => ok(`${hex("pässword")}\n`));
    expect(await keyringRead("darwin", mac.run, "acct")).toBe("pässword");
    expect(mac.calls[0]!.args).toEqual(["find-generic-password", "-a", "acct", "-s", "worldinmotion-signer", "-w"]);
    const lin = programs(() => ok(hex("pass")));
    expect(await keyringRead("linux", lin.run, "acct")).toBe("pass");
    expect(lin.calls[0]!.args).toEqual(["lookup", "service", "worldinmotion-signer", "account", "acct"]);
  });

  it("refuses a read that was denied, found nothing or gave something else", async () => {
    const none = /no passphrase could be read from the keyring/;
    await expect(keyringRead("darwin", programs(() => failed("SecKeychainSearchCopyNext: The specified item could not be found.")).run, "a")).rejects.toThrow(none);
    await expect(keyringRead("linux", programs(() => ok("")).run, "a")).rejects.toThrow(none);
    await expect(keyringRead("linux", programs(() => ok("not hex")).run, "a")).rejects.toThrow(none);
    await expect(keyringRead("linux", programs(() => ok("abc")).run, "a")).rejects.toThrow(none);
    await expect(keyringRead("linux", programs(() => missing()).run, "a")).rejects.toThrow("secret-tool is not installed");
    await expect(keyringRead("darwin", programs(() => missing()).run, "a")).rejects.toThrow("security is not installed");
    await expect(keyringRead("win32", programs(() => ok()).run, "a")).rejects.toThrow(NO_KEYRING);
  });

  it("clears what was stored, and nothing where there is no keyring or no tool", async () => {
    const mac = programs(() => failed());
    await keyringClear("darwin", mac.run, "acct");
    expect(mac.calls.map((c) => c.args[0])).toEqual(["delete-generic-password"]);
    const lin = programs(() => missing());
    await keyringClear("linux", lin.run, "acct");
    expect(lin.calls.map((c) => c.args[0])).toEqual(["clear"]);
    const win = programs(() => ok());
    await keyringClear("win32", win.run, "acct");
    expect(win.calls).toHaveLength(0);
    await expect(keyringClear("linux", programs(() => Object.assign(new Error("EACCES"), { code: "EACCES" })).run, "a")).rejects.toThrow("EACCES");
  });
});

describe("the login item", () => {
  it("on macOS is a launchd agent that runs the signer in the foreground with the dialog", async () => {
    const o = await options("darwin", programs(() => ok()).run);
    const item = loginItem(o, "ask-gui");
    expect(item.kind).toBe("launchd");
    expect(item.where).toBe(`${o.homedir}/Library/LaunchAgents/worldinmotion.signer.${keyringAccount(o.root)}.plist`);
    expect(item.text).toContain("<string>/opt/wim/wim.mjs</string>\n    <string>agent</string>\n    <string>start</string>\n    <string>--foreground</string>\n    <string>--ask-gui</string>");
    expect(item.text).toContain(`<key>WIM_HOME</key><string>${o.root}</string>`);
    expect(item.log).toBe(`${o.root}/agent/autostart.log`);
    expect(item.text).toContain(`<key>StandardOutPath</key><string>${item.log}</string>\n  <key>StandardErrorPath</key><string>${item.log}</string>`);
    expect(item.text).toContain("<key>RunAtLoad</key><true/>");
    expect(loginItem({ ...o, root: "/a&b<c>\"d" }, "keyring").text).toContain("<string>/a&amp;b&lt;c&gt;&quot;d</string>");
    expect(loginItem(o, "keyring").text).toContain("<string>--keyring</string>");
  });

  it("elsewhere is an XDG autostart entry, under XDG_CONFIG_HOME when it is set", async () => {
    const o = await options("linux", programs(() => ok()).run);
    const item = loginItem(o, "ask-gui");
    expect(item.kind).toBe("xdg");
    expect(item.where).toBe(`${o.homedir}/.config/autostart/worldinmotion-signer-${keyringAccount(o.root)}.desktop`);
    expect(item.log).toBe(`${o.root}/agent/autostart.log`);
    expect(item.text).toContain(
      `Exec=env ${execArg(`WIM_HOME=${o.root}`)} sh -c ${execArg('log="$1"; shift; exec "$@" >>"$log" 2>&1')} sh ${execArg(item.log)} /usr/bin/node /opt/wim/wim.mjs agent start --foreground --ask-gui\n`,
    );
    // The script reaches sh as one argument, its quotes and dollars escaped for the desktop entry.
    expect(execArg('log="$1"; shift; exec "$@" >>"$log" 2>&1')).toBe('"log=\\\\\"\\\\$1\\\\\"; shift; exec \\\\\"\\\\$@\\\\\" >>\\\\\"\\\\$log\\\\\" 2>&1"');
    expect(execArg("WIM_HOME=/home/a b")).toBe('"WIM_HOME=/home/a b"');
    expect(item.text).toMatch(/^\[Desktop Entry\]\nType=Application\n/);
    expect(loginItem({ ...o, env: { XDG_CONFIG_HOME: "/xdg" } }, "keyring").where).toMatch(/^\/xdg\/autostart\/worldinmotion-signer-[0-9a-f]{16}\.desktop$/);
    expect(loginItem({ ...o, env: { XDG_CONFIG_HOME: "" } }, "keyring").where).toBe(item.where);
  });

  it("quotes an Exec argument as the desktop entry spec says", () => {
    expect(execArg("/usr/bin/node")).toBe("/usr/bin/node");
    expect(execArg("/a b")).toBe('"/a b"');
    expect(execArg('a"b`c$d')).toBe('"a\\\\"b\\\\`c\\\\$d"');
    expect(execArg("a\\b")).toBe('"a\\\\\\\\b"');
    expect(execArg("50%")).toBe('"50%%"');
    expect(() => execArg("a\nb")).toThrow(/line break/);
    expect(() => execArg("a\rb")).toThrow(/line break/);
  });

  it("on Windows is a logon task for this user, with no time limit, through a hidden PowerShell", async () => {
    const o = await options("win32", programs(() => ok()).run, { USERNAME: "sean", USERDOMAIN: "DESK" });
    const item = loginItem({ ...o, root: "C:\\Users\\sean\\it's" }, "ask-gui");
    expect(item.kind).toBe("task");
    expect(item.where).toMatch(/^worldinmotion signer [0-9a-f]{16}$/);
    expect(item.text).toContain("<LogonTrigger><Enabled>true</Enabled><UserId>DESK\\sean</UserId></LogonTrigger>");
    expect(item.text).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(item.text).toContain("wim agent start --foreground --ask-gui</Description>");
    const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)</.exec(item.text)![1]!;
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(
      "$env:WIM_HOME = 'C:\\Users\\sean\\it''s'; & '/usr/bin/node' '/opt/wim/wim.mjs' 'agent' 'start' '--foreground' '--ask-gui' *>> 'C:\\Users\\sean\\it''s\\agent\\autostart.log'; exit $LASTEXITCODE",
    );
    expect(loginItem({ ...o, env: { USERNAME: "sean" } }, "keyring").text).toContain("<UserId>sean</UserId>");
    expect(loginItem({ ...o, env: { USERNAME: "sean", USERDOMAIN: "" } }, "keyring").text).toContain("<UserId>sean</UserId>");
    expect(() => loginItem({ ...o, env: {} }, "ask-gui")).toThrow(/USERNAME is not set/);
    expect(() => loginItem({ ...o, env: { USERNAME: "" } }, "ask-gui")).toThrow(/USERNAME is not set/);
  });

  for (const platform of ["darwin", "linux"]) {
    it(`installs, reports and removes a file on ${platform}`, async () => {
      const o = await options(platform, programs(() => ok()).run);
      expect(await autostartStatus(o)).toBeUndefined();
      expect(await disableAutostart(o)).toBe(false);
      const item = await enableAutostart(o, "ask-gui");
      expect(await fs.readFile(item.where, "utf8")).toBe(item.text);
      expect(await autostartStatus(o)).toEqual({ where: item.where, source: "ask-gui", log: item.log });
      // The log's directory exists for launchd, private to the user.
      const agentDir = join(o.root, "agent");
      expect((await fs.stat(agentDir)).isDirectory()).toBe(true);
      if (process.platform !== "win32") expect((await fs.stat(agentDir)).mode & 0o077).toBe(0);
      await enableAutostart(o, "keyring");
      expect(await autostartStatus(o)).toEqual({ where: item.where, source: "keyring", log: item.log });
      expect(await disableAutostart(o)).toBe(true);
      expect(await autostartStatus(o)).toBeUndefined();
    });
  }

  it("creates, queries and deletes the logon task with schtasks, from a definition file it then removes", async () => {
    const tasks = new Map<string, string>();
    let file = "";
    const p = programs(async (_cmd, args) => {
      const [op, , name] = args;
      if (op === "/Create") {
        file = args[4]!;
        const bytes = await fs.readFile(file);
        expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
        tasks.set(name!, bytes.subarray(2).toString("utf16le"));
        return ok("SUCCESS");
      }
      if (op === "/Query") return tasks.has(name!) ? ok(tasks.get(name!)!) : failed("ERROR: The system cannot find the file specified.");
      return tasks.delete(name!) ? ok() : failed();
    });
    const o = await options("win32", p.run, { USERNAME: "sean" });
    expect(await autostartStatus(o)).toBeUndefined();
    expect(await disableAutostart(o)).toBe(false);
    const item = await enableAutostart(o, "ask-gui");
    expect(p.calls.at(-1)!.args).toEqual(["/Create", "/TN", item.where, "/XML", file, "/F"]);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(tasks.get(item.where)).toBe(item.text);
    expect(await autostartStatus(o)).toEqual({ where: item.where, source: "ask-gui", log: item.log });
    await enableAutostart(o, "keyring");
    expect(await autostartStatus(o)).toEqual({ where: item.where, source: "keyring", log: item.log });
    expect(await disableAutostart(o)).toBe(true);
    expect(tasks.size).toBe(0);
  });

  it("says why schtasks refused, and removes the definition file anyway", async () => {
    let file = "";
    const refuse = programs((_cmd, args) => {
      file = args[4]!;
      return failed("ERROR: Access is denied.\r\n");
    });
    const o = await options("win32", refuse.run, { USERNAME: "sean" });
    await expect(enableAutostart(o, "ask-gui")).rejects.toThrow("schtasks could not create the logon task: ERROR: Access is denied.");
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    const quiet = programs(() => ({ code: 1, stdout: "ERROR: The task XML is malformed.", stderr: "" }));
    await expect(enableAutostart({ ...o, programs: { ...o.programs, run: quiet.run } }, "ask-gui")).rejects.toThrow("the logon task: ERROR: The task XML is malformed.");
    const gone = programs(() => missing());
    await expect(enableAutostart({ ...o, programs: { ...o.programs, run: gone.run } }, "ask-gui")).rejects.toThrow("ENOENT");
  });
});
