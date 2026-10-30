// The signer's passphrase from somewhere other than a terminal, and its start at log in
// (`wim agent autostart`, docs/design.md, the signer): a login item per platform that runs
// `wim agent start --foreground --ask-gui`, the native prompt `--ask-gui` shows, and the opt-in OS
// keyring `--keyring` reads (SECURITY-MODEL 5.8 says what each one exposes). Every function takes
// the platform as a parameter, so each platform's branch runs in the tests on any machine.

import { sha256, utf8 } from "@worldinmotion/protocol";
import { spawn as nodeSpawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { SetupError } from "./errors.ts";
import { ensureDir, readText, removeFile, writeAtomic, type FsEnv } from "./fsx.ts";
import { pathFor, type Platform } from "./platform.ts";

export type RunResult = { code: number | null; stdout: string; stderr: string };

/** Runs a program without a shell, `input` on its stdin; rejects when it cannot start (ENOENT: not installed). */
export type Run = (cmd: string, args: readonly string[], input?: string) => Promise<RunResult>;

/**
 * What `wim agent` runs: other programs, the platform whose programs, paths and keyring those are,
 * and wim itself (for the login item's command line).
 */
export type Programs = { platform: Platform; run: Run; wim: readonly string[] };

export function runProgram(cmd: string, args: readonly string[], input = "", spawn: typeof nodeSpawn = nodeSpawn): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.once("error", reject);
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => (stdout += d));
    child.stderr!.on("data", (d: string) => (stderr += d));
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    // A program that exits without reading its stdin makes the write fail (EPIPE): its exit says how it went.
    child.stdin!.on("error", () => undefined);
    child.stdin!.end(input);
  });
}

/** A program that is not installed gives undefined; any other failure to start is thrown. */
function unlessMissing(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  throw error;
}

// ---- the native passphrase prompt (`--ask-gui`) ----

export const GUI_TITLE = "worldinmotion";
export const GUI_ASK = "Passphrase for this device's worldinmotion keys (it starts the signer):";
export const GUI_AGAIN = "That passphrase did not open the keys. Passphrase for this device's worldinmotion keys:";

/**
 * A string in PowerShell's single quotes. PowerShell takes the typographic single quotes
 * (U+2018 to U+201B) as quote characters too, so each of those is doubled as well (O’Brien).
 */
export function psQuote(s: string): string {
  return `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}

/** A PowerShell script as `-EncodedCommand` takes it (UTF-16LE, base64): no command-line quoting to get wrong. */
export function psEncoded(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * The prompts to try, in order. macOS: an AppleScript dialog with a hidden answer. Windows: the
 * credential dialog of Windows PowerShell (5.1 shows a window; PowerShell 7 would ask in a console).
 * Elsewhere: zenity, then kdialog. Each prints the passphrase on stdout and exits non-zero on Cancel.
 */
export function guiPrompts(platform: Platform, text: string): Array<{ cmd: string; args: string[] }> {
  if (platform === "darwin") {
    const dialog = `display dialog "${text}" default answer "" with hidden answer with title "${GUI_TITLE}" buttons {"Cancel", "OK"} default button "OK"`;
    return [{ cmd: "osascript", args: ["-e", dialog, "-e", "text returned of result"] }];
  }
  if (platform === "win32") {
    const script = [
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
      `$c = Get-Credential -UserName ${psQuote(GUI_TITLE)} -Message ${psQuote(text)}`,
      "if ($null -eq $c) { exit 1 }",
      "[Console]::Out.Write($c.GetNetworkCredential().Password)",
    ].join("; ");
    return [{ cmd: "powershell.exe", args: ["-NoProfile", "-EncodedCommand", psEncoded(script)] }];
  }
  return [
    { cmd: "zenity", args: ["--entry", "--hide-text", `--title=${GUI_TITLE}`, `--text=${text}`] },
    { cmd: "kdialog", args: ["--title", GUI_TITLE, "--password", text] },
  ];
}

/**
 * Asks the person for the passphrase in a native dialog: the first prompt program that is
 * installed and starts. One that fails to start (zenity with no display) says why on stderr, and
 * the next is tried; the last one's failure, or one that exits saying nothing, is a cancel.
 */
export async function askGui(platform: Platform, run: Run, text: string): Promise<string> {
  const prompts = guiPrompts(platform, text);
  let failure: string | undefined;
  for (const [i, p] of prompts.entries()) {
    const got = answered(await run(p.cmd, p.args).catch(unlessMissing), p.cmd, i === prompts.length - 1);
    if (typeof got === "string") return got;
    failure = got?.failed ?? failure;
  }
  throw new SetupError(
    failure === undefined
      ? "no passphrase prompt is available here (on Linux it needs zenity or kdialog in a desktop session): start the signer with `wim agent start` in your own terminal"
      : `no passphrase prompt could be shown (${failure}): start the signer with \`wim agent start\` in your own terminal`,
  );
}

/** What one prompt gave: the passphrase, why it could not start ({ failed }), or undefined when it is not installed. */
function answered(r: RunResult | undefined, cmd: string, last: boolean): string | { failed: string } | undefined {
  if (r === undefined) return undefined;
  if (r.code === 0) return r.stdout.replace(/\r?\n$/, "");
  const why = r.stderr.trim();
  if (last || why === "") throw new SetupError("the passphrase prompt was cancelled");
  return { failed: `${cmd}: ${why.slice(0, 300)}` };
}

// ---- the OS keyring (`--keyring`, opt-in) ----

export type KeyringKind = "keychain" | "libsecret";

/**
 * Where the passphrase can be kept: the macOS login keychain, in an item that trusts no
 * application, so every read asks the person; libsecret elsewhere, which hands it to any process
 * of the user while the keyring is unlocked. Windows has none here: Credential Manager gives a
 * stored secret to any process of the user without asking, at any time.
 */
export function keyringKind(platform: Platform): KeyringKind | undefined {
  if (platform === "darwin") return "keychain";
  return platform === "win32" ? undefined : "libsecret";
}

export const NO_KEYRING =
  "--keyring is not offered on Windows: Credential Manager gives a stored passphrase to any program you run, agents included, without asking. Use the passphrase dialog instead (`wim agent autostart enable`)";

/** What the person is told before the passphrase is stored, per keyring. */
export const KEYRING_WARNING: Record<KeyringKind, string[]> = {
  keychain: [
    "The passphrase goes into your login keychain in an item that trusts no program, so macOS asks you each time something reads it, the signer included.",
    "Choose Allow when the signer starts at log in. Never choose Always Allow: that lets any program read it silently from then on, agents included. A prompt you did not expect means something else asked: choose Deny.",
  ],
  libsecret: [
    "WARNING: your keyring (libsecret) gives this passphrase to any program you run while the keyring is unlocked, which is all the time you are logged in. That includes agents and the tools they run.",
    "An agent that reads it can decrypt device.json offline and act as this device: this undoes the protection the signer gives against agents. The passphrase dialog (`wim agent autostart enable` without --keyring) does not.",
  ],
};

const SERVICE = "worldinmotion-signer";

/** The keyring account for a state directory: one stored passphrase per device. Hex, so no tool reads it as a flag. */
export function keyringAccount(root: string): string {
  return Buffer.from(sha256(utf8(root))).toString("hex").slice(0, 16);
}

function keyringOf(platform: Platform): KeyringKind {
  const kind = keyringKind(platform);
  if (kind === undefined) throw new SetupError(NO_KEYRING);
  return kind;
}

/** The program a keyring needs, refused with a hint when it is not installed. */
function tool(cmd: string): (error: unknown) => never {
  return (error) => {
    unlessMissing(error);
    throw new SetupError(`${cmd} is not installed${cmd === "secret-tool" ? " (the libsecret-tools package)" : ""}`);
  };
}

/**
 * Stores the passphrase, hex-encoded so every tool hands it back unchanged. In the keychain the
 * item is added in `security`'s interactive mode, so the passphrase goes over stdin and never
 * appears in a command line another process can list, with `-T ""`: no trusted application.
 */
export async function keyringStore(platform: Platform, run: Run, account: string, passphrase: string): Promise<void> {
  const kind = keyringOf(platform);
  const hex = Buffer.from(passphrase, "utf8").toString("hex");
  if (kind === "keychain") {
    await run("security", ["delete-generic-password", "-a", account, "-s", SERVICE]).catch(tool("security"));
    await run("security", ["-i"], `add-generic-password -a ${account} -s ${SERVICE} -l ${SERVICE} -T "" -w ${hex}\n`).catch(tool("security"));
    // Its attributes only: no secret is read, so nothing asks.
    stored(await run("security", ["find-generic-password", "-a", account, "-s", SERVICE]).catch(tool("security")));
    return;
  }
  stored(await run("secret-tool", ["store", `--label=${SERVICE}`, "service", SERVICE, "account", account], hex).catch(tool("secret-tool")));
}

function stored(r: RunResult): void {
  if (r.code !== 0) throw new SetupError(`the keyring did not store the passphrase: ${(r.stderr.trim() || `exit code ${r.code}`).slice(0, 300)}`);
}

/** Reads the stored passphrase. In the keychain macOS asks the person first. */
export async function keyringRead(platform: Platform, run: Run, account: string): Promise<string> {
  const r =
    keyringOf(platform) === "keychain"
      ? await run("security", ["find-generic-password", "-a", account, "-s", SERVICE, "-w"]).catch(tool("security"))
      : await run("secret-tool", ["lookup", "service", SERVICE, "account", account]).catch(tool("secret-tool"));
  return decodeStored(r);
}

function decodeStored(r: RunResult): string {
  const hex = r.stdout.trim();
  if (r.code !== 0 || !/^(?:[0-9a-f]{2})+$/.test(hex)) {
    throw new SetupError("no passphrase could be read from the keyring (not stored, or the read was denied): `wim agent autostart enable --keyring` stores it");
  }
  return Buffer.from(hex, "hex").toString("utf8");
}

/** Removes a stored passphrase, if any. A keyring that is not there has nothing stored. */
export async function keyringClear(platform: Platform, run: Run, account: string): Promise<void> {
  const kind = keyringKind(platform);
  if (kind === "keychain") await run("security", ["delete-generic-password", "-a", account, "-s", SERVICE]).catch(unlessMissing);
  else if (kind === "libsecret") await run("secret-tool", ["clear", "service", SERVICE, "account", account]).catch(unlessMissing);
}

// ---- the login item ----

/** Where the login item gets the passphrase. */
export type LoginSource = "ask-gui" | "keyring";

export type AutostartOptions = {
  /** The platform the login item is for (its kind and where it goes). */
  platform: Platform;
  homedir: string;
  env: Record<string, string | undefined>;
  /** The state directory, pinned in the login item as WIM_HOME. */
  root: string;
  programs: Programs;
  /** The machine this runs on, for the files written here. */
  fsEnv: FsEnv;
};

/**
 * A login item: a launchd agent (macOS), an XDG autostart entry (Linux and the rest) or a logon
 * task (Windows); `log` is the file its output and errors are appended to, so a start that fails
 * before the signer runs (a cancelled dialog, a missing prompt tool) says why somewhere.
 */
export type LoginItem = { kind: "launchd" | "xdg" | "task"; where: string; text: string; log: string };

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * One argument of a desktop entry's Exec key: quoted when it holds anything but plain characters,
 * with `"`, `` ` ``, `$` and `\` escaped inside the quotes; then the string escape the whole value
 * gets (a backslash doubled) and `%`, which is a field code there, doubled.
 */
export function execArg(a: string): string {
  if (/[\n\r]/.test(a)) throw new SetupError(`a login item cannot run a path with a line break in it: ${JSON.stringify(a)}`);
  const quoted = /^[A-Za-z0-9_\-./=:@+,]+$/.test(a) ? a : `"${a.replace(/["`$\\]/g, "\\$&")}"`;
  return quoted.replace(/\\/g, "\\\\").replace(/%/g, "%%");
}

/** The Windows account the logon task is for: DOMAIN\user. */
function windowsUser(env: Record<string, string | undefined>): string {
  const user = env["USERNAME"];
  if (user === undefined || user === "") throw new SetupError("USERNAME is not set, so the logon task cannot name its user");
  const domain = env["USERDOMAIN"];
  return domain === undefined || domain === "" ? user : `${domain}\\${user}`;
}

/** The login item for this state directory, and what it runs. Nothing is written. */
export function loginItem(o: AutostartOptions, source: LoginSource): LoginItem {
  const path = pathFor(o.platform);
  const id = keyringAccount(o.root);
  const command = [...o.programs.wim, "agent", "start", "--foreground", `--${source}`];
  const log = path.join(o.root, "agent", "autostart.log");
  if (o.platform === "darwin") {
    const label = `worldinmotion.signer.${id}`;
    const strings = (items: readonly string[]): string => items.map((s) => `    <string>${xml(s)}</string>`).join("\n");
    const text = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key><string>${label}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      strings(command),
      "  </array>",
      `  <key>EnvironmentVariables</key><dict><key>WIM_HOME</key><string>${xml(o.root)}</string></dict>`,
      `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
      `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
      "  <key>RunAtLoad</key><true/>",
      "  <key>ProcessType</key><string>Interactive</string>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n");
    return { kind: "launchd", where: path.join(o.homedir, "Library", "LaunchAgents", `${label}.plist`), text, log };
  }
  if (o.platform === "win32") {
    const user = xml(windowsUser(o.env));
    const script = `$env:WIM_HOME = ${psQuote(o.root)}; & ${command.map(psQuote).join(" ")} *>> ${psQuote(log)}; exit $LASTEXITCODE`;
    const text = [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      `  <RegistrationInfo><Description>Starts the worldinmotion signer at log on: wim agent start --foreground --${source}</Description></RegistrationInfo>`,
      `  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${user}</UserId></LogonTrigger></Triggers>`,
      `  <Principals><Principal id="Author"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
      "  <Settings>",
      "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
      "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
      "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
      // The signer runs for the whole session: no time limit, which would otherwise end it after 72 hours.
      "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
      "    <Enabled>true</Enabled>",
      "  </Settings>",
      `  <Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>-NoProfile -WindowStyle Hidden -EncodedCommand ${psEncoded(script)}</Arguments></Exec></Actions>`,
      "</Task>",
      "",
    ].join("\r\n");
    return { kind: "task", where: `worldinmotion signer ${id}`, text, log };
  }
  const config = o.env["XDG_CONFIG_HOME"] || path.join(o.homedir, ".config");
  const text = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=worldinmotion signer",
    "Comment=Starts the worldinmotion signer, which asks for the passphrase of this device's keys",
    // sh appends the command's output to the log; the paths reach it as arguments, never as script text.
    `Exec=${["env", `WIM_HOME=${o.root}`, "sh", "-c", 'log="$1"; shift; exec "$@" >>"$log" 2>&1', "sh", log, ...command].map(execArg).join(" ")}`,
    "Terminal=false",
    "NoDisplay=true",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
  return { kind: "xdg", where: path.join(config, "autostart", `worldinmotion-signer-${id}.desktop`), text, log };
}

/** Installs the login item, replacing any earlier one for this state directory. */
export async function enableAutostart(o: AutostartOptions, source: LoginSource): Promise<LoginItem> {
  const item = loginItem(o, source);
  const here = pathFor(o.fsEnv.platform);
  // The log's directory is the signer's own (0700); launchd does not create it.
  await ensureDir(here.join(o.root, "agent"));
  if (item.kind !== "task") {
    await ensureDir(here.dirname(item.where));
    await writeAtomic(item.where, item.text, o.fsEnv);
    return item;
  }
  // schtasks reads a task definition only from a file, in UTF-16 with its byte order mark.
  const file = here.join(o.root, "agent", "autostart-task.xml");
  await ensureDir(here.dirname(file));
  await fs.writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(item.text, "utf16le")]), { mode: 0o600 });
  try {
    created(await o.programs.run("schtasks", ["/Create", "/TN", item.where, "/XML", file, "/F"]));
  } finally {
    await removeFile(file);
  }
  return item;
}

function created(r: RunResult): void {
  if (r.code !== 0) throw new SetupError(`schtasks could not create the logon task: ${detail(r)}`);
}

/** What schtasks said about a failure. */
function detail(r: RunResult): string {
  return (r.stderr.trim() || r.stdout.trim() || `exit code ${r.code}`).slice(0, 300);
}

/**
 * Whether the logon task exists, from the list of every task: a failed `/Query /TN` or `/Delete`
 * does not say why in a form to rely on (Windows translates its messages), so the list decides
 * between "no such task" and a real failure, which is reported.
 */
async function taskExists(o: AutostartOptions, name: string): Promise<boolean> {
  return listed(await o.programs.run("schtasks", ["/Query", "/FO", "CSV", "/NH"]), name);
}

function listed(r: RunResult, name: string): boolean {
  if (r.code !== 0) throw new SetupError(`schtasks could not list the scheduled tasks: ${detail(r)}`);
  return r.stdout.includes(`"\\${name}"`);
}

/** A failed schtasks call on a task that is there is an error; on one that is not, there is nothing. */
function unlessThere(exists: boolean, what: string, r: RunResult): undefined {
  if (exists) throw new SetupError(`schtasks could not ${what} the logon task: ${detail(r)}`);
  return undefined;
}

/** Removes the login item; true when there was one. */
export async function disableAutostart(o: AutostartOptions): Promise<boolean> {
  const item = loginItem(o, "ask-gui");
  if (item.kind === "task") {
    const r = await o.programs.run("schtasks", ["/Delete", "/TN", item.where, "/F"]);
    if (r.code === 0) return true;
    unlessThere(await taskExists(o, item.where), "delete", r);
    return false;
  }
  const existed = (await readText(item.where)) !== undefined;
  await removeFile(item.where);
  return existed;
}

/** The login item installed for this state directory, if any, and where it gets the passphrase. */
export async function autostartStatus(o: AutostartOptions): Promise<{ where: string; source: LoginSource; log: string } | undefined> {
  const item = loginItem(o, "ask-gui");
  const text = item.kind === "task" ? await taskText(o, item.where) : await readText(item.where);
  return text === undefined ? undefined : { where: item.where, source: text.includes("--keyring") ? "keyring" : "ask-gui", log: item.log };
}

async function taskText(o: AutostartOptions, name: string): Promise<string | undefined> {
  const r = await o.programs.run("schtasks", ["/Query", "/TN", name, "/XML"]);
  return r.code === 0 ? r.stdout : unlessThere(await taskExists(o, name), "read", r);
}
