// The login item, the native passphrase prompt and the OS keyring of `wim signer`, each platform's
// branch run here by passing the platform: nothing touches a real keyring, dialog or login item.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  askGui,
  autostartStatus,
  confirmGui,
  confirmPrompts,
  dialogProgram,
  realToolTrust,
  windowsRoot,
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
  type ToolTrust,
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
/** Every dialog program passes the ownership check (realToolTrust has its own tests). */
const OK: ToolTrust = async () => "ok";

async function options(platform: string, run: Run, env: Record<string, string | undefined> = {}): Promise<AutostartOptions> {
  const home = await scratch("autostart");
  return { platform, homedir: home, env, root: join(home, "state dir"), programs: { platform, run, wim: ["/usr/bin/node", "/opt/wim/wim.mjs"], trust: OK }, fsEnv: FS };
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

describe("runProgram's time limit and abort", () => {
  const forever = ["-e", "setInterval(() => {}, 1000)"];

  it("ends a program whose time ran out, or that was aborted before or while it ran, as stopped", async () => {
    expect(await runProgram(process.execPath, forever, "", { timeoutMs: 200 })).toMatchObject({ stopped: true });
    const abort = new AbortController();
    const running = runProgram(process.execPath, forever, "", { signal: abort.signal });
    setTimeout(() => abort.abort(), 200);
    expect(await running).toMatchObject({ stopped: true });
    expect(await runProgram(process.execPath, forever, "", { signal: abort.signal })).toMatchObject({ stopped: true });
    // One that ends by itself first is not stopped, and the signal is let go.
    const r = await runProgram(process.execPath, ["-e", "0"], "", { timeoutMs: 60_000, signal: new AbortController().signal });
    expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});

describe("the dialog programs", () => {
  it("are run by absolute path on every platform, never looked up on PATH", () => {
    for (const platform of ["linux", "darwin", "win32", "freebsd"]) {
      for (const p of [...guiPrompts(platform, "x"), ...confirmPrompts(platform, "x")]) expect(p.cmd).toMatch(/^(\/usr\/bin\/|[A-Za-z]:\\)/);
    }
    expect(dialogProgram("zenity")).toBe("/usr/bin/zenity");
    expect(dialogProgram("powershell", "D:\\Win")).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  it("take SystemRoot only when it is a Windows directory", () => {
    expect(windowsRoot("D:\\Win")).toBe("D:\\Win");
    for (const junk of [undefined, "", "Windows", "\\\\host\\share", "C:\\a\\b", "C:/Windows", "C:\\x\"y", "C:\\"]) expect(windowsRoot(junk)).toBe("C:\\Windows");
  });

  it("must be root's alone, file and directory, to be trusted; a missing one passes over", async () => {
    const at = (table: Record<string, { uid: number; mode: number } | string>) => async (p: string) => {
      const v = table[p];
      if (typeof v === "string") throw Object.assign(new Error(v), { code: v });
      if (v === undefined) throw new Error("unexpected path");
      return v;
    };
    const root = { uid: 0, mode: 0o40755 };
    const exe = { uid: 0, mode: 0o100755 };
    expect(await realToolTrust("linux", at({ "/usr/bin/zenity": exe, "/usr/bin": root }))("/usr/bin/zenity")).toBe("ok");
    expect(await realToolTrust("linux", at({ "/usr/bin/zenity": { uid: 1000, mode: 0o100755 }, "/usr/bin": root }))("/usr/bin/zenity")).toMatch(/^\/usr\/bin\/zenity is not root's alone/);
    expect(await realToolTrust("linux", at({ "/usr/bin/zenity": { uid: 0, mode: 0o100775 }, "/usr/bin": root }))("/usr/bin/zenity")).toMatch(/not root's alone/);
    expect(await realToolTrust("linux", at({ "/usr/bin/zenity": { uid: 0, mode: 0o100757 }, "/usr/bin": root }))("/usr/bin/zenity")).toMatch(/not root's alone/);
    expect(await realToolTrust("darwin", at({ "/usr/bin/zenity": exe, "/usr/bin": { uid: 501, mode: 0o40755 } }))("/usr/bin/zenity")).toMatch(/^\/usr\/bin is not root's alone/);
    expect(await realToolTrust("linux", at({ "/usr/bin/zenity": exe, "/usr/bin": { uid: 0, mode: 0o40777 } }))("/usr/bin/zenity")).toMatch(/^\/usr\/bin is not root's alone/);
    expect(await realToolTrust("linux", at({ "/usr/bin/zenity": "ENOENT" }))("/usr/bin/zenity")).toBe("missing");
    expect(await realToolTrust("linux", at({ "/usr/bin/zenity": "EACCES" }))("/usr/bin/zenity")).toBe("/usr/bin/zenity cannot be checked (EACCES), so it is not trusted to ask you");
    expect(await realToolTrust("linux", at({ "/usr/bin/zenity": exe, "/usr/bin": "ENOENT" }))("/usr/bin/zenity")).toMatch(/^\/usr\/bin cannot be checked \(ENOENT\)/);
    expect(await realToolTrust("win32", at({}))("C:\\Windows\\System32\\x.exe")).toBe("ok");
    // A real file of this user's, with the real stat: refused (a root run owns it, and then it is root's own).
    const dir = await scratch("trust");
    await fs.writeFile(join(dir, "zenity"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const mine = await realToolTrust(process.platform === "win32" ? "linux" : process.platform)(join(dir, "zenity"));
    if (process.getuid?.() !== 0) expect(mine).toMatch(/is not root's alone|cannot be checked/);
    expect(await realToolTrust("linux")(join(dir, "none"))).toBe("missing");
  });

  it("refuse to ask in a program that is not trusted, and say why", async () => {
    const asked = programs(() => ok("p\n"));
    const refuse: ToolTrust = async (p) => (p.endsWith("zenity") ? "missing" : `${p} is not root's alone`);
    await expect(askGui("linux", asked.run, GUI_ASK, refuse)).rejects.toThrow("/usr/bin/kdialog is not root's alone");
    await expect(confirmGui("linux", asked.run, ["x"], refuse)).rejects.toThrow("/usr/bin/kdialog is not root's alone");
    expect(asked.calls).toEqual([]);
    // A dialog ended by its time or by the asker going away is a no; every dialog gets the time limit.
    const options: unknown[] = [];
    const stopped: Run = async (_c, _a, _i, o) => (options.push(o), { code: null, stdout: "", stderr: "", stopped: true });
    const signal = new AbortController().signal;
    expect(await confirmGui("linux", stopped, ["x"], OK, signal)).toBe(false);
    expect(await confirmGui("win32", stopped, ["x"], OK)).toBe(false);
    expect(options).toEqual([{ timeoutMs: 300_000, signal }, { timeoutMs: 300_000 }]);
    // Cancel is zenity's default button.
    expect(confirmPrompts("linux", "x")[0]!.args).toContain("--default-cancel");
  });
});

describe("the native passphrase prompt", () => {
  it("is a dialog per platform, with zenity before kdialog elsewhere", () => {
    const mac = guiPrompts("darwin", GUI_ASK);
    expect(mac.map((p) => p.cmd)).toEqual(["/usr/bin/osascript"]);
    expect(mac[0]!.args[3]).toContain("with hidden answer");
    // The text is argv, never script text.
    expect(guiPrompts("darwin", 'say "x"')[0]!.args.at(-1)).toBe('say "x"');
    expect(mac[0]!.args.slice(0, -1).join(" ")).not.toContain(GUI_ASK);
    expect(guiPrompts("linux", "T").map((p) => [p.cmd, ...p.args])).toEqual([
      ["/usr/bin/zenity", "--entry", "--hide-text", "--title=worldinmotion", "--text=T"],
      ["/usr/bin/kdialog", "--title", "worldinmotion", "--password", "T"],
    ]);
    const win = guiPrompts("win32", "it's");
    expect(win[0]!.cmd).toMatch(/^[A-Za-z]:\\[^\\]+\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    const script = Buffer.from(win[0]!.args[2]!, "base64").toString("utf16le");
    expect(script).toContain("Get-Credential -UserName 'worldinmotion' -Message 'it''s'");
    expect(script).toContain("GetNetworkCredential().Password");
  });

  it("returns what was typed, without the newline the tool adds", async () => {
    const { run } = programs(() => ok("pass phrase\n"));
    expect(await askGui("darwin", run, GUI_ASK, OK)).toBe("pass phrase");
    const crlf = programs(() => ok("pass phrase\r\n"));
    expect(await askGui("win32", crlf.run, GUI_ASK, OK)).toBe("pass phrase");
    const bare = programs(() => ok(" spaces kept "));
    expect(await askGui("win32", bare.run, GUI_ASK, OK)).toBe(" spaces kept ");
  });

  it("tries the next tool when one is not installed, and says when none is", async () => {
    const one = programs((cmd) => (cmd.endsWith("/zenity") ? missing() : ok("p\n")));
    expect(await askGui("linux", one.run, GUI_ASK, OK)).toBe("p");
    expect(one.calls.map((c) => c.cmd)).toEqual(["/usr/bin/zenity", "/usr/bin/kdialog"]);
    const none = programs(() => missing());
    await expect(askGui("linux", none.run, GUI_ASK, OK)).rejects.toThrow(/no passphrase prompt is available here.*zenity or kdialog/);
  });

  it("tries the next tool when one cannot start, and says why when none could", async () => {
    const noDisplay = failed("(zenity:4242): Gtk-WARNING **: cannot open display: \n");
    const next = programs((cmd) => (cmd.endsWith("/zenity") ? noDisplay : ok("p\n")));
    expect(await askGui("linux", next.run, GUI_ASK, OK)).toBe("p");
    expect(next.calls.map((c) => c.cmd)).toEqual(["/usr/bin/zenity", "/usr/bin/kdialog"]);
    const alone = programs((cmd) => (cmd.endsWith("/zenity") ? noDisplay : missing()));
    await expect(askGui("linux", alone.run, GUI_ASK, OK)).rejects.toThrow("no passphrase prompt could be shown (/usr/bin/zenity: (zenity:4242): Gtk-WARNING **: cannot open display:): start the signer");
    // The last tool's failure is taken as a cancel, as is macOS's own (osascript says so on stderr).
    const both = programs(() => noDisplay);
    await expect(askGui("linux", both.run, GUI_ASK, OK)).rejects.toThrow("the passphrase prompt was cancelled");
    const mac = programs(() => failed("execution error: User canceled. (-128)"));
    await expect(askGui("darwin", mac.run, GUI_ASK, OK)).rejects.toThrow("the passphrase prompt was cancelled");
    // zenity cancelled in a working dialog exits 1 too, with GTK's warnings on stderr: a cancel, no second dialog.
    const noisy = programs(() => failed("(zenity:4242): Gtk-WARNING **: Trying to measure GtkLabel 0x5a5d for height of 9, but it needs at least 24\n"));
    await expect(askGui("linux", noisy.run, GUI_ASK, OK)).rejects.toThrow("the passphrase prompt was cancelled");
    expect(noisy.calls.map((c) => c.cmd)).toEqual(["/usr/bin/zenity"]);
    // GTK 4 words it "Failed to open display" (zenity 4.2, measured).
    const gtk4 = programs((cmd) => (cmd.endsWith("/zenity") ? failed("(zenity:414040): Gtk-WARNING **: 23:07:26.318: Failed to open display\n") : ok("q\n")));
    expect(await askGui("linux", gtk4.run, GUI_ASK, OK)).toBe("q");
  });

  it("refuses a cancelled prompt, and passes on a failure that is not a missing tool", async () => {
    const cancel = programs(() => failed("", 1));
    await expect(askGui("linux", cancel.run, GUI_ASK, OK)).rejects.toThrow("the passphrase prompt was cancelled");
    expect(cancel.calls).toHaveLength(1);
    const broken = programs(() => Object.assign(new Error("EACCES"), { code: "EACCES" }));
    await expect(askGui("darwin", broken.run, GUI_ASK, OK)).rejects.toThrow("EACCES");
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
    expect(item.text).toContain("wim signer start --foreground --ask-gui</Description>");
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
      // Every task, as `/Query /FO CSV /NH` lists them (with another task, to be told apart).
      if (args[1] === "/FO") return ok([...tasks.keys(), "Other"].map((n) => `"\\${n}","N/A","Ready"\r\n`).join(""));
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

  it("reports a schtasks failure on a task that is there, and nothing for one that is not", async () => {
    const o = await options("win32", programs(() => ok()).run, { USERNAME: "sean" });
    const name = loginItem(o, "ask-gui").where;
    const answering = (listed: RunResult, failure: RunResult = failed("ERROR: Access is denied.")) =>
      ({ ...o, programs: { ...o.programs, run: programs((_c, args) => (args[1] === "/FO" ? listed : failure)).run } });
    const there = ok(`"\\${name}","N/A","Ready"\r\n`);
    await expect(disableAutostart(answering(there))).rejects.toThrow("schtasks could not delete the logon task: ERROR: Access is denied.");
    await expect(autostartStatus(answering(there))).rejects.toThrow("schtasks could not read the logon task: ERROR: Access is denied.");
    await expect(autostartStatus(answering(there, failed("", 5)))).rejects.toThrow("schtasks could not read the logon task: exit code 5");
    // A task whose name only ends like this one's is another task.
    const other = ok(`"\\x${name}","N/A","Ready"\r\n`);
    expect(await disableAutostart(answering(other))).toBe(false);
    expect(await autostartStatus(answering(other))).toBeUndefined();
    const down = failed("ERROR: The Task Scheduler service is not running.");
    await expect(disableAutostart(answering(down))).rejects.toThrow("schtasks could not list the scheduled tasks: ERROR: The Task Scheduler service is not running.");
    await expect(autostartStatus(answering(down))).rejects.toThrow("schtasks could not list the scheduled tasks");
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
