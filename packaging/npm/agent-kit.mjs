// Copies the deployment kit (packages/agent: deploy/ and its guides) into packaging/npm/agent-kit,
// modes kept, so the published `worldinmotion` package carries it beside wim.mjs, where
// `wim agent init --kit <dir>` finds it. release.yml runs this before `npm publish`;
// test/npm-package.test.ts runs it into a scratch directory.
//
//   node packaging/npm/agent-kit.mjs [<destination>]     default: packaging/npm/agent-kit

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { copyKit } from "../../packages/agent/src/kit.ts";

const here = import.meta.dirname;
const to = process.argv[2] ?? join(here, "agent-kit");
await rm(to, { recursive: true, force: true });
const files = await copyKit(join(here, "..", "..", "packages", "agent"), to);
console.log(`wrote ${files.length} files to ${to}`);
