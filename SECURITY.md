# Security Policy

worldinmotion carries messages between AI agent sessions, and those messages can steer
what an agent does next. A flaw here can be a flaw in every agent connected to a mesh, so
reports are very welcome.

## Reporting a vulnerability

Please report privately, not in a public issue, discussion or pull request.

- **Preferred:** GitHub's private vulnerability reporting. Open the repository's
  **Security** tab and choose **Report a vulnerability**, or go straight to
  <https://github.com/distronode-corporation/worldinmotion/security/advisories/new>.
- **Fallback:** email **distronode@distronode.com** if you cannot use GitHub.

Include what you did, what happened, and what you expected. A proof of concept is welcome
but not required. Never include a real device key, invite code or operator key; if one
is part of the problem, say where it appeared, not what it was.

Expect an acknowledgement within a few working days. This is a small project with no paid
bug bounty; what you get is credit in the changelog entry for the fix, if you want it.

## Supported versions

The project is pre-1.0. Only the latest release is supported, and fixes go into a new
release rather than being backported.

| Version | Supported |
| --- | --- |
| Latest 0.1.x release | Yes |
| Anything older | No |

## Abuse of the hosted relay

Spam, illegal content or other abuse on the hosted relay (`wss://worldinmotion.distronode.com`) is
not a vulnerability. Report it to **opensource@distronode.com**; see
[docs/hosted-relay.md](docs/hosted-relay.md).

## Security model

What worldinmotion promises, and what it does not, is written down in
[SECURITY-MODEL.md](SECURITY-MODEL.md), with the wire-level details in
[SPEC.md](SPEC.md) (section 10 lists what a relay can and cannot see). A good report says
which of those claims it breaks.

## Scope

In scope, in rough order of damage:

- **Protocol** (`packages/protocol` and `SPEC.md`): anything that lets a party without a
  device's keys read a message, forge or alter one so that a receiver accepts it, replay
  one past the receiver's dedupe, or get a roster accepted that no admin signed. Flaws in
  canonical encoding, signature coverage, key derivation, nonce handling or roster chain
  verification belong here, as do weaknesses in the specification itself.
- **Client**: a client that accepts a message or roster the specification says to drop,
  leaks plaintext or key material (to a log, an error, a file with permissive modes, or
  the relay), or lets one session act as another.
- **Claude Code plugin, VS Code extension, `wim events`** and any MCP server shipped here: a
  message from a peer causing an action the person did not approve, bypassing the inbound
  policy or the hold-for-approval path, a peer's text rendered as anything but plain text, or
  reading or writing files outside what the component is meant to touch.
- **Relay** (the Cloudflare Worker and the self-hosted Node relay): authentication
  bypass, one mesh reaching another mesh's sessions, queues or rosters, an
  unauthenticated write beyond `create` and `join`, resource exhaustion that the
  documented limits are meant to prevent, or the relay learning anything beyond the
  metadata the specification lists.
- The release pipeline: a published plugin bundle or relay image that does not match
  this repository's source, or whose provenance does not verify.

Out of scope:

- The documented v0.1 limits, which are design decisions rather than bugs: no forward
  secrecy (static-static key agreement), and a relay that can drop, delay or withhold
  messages and roster updates, or see the metadata listed in SPEC.md section 10.
- An attacker who already controls a device in the mesh, or can read its key file or
  run code as its user. Revocation is the remedy for a lost device.
- What an agent does with a message it was legitimately sent by a mesh member. Prompt
  injection between trusted peers is a property of agents, not of this transport,
  although a way around the plugin's own approval step is in scope.
- Denial of service against a relay you do not operate, and volumetric attacks in
  general.
- Vulnerabilities in third-party dependencies with no demonstrated effect on
  worldinmotion; report those upstream (Dependabot and the weekly audit track them here).
