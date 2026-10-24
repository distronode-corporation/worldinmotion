import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

/** Entries untouched for this long are forgotten. */
export const KEEP_MS = 7 * 24 * 3_600_000;

const Child = z.strictObject({ name: z.string(), phase: z.string() });

const Pipeline = z.strictObject({
  /** The last phase announced (or seeded), such as `running` or `failed`. */
  phase: z.string(),
  /** The provider's `updated_at` when this entry was last fully processed. */
  updatedAt: z.string(),
  ref: z.string(),
  sha: z.string(),
  webUrl: z.string(),
  /** Downstream pipelines, keyed by bridge job id (GitLab only). */
  children: z.record(z.string(), Child),
  /** When anything about this entry last changed, in epoch milliseconds. */
  touched: z.number(),
});

const Deployment = z.strictObject({ phase: z.string(), touched: z.number() });

const Source = z.strictObject({
  seeded: z.boolean(),
  /** Server timestamps that bound the next `updated_after` queries. */
  cursors: z.record(z.string(), z.string()),
  pipelines: z.record(z.string(), Pipeline),
  deployments: z.record(z.string(), Deployment),
});

const StateFile = z.strictObject({
  version: z.literal(1),
  sources: z.record(z.string(), Source),
});

export type PipelineEntry = z.infer<typeof Pipeline>;
export type ChildEntry = z.infer<typeof Child>;
export type DeploymentEntry = z.infer<typeof Deployment>;
export type SourceState = z.infer<typeof Source>;
type StateData = z.infer<typeof StateFile>;

/** What has been announced, persisted so a restart does not announce it again. */
export class StateStore {
  private writing: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly data: StateData;
  private readonly now: () => number;

  private constructor(path: string, data: StateData, now: () => number) {
    this.path = path;
    this.data = data;
    this.now = now;
  }

  /**
   * Opens the state file. A missing file starts empty; an unreadable or invalid one is reported
   * and also starts empty, which means the next poll seeds silently rather than flooding the room.
   */
  static async open(path: string, now: () => number, log: (line: string) => void): Promise<StateStore> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`ci: cannot read state ${path} (${(err as Error).message}); starting fresh`);
      }
      return new StateStore(path, { version: 1, sources: {} }, now);
    }
    let parsed: StateData | undefined;
    try {
      parsed = StateFile.parse(JSON.parse(text));
    } catch {
      log(`ci: state ${path} is not valid; starting fresh`);
    }
    return new StateStore(path, parsed ?? { version: 1, sources: {} }, now);
  }

  source(key: string): SourceState {
    let s = this.data.sources[key];
    if (s === undefined) {
      s = { seeded: false, cursors: {}, pipelines: {}, deployments: {} };
      this.data.sources[key] = s;
    }
    return s;
  }

  /** Drops entries untouched for seven days. */
  prune(): void {
    const oldest = this.now() - KEEP_MS;
    for (const s of Object.values(this.data.sources)) {
      for (const map of [s.pipelines, s.deployments]) {
        for (const [id, entry] of Object.entries(map)) {
          if (entry.touched < oldest) delete map[id];
        }
      }
    }
  }

  /** Prunes and writes atomically. Writes are chained so an older snapshot never lands last. */
  save(): Promise<void> {
    const next = this.writing.then(() => this.write());
    this.writing = next.catch(() => undefined);
    return next;
  }

  private async write(): Promise<void> {
    this.prune();
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
