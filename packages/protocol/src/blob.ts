import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { z } from "zod";
import { b64u, bytesEqual, sha256, utf8 } from "./encoding.ts";
import { randomBytes, ulid } from "./ids.ts";
import { fail, LIMITS, ok, PROTOCOL, type Result } from "./limits.ts";
import { b64uBytes, b64uRange, ulidSchema } from "./schema.ts";

/** Number of chunks a file of `size` bytes has: at least one, so an empty file is one empty chunk. */
export function blobChunkCount(size: number): number {
  return Math.max(1, Math.ceil(size / LIMITS.blobChunkBytes));
}

// Path separators, C0 and C1 controls and DEL. A receiver still writes files under its own safe name.
const BAD_NAME_CHAR = /[/\\\u0000-\u001F\u007F-\u009F]/;

/** A file name as sent: 1 to 255 characters, no path separators or controls, not `.` or `..`. */
export function isFileName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const length = [...name].length;
  return length >= 1 && length <= 255 && !BAD_NAME_CHAR.test(name) && name !== "." && name !== "..";
}

/** The `file` field of a `file` message (SPEC section 12). */
export const fileSchema = z
  .strictObject({
    blob: ulidSchema,
    name: z.string().refine(isFileName, { message: "expected a file name without separators or controls" }),
    size: z.int().min(0).max(LIMITS.blobFileBytes),
    mime: z.string().regex(/^[\x20-\x7E]{1,127}$/, { message: "expected a MIME type of at most 127 characters" }),
    key: b64uBytes(32),
    sha256: b64uBytes(32),
    chunks: z.int().min(1).max(LIMITS.blobMaxChunks),
  })
  .refine((f) => f.chunks === blobChunkCount(f.size), { message: "chunks does not match size", path: ["chunks"] });

export type FileInfo = z.infer<typeof fileSchema>;

/** One encrypted chunk, as carried by `blob.put` and `blob.chunk`. */
export type BlobChunk = { index: number; last: boolean; n: string; data: string };

export const blobChunkFields = {
  blob: ulidSchema,
  index: z.int().min(0).max(LIMITS.blobMaxChunks - 1),
  last: z.boolean(),
  n: b64uBytes(24),
  // A chunk's ciphertext: up to 256 KiB plus the 16-byte tag.
  data: b64uRange(16, LIMITS.blobChunkBytes + 16),
};

const chunkSchema = z.strictObject({
  index: blobChunkFields.index,
  last: blobChunkFields.last,
  n: blobChunkFields.n,
  data: blobChunkFields.data,
});

/** AAD binding a chunk to its blob, its position, and whether it ends the blob. */
function chunkAad(blob: string, index: number, last: boolean): Uint8Array {
  return utf8(`${PROTOCOL} blob ${blob} ${index} ${last ? "1" : "0"}`);
}

/**
 * Encrypts a file for upload (SPEC section 15): a fresh 32-byte key and blob id, 256 KiB chunks,
 * each sealed with XChaCha20-Poly1305 under a random nonce. `key` and `sha256` come back in b64u,
 * ready for the `file` message. `blob` fixes the blob id (for test vectors); by default it is new.
 * Throws for a file over 25 MiB.
 */
export function sealBlob(
  file: Uint8Array,
  opts: { blob?: string } = {},
): {
  blob: string;
  key: string;
  sha256: string;
  size: number;
  chunks: BlobChunk[];
} {
  if (!(file instanceof Uint8Array)) throw new TypeError("sealBlob: expected bytes");
  if (file.length > LIMITS.blobFileBytes) throw new RangeError("sealBlob: file is over 25 MiB");
  const blob = opts.blob ?? ulid();
  if (!ulidSchema.safeParse(blob).success) throw new TypeError("sealBlob: blob must be a ULID");
  const key = randomBytes(32);
  const count = blobChunkCount(file.length);
  const chunks: BlobChunk[] = [];
  for (let index = 0; index < count; index++) {
    const last = index === count - 1;
    const plain = file.subarray(index * LIMITS.blobChunkBytes, (index + 1) * LIMITS.blobChunkBytes);
    const nonce = randomBytes(24);
    const data = xchacha20poly1305(key, nonce, chunkAad(blob, index, last)).encrypt(plain);
    chunks.push({ index, last, n: b64u.encode(nonce), data: b64u.encode(data) });
  }
  return { blob, key: b64u.encode(key), sha256: b64u.encode(sha256(file)), size: file.length, chunks };
}

/**
 * Decrypts and checks a downloaded blob. Chunks may arrive in any order. Never throws. Reasons:
 * `blob_malformed`, `blob_incomplete` (a missing, duplicate or extra chunk, or `last` on the wrong
 * one), `blob_decrypt_failed`, `blob_chunk_size`, `blob_size_mismatch`, `blob_hash_mismatch`.
 */
export function openBlob(input: {
  blob: string;
  key: string;
  sha256: string;
  size: number;
  chunks: BlobChunk[];
}): Result<Uint8Array> {
  const info = z
    .strictObject({
      blob: ulidSchema,
      key: b64uBytes(32),
      sha256: b64uBytes(32),
      size: z.int().min(0).max(LIMITS.blobFileBytes),
      chunks: z.array(chunkSchema).max(LIMITS.blobMaxChunks),
    })
    .safeParse(input);
  if (!info.success) return fail("blob_malformed");
  const { blob, size } = info.data;
  const count = blobChunkCount(size);
  const chunks = [...info.data.chunks].sort((a, b) => a.index - b.index);
  if (chunks.length !== count || chunks.some((c, i) => c.index !== i || c.last !== (i === count - 1))) {
    return fail("blob_incomplete");
  }
  const key = b64u.decode(info.data.key);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    let plain: Uint8Array;
    try {
      plain = xchacha20poly1305(key, b64u.decode(c.n), chunkAad(blob, c.index, c.last)).decrypt(b64u.decode(c.data));
    } catch {
      return fail("blob_decrypt_failed");
    }
    // Every chunk but the last is full; the last holds the rest.
    const expected = c.last ? size - offset : LIMITS.blobChunkBytes;
    if (plain.length !== expected) return fail(c.last ? "blob_size_mismatch" : "blob_chunk_size");
    out.set(plain, offset);
    offset += plain.length;
  }
  if (!bytesEqual(sha256(out), b64u.decode(info.data.sha256))) return fail("blob_hash_mismatch");
  return ok(out);
}
