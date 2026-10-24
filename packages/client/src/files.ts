// Received files are saved under a name this client makes up, in the session's files/ folder,
// with no execute permission. The sender's name is only a hint inside it.

import { promises as fs } from "node:fs";
import { findSecrets } from "@worldinmotion/protocol";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { ensureDir } from "./fsx.ts";

/** A safe local file name: the message id, then the sender's name reduced to `[A-Za-z0-9._-]`. */
export function safeFileName(id: string, name: string): string {
  const reduced = name
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 80);
  return `${id}-${reduced === "" ? "file" : reduced}`;
}

/** Writes a received file without execute bits, refusing to replace anything. */
export async function saveReceived(dir: string, id: string, name: string, bytes: Uint8Array): Promise<string> {
  await ensureDir(dir);
  const path = join(dir, safeFileName(id, name));
  await fs.writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  return path;
}

const MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".log": "text/plain",
  ".diff": "text/x-diff",
  ".patch": "text/x-diff",
  ".ts": "text/plain",
  ".js": "text/plain",
  ".py": "text/plain",
};

/** A MIME type from the extension, as a label for the receiver; never used to decide anything. */
export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** A file name the protocol accepts: the base name, cut to 255 characters. */
export function wireFileName(base: string): string {
  // A base name can still hold control characters or a backslash on some file systems.
  const cleaned = [...base.replace(/[/\\\u0000-\u001F\u007F-\u009F]/g, "_")].slice(0, 255).join("");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "file" : cleaned;
}

/** Directories under the user's home that hold credentials, never sent as files. */
const CREDENTIAL_DIRS = [".ssh", ".aws", join(".config", "gcloud"), ".gnupg", ".kube", ".docker", join(".config", "gh")];

function inside(dir: string, path: string): boolean {
  const r = relative(dir, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/**
 * Why a path must not be sent (revision 4, M7), or undefined. `path` is already resolved through
 * links. Refused: anything under the worldinmotion state directory, well-known credential
 * directories, `.env` files, `*.pem` and `*.key`, and SSH-style `id_*` keys.
 */
export function unsendable(path: string, wimHome: string, userHome: string): string | undefined {
  if (inside(wimHome, path)) return "it is in the worldinmotion state directory";
  for (const d of CREDENTIAL_DIRS) if (inside(join(userHome, d), path)) return `it is under ~/${d}, which holds credentials`;
  const name = basename(path).toLowerCase();
  if (name === ".env" || name.startsWith(".env.")) return "it is an environment file";
  if (name.endsWith(".pem") || name.endsWith(".key") || name.endsWith(".p12") || name.endsWith(".pfx")) return "it looks like a key or certificate file";
  if (/^id_[a-z0-9_-]+$/.test(name) || /^id_[a-z0-9_-]+\.pub$/.test(name)) return "it looks like an SSH key";
  return undefined;
}

/** The credential patterns found in a file that reads as text; binary files are not scanned. */
export function secretsInFile(bytes: Uint8Array): string[] {
  if (bytes.subarray(0, 8192).includes(0)) return [];
  return findSecrets(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
}
