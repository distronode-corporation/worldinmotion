import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import type { ClientRequestArgs } from "node:http";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import { spkiPin } from "@worldinmotion/protocol";
import { onTestFinished } from "vitest";
import { WebSocket } from "ws";

/** Where test scratch directories go: `WIM_TEST_TMP` when set, else the system temp directory (honours TMPDIR). */
function scratchRoot(): string {
  return process.env["WIM_TEST_TMP"] || tmpdir();
}

/** A scratch directory under the user's cache (never the shared system temp), removed after the test. */
export async function scratchDir(): Promise<string> {
  const root = scratchRoot();
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "wim-relay-node-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A test client socket that buffers relay frames and hands them out in order. */
export class Dial {
  readonly ws: WebSocket;
  private readonly frames: Record<string, any>[] = [];
  private waiters: ((f: Record<string, any>) => void)[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(url: string, opts: ConstructorParameters<typeof WebSocket>[2] = {}) {
    this.ws = new WebSocket(url, opts);
    this.ws.on("message", (data: Buffer) => {
      const f = JSON.parse(data.toString("utf8")) as Record<string, any>;
      const w = this.waiters.shift();
      if (w) w(f);
      else this.frames.push(f);
    });
    this.closed = new Promise((resolve) => this.ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  next(): Promise<Record<string, any>> {
    const f = this.frames.shift();
    return f ? Promise.resolve(f) : new Promise((resolve) => this.waiters.push(resolve));
  }

  /** The next frame of type `t`, skipping others. */
  async nextOf(t: string): Promise<Record<string, any>> {
    for (;;) {
      const f = await this.next();
      if (f["t"] === t) return f;
    }
  }

  send(frame: unknown): void {
    this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }
}

/**
 * A TLS connection that ignores CA validation and accepts the server only if its certificate's
 * SPKI hash equals `pin` (SPEC revision 3b, section A), as a client with a pinned invite does.
 */
export function pinnedConnection(pin: string) {
  return (options: ClientRequestArgs): TLSSocket => {
    const socket = tlsConnect({ ...(options as ConnectionOptions), rejectUnauthorized: false });
    socket.once("secureConnect", () => {
      const cert = socket.getPeerX509Certificate() as X509Certificate;
      const spki = new Uint8Array(cert.publicKey.export({ type: "spki", format: "der" }));
      if (spkiPin(spki) !== pin) socket.destroy(new Error("certificate pin mismatch"));
    });
    return socket;
  };
}
