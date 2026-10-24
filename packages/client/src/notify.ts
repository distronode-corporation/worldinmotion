// Phone notifications: a short, content-free line ("1 message held for approval") through a
// configured provider. The provider choice is the owner's; `command` is the only one for now.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { readJson } from "./fsx.ts";

export interface Notifier {
  notify(text: string): Promise<void>;
}

export type NotifyConfig = { provider: "command"; command: string[]; minIntervalMs?: number };

/** Runs a program with the text as its last argument. Never through a shell, so nothing is interpreted. */
export class CommandNotifier implements Notifier {
  private last = Number.NEGATIVE_INFINITY;

  private readonly command: readonly string[];
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly run: typeof execFile;

  constructor(command: readonly string[], minIntervalMs = 60_000, now: () => number = Date.now, run: typeof execFile = execFile) {
    this.command = command;
    this.minIntervalMs = minIntervalMs;
    this.now = now;
    this.run = run;
    if (command.length === 0 || command.some((c) => typeof c !== "string" || c === "")) throw new TypeError("notify: command must be a non-empty list of strings");
  }

  notify(text: string, force = false): Promise<void> {
    const now = this.now();
    if (!force && now - this.last < this.minIntervalMs) return Promise.resolve();
    this.last = now;
    // Short and printable only: a notification is a nudge, never content.
    const line = text.replace(/[^\x20-\x7E]/g, " ").slice(0, 120);
    return new Promise((resolve, reject) => {
      this.run(this.command[0]!, [...this.command.slice(1), line], { shell: false, timeout: 15_000 }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }
}

/** A notifier that never fails the caller: a broken provider is logged, not raised. */
export function quiet(n: Notifier, log: (line: string) => void): Notifier {
  return { notify: (text) => n.notify(text).catch((e: unknown) => log(`wim: notification failed: ${(e as Error).message}`)) };
}

/** `$WIM_HOME/notify.json`, or undefined when there is none. */
export async function loadNotifier(home: string, now: () => number = Date.now): Promise<CommandNotifier | undefined> {
  const raw = (await readJson(join(home, "notify.json"))) as Partial<NotifyConfig> | undefined;
  if (raw === undefined) return undefined;
  if (raw.provider !== "command" || !Array.isArray(raw.command)) throw new Error("notify.json: provider must be \"command\" with a command list");
  return new CommandNotifier(raw.command, raw.minIntervalMs ?? 60_000, now);
}
