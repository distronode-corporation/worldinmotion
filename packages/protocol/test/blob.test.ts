import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { describe, expect, it } from "vitest";
import { b64u, blobChunkCount, fileSchema, isFileName, LIMITS, openBlob, randomBytes, sealBlob, sha256, ulid, utf8 } from "../src/index.ts";

const CHUNK = LIMITS.blobChunkBytes;

function bytes(n: number): Uint8Array {
  // Real random content in 64 KiB pieces (the platform's per-call limit).
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) out.set(randomBytes(Math.min(65536, n - i)), i);
  return out;
}

// Real XChaCha20-Poly1305 over megabytes is slow under coverage instrumentation.
describe("sealBlob and openBlob", { timeout: 30_000 }, () => {
  it("round trips empty, small, exact-multiple and uneven files", () => {
    for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK]) {
      const file = bytes(size);
      const sealed = sealBlob(file);
      expect(sealed.size).toBe(size);
      expect(sealed.chunks).toHaveLength(blobChunkCount(size));
      expect(sealed.chunks.map((c) => c.last)).toEqual(sealed.chunks.map((_, i) => i === sealed.chunks.length - 1));
      expect(b64u.decode(sealed.key)).toHaveLength(32);
      expect(sealed.sha256).toBe(b64u.encode(sha256(file)));
      const opened = openBlob(sealed);
      expect(opened.ok && opened.value).toEqual(file);
    }
  });

  it("accepts chunks in any order", () => {
    const sealed = sealBlob(bytes(2 * CHUNK + 5));
    expect(openBlob({ ...sealed, chunks: [...sealed.chunks].reverse() }).ok).toBe(true);
  });

  it("uses the spec's AAD for each chunk", () => {
    const file = utf8("hello");
    const sealed = sealBlob(file);
    const c = sealed.chunks[0]!;
    const aad = utf8(`wim/1 blob ${sealed.blob} 0 1`);
    const plain = xchacha20poly1305(b64u.decode(sealed.key), b64u.decode(c.n), aad).decrypt(b64u.decode(c.data));
    expect(plain).toEqual(file);
  });

  it("refuses a file over 25 MiB and non-bytes", () => {
    expect(() => sealBlob(new Uint8Array(LIMITS.blobFileBytes + 1))).toThrow(/25 MiB/);
    expect(() => sealBlob("x" as unknown as Uint8Array)).toThrow(/bytes/);
    const blob = ulid();
    expect(sealBlob(utf8("x"), { blob }).blob).toBe(blob);
    expect(() => sealBlob(utf8("x"), { blob: "nope" })).toThrow(/ULID/);
  });

  it("refuses missing, duplicate, extra and mislabelled chunks", () => {
    const sealed = sealBlob(bytes(2 * CHUNK + 5));
    const [a, b, c] = sealed.chunks as [(typeof sealed.chunks)[0], (typeof sealed.chunks)[0], (typeof sealed.chunks)[0]];
    for (const chunks of [[a, b], [a, b, b], [a, b, c, { ...c, index: 3 }], [a, { ...b, index: 3 }, c], [a, { ...b, last: true }, c], [a, b, { ...c, last: false }]]) {
      expect(openBlob({ ...sealed, chunks })).toEqual({ ok: false, reason: "blob_incomplete" });
    }
    // Truncating at a chunk boundary and claiming the shorter size fails: the new last chunk was
    // sealed as "not last", so its AAD no longer matches.
    expect(openBlob({ ...sealed, size: 2 * CHUNK, chunks: [a, { ...b, last: true }] })).toEqual({ ok: false, reason: "blob_decrypt_failed" });
  });

  it("refuses tampering, a wrong key, wrong sizes and a wrong hash", () => {
    const file = bytes(CHUNK + 10);
    const sealed = sealBlob(file);
    const [a, b] = sealed.chunks as [(typeof sealed.chunks)[0], (typeof sealed.chunks)[0]];
    const flipped = b64u.decode(b.data);
    flipped[0]! ^= 1;
    expect(openBlob({ ...sealed, chunks: [a, { ...b, data: b64u.encode(flipped) }] })).toEqual({ ok: false, reason: "blob_decrypt_failed" });
    expect(openBlob({ ...sealed, key: b64u.encode(randomBytes(32)) })).toEqual({ ok: false, reason: "blob_decrypt_failed" });
    // Chunks swapped between blobs do not open: the blob id is in the AAD.
    expect(openBlob({ ...sealed, blob: ulid() })).toEqual({ ok: false, reason: "blob_decrypt_failed" });
    expect(openBlob({ ...sealed, size: CHUNK + 9 })).toEqual({ ok: false, reason: "blob_size_mismatch" });
    expect(openBlob({ ...sealed, size: CHUNK + 11 })).toEqual({ ok: false, reason: "blob_size_mismatch" });
    expect(openBlob({ ...sealed, sha256: b64u.encode(sha256(utf8("other"))) })).toEqual({ ok: false, reason: "blob_hash_mismatch" });
  });

  it("refuses a short chunk before the last one", () => {
    // A sender (holding the key) that seals a short middle chunk is caught by the size rule.
    const key = randomBytes(32);
    const blob = ulid();
    const seal = (plain: Uint8Array, index: number, last: boolean) => {
      const n = randomBytes(24);
      const aad = utf8(`wim/1 blob ${blob} ${index} ${last ? "1" : "0"}`);
      return { index, last, n: b64u.encode(n), data: b64u.encode(xchacha20poly1305(key, n, aad).encrypt(plain)) };
    };
    const chunks = [seal(bytes(10), 0, false), seal(bytes(10), 1, true)];
    const result = openBlob({ blob, key: b64u.encode(key), sha256: b64u.encode(sha256(new Uint8Array(20))), size: CHUNK + 1, chunks });
    expect(result).toEqual({ ok: false, reason: "blob_chunk_size" });
  });

  it("refuses malformed input", () => {
    const sealed = sealBlob(utf8("x"));
    for (const bad of [
      { ...sealed, key: "short" },
      { ...sealed, blob: "x" },
      { ...sealed, size: -1 },
      { ...sealed, size: LIMITS.blobFileBytes + 1 },
      { ...sealed, chunks: [{ ...sealed.chunks[0]!, extra: 1 }] },
      { ...sealed, extra: 1 },
      null,
    ]) {
      expect(openBlob(bad as Parameters<typeof openBlob>[0])).toEqual({ ok: false, reason: "blob_malformed" });
    }
  });
});

describe("file metadata", () => {
  const sealed = sealBlob(utf8("data"));
  const file = { blob: sealed.blob, name: "report.pdf", size: 4, mime: "application/pdf", key: sealed.key, sha256: sealed.sha256, chunks: 1 };

  it("accepts a valid file record and checks chunks against size", () => {
    expect(fileSchema.safeParse(file).success).toBe(true);
    expect(fileSchema.safeParse({ ...file, chunks: 2 }).success).toBe(false);
    expect(fileSchema.safeParse({ ...file, size: CHUNK + 1, chunks: 2 }).success).toBe(true);
    expect(fileSchema.safeParse({ ...file, mime: "m".repeat(128) }).success).toBe(false);
    expect(fileSchema.safeParse({ ...file, mime: "text/plain; charset=utf-8" }).success).toBe(true);
    expect(fileSchema.safeParse({ ...file, mime: "a\nb" }).success).toBe(false);
  });

  it("isFileName refuses separators, controls, dot names and over-long names", () => {
    for (const good of ["a", "report.pdf", ".hidden", "caf\u00E9 \u{1F600}.txt", "x".repeat(255), "\u{1F600}".repeat(255)]) {
      expect(isFileName(good), good).toBe(true);
    }
    for (const bad of ["", ".", "..", "a/b", "a\\b", "a\nb", "a\u0000", "a\u0085", "a\u007F", "x".repeat(256), 5]) {
      expect(isFileName(bad), String(bad)).toBe(false);
    }
  });
});
