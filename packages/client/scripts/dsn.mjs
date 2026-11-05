// The crash-report address every bundle carries: packages/client/crash-report-dsn.txt, one line.
// It is committed on purpose (CONTRIBUTING.md, Crash reports). bundle.mjs reads it here, so a
// test can check the refusals without building.

import { readFile } from "node:fs/promises";

/** The shape bakedDsn (src/crash.ts) accepts: an https Sentry DSN with a key and a project. */
export const DSN_SHAPE = /^https:\/\/[0-9a-f]{16,64}@[a-z0-9.-]+(:\d{1,5})?\/\d{1,20}$/;

/** The address in `path`, trimmed. Throws when the file is missing, or holds anything but one DSN. */
export async function readDsn(path) {
  const dsn = (await readFile(path, "utf8")).trim();
  if (!DSN_SHAPE.test(dsn)) throw new Error(`${path} does not hold one https Sentry DSN (https://<key>@<host>/<project>)`);
  return dsn;
}
