// Closing the downgrade window early (SPEC section 6b, SECURITY-MODEL section 6.14): a device
// setting that refuses v0.1 boxes before 1.0, on send and on receive. `$WIM_HOME/legacy-boxes`
// holds `refuse` when the device refuses them; anything else, or no file, is the migration
// window, the default until 1.0. Every session of the device reads it at each send and each
// message it opens, so a change reaches running sessions at once.
//
// Turning it on (`wim legacy-boxes refuse`) only makes the device stricter, so anyone may. Turning
// it off (`wim legacy-boxes accept`) lets a relay strip forward secrecy again, so only a person
// at their own terminal may (requirePerson, then a typed yes), and no MCP tool or events op
// reaches either. Like every file in the state directory, the guard keeps agents from the command,
// not from the file (SECURITY-MODEL section 9).

import { promises as fs } from "node:fs";
import { writeAtomic, type FsEnv } from "./fsx.ts";

/** The setting's file, in the state directory. */
export const LEGACY_BOXES_FILE = "legacy-boxes";

/** The longest file read; anything longer is not the setting. */
const MAX_BYTES = 16;

/** Whether the device at `path`'s state directory refuses v0.1 boxes. A missing or unreadable file is the window. */
export async function refusesLegacy(path: string): Promise<boolean> {
  const text = await fs.readFile(path, "utf8").catch(() => "");
  return text.length <= MAX_BYTES && text.trim() === "refuse";
}

/** Writes the setting: `refuse` closes the window on this device, `accept` reopens it. */
export function setLegacyBoxes(path: string, refuse: boolean, env: FsEnv): Promise<void> {
  return writeAtomic(path, refuse ? "refuse\n" : "accept\n", env);
}

/** One line on the setting, for `wim status` and `wim doctor`. */
export function legacyBoxesLine(refuse: boolean): string {
  return refuse
    ? "v0.1 boxes are refused on this device: it never sends without forward secrecy and drops messages that arrive without it (`wim legacy-boxes`)"
    : "v0.1 boxes are accepted until 1.0 (the migration window): a relay that withholds prekeys can make a send go without forward secrecy. `wim legacy-boxes refuse` closes that on this device";
}

/** What a send that skipped devices says: each had no current prekey, and this device seals no v0.1 box. */
export function skippedNote(noPrekey: readonly string[]): string {
  return `Not sent to ${noPrekey.join(", ")}: no current prekey (a v0.1 client, or offline for over 48 hours), and this device refuses v0.1 boxes (\`wim legacy-boxes\`).`;
}

/** Why a direct send is refused: a device it names has no current prekey. */
export function refusedLine(noPrekey: readonly string[]): string {
  return `refused: no current prekey for ${noPrekey.join(", ")} (a v0.1 client, or offline for over 48 hours), and this device refuses v0.1 boxes, so nothing was sent. It goes once that device is online with a current client; \`wim legacy-boxes\` shows the setting.`;
}
