// The entry point GitHub runs (action.yml `runs.main`). It only wires notify.mjs to the process,
// unconditionally: an "am I the entry point" check comparing paths can fail on a runner whose
// paths involve symlinks, and would then send nothing without a word.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { main } from "./notify.mjs";

process.exitCode = main(process.env, {
  exists: existsSync,
  run: (bundle, args) => spawnSync(process.execPath, [bundle, ...args], { stdio: "inherit", env: process.env }),
  out: (line) => console.log(line),
});
