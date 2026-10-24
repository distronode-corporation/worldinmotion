// Integration smoke test: launches a downloaded VS Code with this extension, pointed at the fake
// events process (test/fixtures/fake-wim.mjs), and runs suite.cjs inside it. Build first
// (`npm run bundle -w worldinmotion`); on Linux without a display, run under `xvfb-run -a`.
//
//   WIM_VSCODE_TEST_CACHE  where VS Code is downloaded (default: <package>/.vscode-test)
//   WIM_VSCODE_VERSION     the VS Code version to test against (default below)

import { runTests } from "@vscode/test-electron";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Run from a terminal inside VS Code, the environment carries that window's variables:
// ELECTRON_RUN_AS_NODE would start the test build as plain Node, and VSCODE_IPC_HOOK and the
// other VSCODE_* variables point at the running instance. The test instance gets none of them.
for (const key of Object.keys(process.env)) {
  if (key === "ELECTRON_RUN_AS_NODE" || key.startsWith("VSCODE_")) delete process.env[key];
}

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const fixture = join(pkg, "test", "fixtures", "fake-wim.mjs");
const work = mkdtempSync(join(tmpdir(), "wim-vscode-smoke-"));
const user = join(work, "user");
mkdirSync(join(user, "User"), { recursive: true });
// User settings: the extension runs the fake instead of the bundled client.
writeFileSync(join(user, "User", "settings.json"), JSON.stringify({ "worldinmotion.wimPath": fixture, "worldinmotion.notifyOnMessage": false, "security.workspace.trust.enabled": false }));
// A folder to open, so the client's card should carry it as its working directory.
const folder = join(work, "project");
mkdirSync(folder);
const log = join(work, "requests.log");
writeFileSync(log, "");

let code = 1;
try {
  code = await runTests({
    version: process.env.WIM_VSCODE_VERSION ?? "1.143.1",
    cachePath: process.env.WIM_VSCODE_TEST_CACHE ?? join(pkg, ".vscode-test"),
    extensionDevelopmentPath: pkg,
    extensionTestsPath: join(here, "suite.cjs"),
    extensionTestsEnv: { WIM_FAKE_LOG: log, WIM_SMOKE_FOLDER: folder },
    launchArgs: [folder, "--user-data-dir", user, "--extensions-dir", join(work, "extensions"), "--disable-extensions", "--skip-welcome", "--skip-release-notes", "--disable-gpu"],
  });
} catch (e) {
  console.error(`smoke test failed: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(code);
