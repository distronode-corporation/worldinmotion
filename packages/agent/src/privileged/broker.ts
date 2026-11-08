// The token broker: the privileged side writes a fresh identity token to a file only the
// worker's group can read, and replaces it on a timer while the job runs. The timer lives in
// this process and is unref'd, so nothing outlives the job or holds the caller's stdio (a
// backgrounded shell `sleep` once kept a caller's `| tail` open for minutes after the job).

/** Claude Code re-reads the token file when it refreshes; a token may be exchanged only once. */
export const REFRESH_MS = 240_000;

export interface BrokerFs {
  writeFile(path: string, data: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
}

export interface BrokerOptions {
  path: string;
  /** The worker's group, which alone may read the file (mode 0640, owner root). */
  gid: number;
  mint: () => Promise<string>;
  fs: BrokerFs;
  log: (line: string) => void;
  /** Whether to chown: only root can, and tests run as a user. */
  chown: boolean;
  /** Timers that must not keep the process alive (unref'd). */
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (timer: unknown) => void;
}

export class TokenBroker {
  private readonly o: BrokerOptions;
  private timer: unknown;
  private refreshing: Promise<void> = Promise.resolve();

  constructor(options: BrokerOptions) {
    this.o = options;
  }

  /** Writes the first token; a failure here fails the job before the worker starts. */
  async start(): Promise<void> {
    await this.write();
    this.timer = this.o.setInterval(() => {
      this.refreshing = this.write().catch((error: unknown) => {
        // A failed refresh leaves the last token, which may still be valid; the job reports.
        this.o.log(`token refresh failed: ${(error as Error).name}`);
      });
    }, REFRESH_MS);
  }

  private async write(): Promise<void> {
    const token = await this.o.mint();
    const tmp = `${this.o.path}.new`;
    await this.o.fs.writeFile(tmp, token, 0o640);
    if (this.o.chown) await this.o.fs.chown(tmp, 0, this.o.gid);
    await this.o.fs.rename(tmp, this.o.path);
  }

  /** Stops refreshing and removes the token file. */
  async stop(): Promise<void> {
    this.o.clearInterval(this.timer);
    await this.refreshing;
    await this.o.fs.rm(this.o.path);
    await this.o.fs.rm(`${this.o.path}.new`);
  }
}
