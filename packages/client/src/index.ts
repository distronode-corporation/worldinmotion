// The worldinmotion client library: what `wim` is built from, for programs that embed a peer.

export { botIO, ciIO, meshPort } from "./adapters.ts";
export { createMesh, decideJoin, issueInvite, joinMesh, promoteDevice, publishRoster, recoverMesh, revokeDevice, Invites } from "./admin.ts";
export { Breaker, pauseNotice } from "./breaker.ts";
export { cardFor, cardLabel, readBranch } from "./cards.ts";
export { main, parseArgs, parseDuration, toName, USAGE, VERSION, type CliIO } from "./cli.ts";
export { ClientError, MeshSession, type Inbound, type PeerRow, type SendOptions, type SendOutcome, type SessionOptions } from "./client.ts";
export { HeldBox, preview, type HeldItem } from "./held.ts";
export { History, renderForAgent, renderForPerson, type HistoryEntry } from "./history.ts";
export { Home, SetupError, type Device, type LocalDevice } from "./home.ts";
export { INTERNAL_TOOLS, PUBLIC_TOOLS, WimMcp } from "./mcp.ts";
export { DEFAULT_BREAKER, MeshFiles, RosterBook, type MeshConfig, type Policy } from "./mesh.ts";
export { CommandNotifier, loadNotifier, type Notifier } from "./notify.ts";
export { decideHeld, listAllHeld, resumeEverywhere } from "./offline.ts";
export { defaultHome, keyFileProblem, type Platform } from "./platform.ts";
export { SessionKeys } from "./session.ts";
export { Spool, type SpoolItem } from "./spool.ts";
export { checkDialable, Connection, Link, wsDialer, type Dialer, type WireSocket } from "./wire.ts";
