// Runs inside the Extension Development Host. The extension is pointed at the fake events
// process; this checks that VS Code activates it at startup, that the Mesh tree fills and that
// one Approve reaches the fake.

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vscode = require("vscode");

const HELD = "01JFAKEHELD000000000000001";

async function waitFor(what, check, ms = 20_000) {
  const until = Date.now() + ms;
  for (;;) {
    let last;
    try {
      if (await check()) return;
    } catch (e) {
      last = e;
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

exports.run = async function run() {
  const ext = vscode.extensions.getExtension("distronode.worldinmotion");
  assert.ok(ext, "the extension is installed in the development host");
  // VS Code activates it once it has started (onStartupFinished), with no view opened: the
  // session must be online while the panel is closed.
  await waitFor("VS Code to activate the extension at startup", () => ext.isActive);
  console.log("smoke: VS Code activated the extension at startup");
  const api = await ext.activate();
  assert.ok(api, "test mode returns the test API");

  await waitFor("the Mesh tree to have devices and sessions", () => api.mesh.getChildren().length === 2 && api.store.sessions.size === 4);
  const devices = api.mesh.getChildren();
  const labels = devices.map((d) => api.mesh.getTreeItem(d).label);
  assert.deepEqual(labels, ["laptop", "buildbox"]);
  const sessions = devices.flatMap((d) => api.mesh.getChildren(d)).map((s) => api.mesh.getTreeItem(s).label);
  assert.deepEqual(sessions, ["reviewer", "vscode", "coder", "tester"]);
  console.log(`smoke: Mesh tree shows ${labels.join(", ")} with ${sessions.length} sessions`);
  // The client was started in the window's workspace folder, so its card shows that folder.
  assert.deepEqual(api.store.sessions.get("vscode@laptop").card, { cwd: process.env.WIM_SMOKE_FOLDER });
  console.log(`smoke: the card's cwd is the workspace folder`);

  // The views are contributed and can be shown.
  await vscode.commands.executeCommand("worldinmotion.mesh.focus");
  await vscode.commands.executeCommand("worldinmotion.showActivity");

  // One Approve round trip: the click's command reaches the fake, which removes the held item.
  assert.equal(api.store.held.size, 1);
  await vscode.commands.executeCommand("worldinmotion.approve", api.nodes.held("vscode@laptop", HELD));
  await waitFor("the held item to go", () => api.store.held.size === 0);
  const log = readFileSync(process.env.WIM_FAKE_LOG, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
  const approve = log.find((r) => r.op === "approve");
  assert.deepEqual(approve && approve.args, { held: HELD });
  await waitFor("the approved message to arrive", () => api.store.messages.some((m) => m.dir === "in" && m.text.startsWith("Could you look")));
  console.log("smoke: Approve reached the fake and the message was delivered");
};
