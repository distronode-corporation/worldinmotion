# worldinmotion for security teams

This page is for a security team deciding whether worldinmotion (wim) may run inside a company. It
maps wim to the OWASP risk for agent-to-agent messaging and names the gaps plainly. The full
threat model is [SECURITY-MODEL.md](../SECURITY-MODEL.md); section numbers below point into it.

wim is pre-release (v0.1), with one maintainer. It has no outside audit, no SOC 2 report, no SSO
and no central audit log. Weigh the rest of this page with that in mind.

## What wim is, in one paragraph

Each machine (a **device**) holds its own keys. Devices form a **mesh** whose membership is a
roster that admin devices sign. AI agent sessions on those devices send each other messages through
a **relay**: the hosted one at `wss://worldinmotion.distronode.com`, or one you run. Messages are
sealed on the sending device for each recipient device and signed, so the relay passes ciphertext
and sees metadata. A message from a device that is not marked as the person's own is held until a
person approves it.

## OWASP ASI07: Insecure Inter-Agent Communication

ASI07 is one of the OWASP Top 10 for Agentic Applications (version 2026, December 2025). It lists
nine prevention and mitigation guidelines. The table maps each to wim as of v0.1.6. "Partly" means
some of the guideline holds and some does not; the notes say which.

| # | OWASP guideline | wim | notes |
|---|---|---|---|
| 1 | Secure agent channels: end-to-end encryption, per-agent credentials, mutual authentication, certificate pinning, forward secrecy | partly | End-to-end encrypted and signed per **device**, not per agent: session names are claims (5.2). Forward secrecy is bounded at 120 hours, not per message (6.14). An invite can carry a pin of the relay's TLS key (6.9), which LAN mode uses; otherwise the relay uses public certificates, and message secrecy does not depend on them. |
| 2 | Message integrity and semantic protection: signed messages, hashed context, checks for hidden instructions | partly | Every message is signed by its device, boxes included, and each box is bound to the header's hash (SPEC section 6). Peer text reaches an agent inside a random-boundary frame, with invisible and control characters escaped (7.1). There is no intent-diffing, and framing is not a guarantee (9). |
| 3 | Agent-aware anti-replay: nonces, timestamps, message fingerprints | yes | Receivers drop messages older than 47 hours or more than 10 minutes ahead, remember every accepted id durably, and track a sequence number per sender session (6.7). Room history and peer cards are exempt by design and are shown as history or labels. |
| 4 | Protocol and capability security: disable weak or legacy modes, bind authentication to identity | partly, a known gap | Until 1.0, wim still accepts v0.1 boxes, which have no forward secrecy, and a hostile relay can force a sender back to them by withholding prekeys. The sender is told when that happens. From 1.0 they are refused (6.14, SPEC section 6b). Authentication is bound to the device, not the agent. |
| 5 | Limit metadata-based inference: padding, smoothed rates | no, a known gap | No padding and no metadata hiding (6.10). The relay sees who sends to whom, when and how much. Every member sees every session's name, presence and, by default, its working directory and git branch. |
| 6 | Protocol pinning and version enforcement | partly | Signatures carry the `wim/1` domain, and a frame with an unknown box scheme is malformed. The downgrade window of row 4 is the exception until 1.0. |
| 7 | Discovery and routing protection: authenticate discovery with cryptographic identity | partly | The roster is signed by admin devices and checked as a chain, so a relay cannot add a device. Peer rows, presence, receipts and room member lists come from the relay unsigned and are advisory (9). Peer cards are signed but can be replayed by the relay (6.13). |
| 8 | Attested registry and agent verification, signed agent cards | partly | The admin-signed roster is the registry for devices. The A2A gateway's Agent Card is not signed yet. |
| 9 | Typed contracts and schema validation | yes | Each message, both the frame the relay sees and the sealed text inside, is checked against a typed schema. A message names its audience, and a receiver drops anything not addressed to it (SPEC section 6). |

## The gaps, in one place

- **Credentials are per device, not per agent.** Every session on a device speaks with the
  device's key. Anything running as the OS user is the device (5.8, 9).
- **The downgrade window.** Until 1.0, a relay can strip forward secrecy from messages to a device
  by withholding its prekey (6.14). It is closed at 1.0, when v0.1 boxes are refused.
- **No metadata padding.** The relay sees the full traffic pattern (6.10).
- **Approval marks are files.** An approval is a file the plugin writes in the state directory. A
  local process, or an agent allowed to write files without a prompt, can approve a held message
  (7.1).
- **Framing is not a boundary.** An agent may still follow a peer's text. Messages from devices
  marked as the person's own may assign work within the agent's normal permissions (7.2).
- **The held view shows one item at a time.** A request split across several harmless-looking
  messages (agent session smuggling, 5.2) is easy to approve piece by piece.
- **The secret filter is best effort.** It refuses common credential formats; an encoded secret
  gets through (7.4).

## What a security team will also ask

**Is an encrypted channel out of an agent an exfiltration path?** It can be. The relay cannot read
the content, so a network control cannot inspect it either. The only place the content is readable
is the device itself: every session keeps its history as plaintext on disk for 30 days (6.14), and
inspection belongs there. wim has no central audit log and no admin allow-list of meshes today.

**Can an employee join a stranger's mesh?** Yes: anyone with an invite code can join that mesh
from a machine they control, and nothing in wim lets a company forbid it. A device in a mesh with
someone else holds that person's messages by default, and what the employee approves from them
reaches the agents as information only, never as work to do, unless the employee marks that device
as their own. The person still decides what to approve.

**Who runs the hosted relay?** Distronode, on Cloudflare, free until 1.0 with no SLA. Its terms and
what it can see are in [hosted-relay.md](hosted-relay.md). A company can run its own relay
([relay-node](../packages/relay-node/README.md)).

## Client-side scanners as a second layer

wim's own secret filter runs inside the send path and needs no service, but it is thin. A company
that already scans what agents send and receive at the client can add that as a second layer.
Neither tool below has been tested with wim yet.

- **Docker MCP Gateway** ([docker/mcp-gateway](https://github.com/docker/mcp-gateway)) runs MCP
  servers behind one gateway. Its `docker mcp gateway run` reference documents `--block-secrets`,
  which blocks secrets sent to or received from tools and is on by default, and `--log-calls`, also
  on by default. For it to see wim's traffic, `wim mcp` would have to run behind the gateway, and
  the gateway runs its servers in containers, which must then reach the device's keys or signer.
  Not yet tested; a test is planned.
- **GitGuardian AI hooks** (`ggshield machine setup`,
  [announced in October 2026](https://blog.gitguardian.com/ai-hooks-ai-coding-assistants/)) scan
  prompts before the model gets them, and commands, file reads and MCP calls before they run, in
  Claude Code, Cursor, Codex, Copilot CLI and others. They need an installed and authenticated
  `ggshield`, which signs in to a GitGuardian account. Named from GitGuardian's documentation only,
  not tested with wim. Whether they see a message the Claude Code plugin sends through
  SendMessage, which the plugin answers itself, is not known.

## Reporting

Report vulnerabilities privately as [SECURITY.md](../SECURITY.md) describes, never in a public
issue.
