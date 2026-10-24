# @worldinmotion/a2a

`wim a2a`: a gateway between a worldinmotion mesh and Google's
[Agent2Agent (A2A) protocol](https://a2a-protocol.org), in both directions.

- **Inbound:** A2A clients reach mesh peers. The gateway serves an agent card with one skill per
  reachable mesh session, and turns each A2A message into a mesh `task`.
- **Outbound:** mesh peers reach external A2A agents. Each configured agent is a mesh session of
  kind `a2a`; a `task` (or `msg`) sent to it runs on the agent and comes back as a `result`.

The mesh side is an injected `MeshPort` (see `src/mesh.ts`); the real one comes from
`@worldinmotion/client`.

## Protocol version

This package implements **A2A specification v1.0.1** (released 2026-05-28), protocol version
`1.0`, with the JSON-RPC binding:

- Specification: https://github.com/a2aproject/A2A/blob/v1.0.1/docs/specification.md
  (published at https://a2a-protocol.org/latest/specification/, which labels the 1.0 line
  "1.0.0"; patch versions do not change the protocol, section 3.6)
- Normative proto: https://github.com/a2aproject/A2A/blob/v1.0.1/specification/a2a.proto
- Release: https://github.com/a2aproject/A2A/releases/tag/v1.0.1

Protocol 1.0 renamed the JSON-RPC methods from the 0.3 names (`message/send`, `tasks/get`,
`tasks/cancel`) to `SendMessage`, `GetTask` and `CancelTask`, writes enums as proto names
(`TASK_STATE_COMPLETED`, `ROLE_USER`) and flattens parts to `{ "text": ... }`. Clients must send
`A2A-Version: 1.0`; an empty version means 0.3 (section 3.6.2), which this gateway answers with
`VersionNotSupportedError` (-32009).

### Why no SDK

The official JS SDK, `@a2a-js/sdk` (1.3.0, Apache-2.0, maintained, one runtime dependency), was
evaluated and not used. Its server transport is built on Express (an optional peer dependency
that pulls in a large tree), the package is 4.6 MB with task stores, executors and event buses
this gateway does not need, and the controls this gateway must own anyway (constant-time bearer
check, 1 MiB caps, no cross-host redirects, https only) sit below the SDK's client. The JSON-RPC
surface used here is small, so it is implemented directly with `node:http`, `fetch` and zod, and
checked against the spec's proto in tests.

## Inbound: A2A to the mesh

| A2A | gateway |
|---|---|
| `GET /.well-known/agent-card.json` | the agent card: `JSONRPC` interface at protocol `1.0`, a `Bearer` security scheme, `text/plain` in and out, no streaming, push or extended card, one skill per peer that is not offline and not itself an A2A bridge (skill id = the peer's address) |
| `POST /` `SendMessage` | text parts become one mesh `task`; the task stays `TASK_STATE_WORKING` until the peer's `result` |
| `GetTask`, `ListTasks`, `CancelTask` | from the in-memory task store |
| `SendStreamingMessage`, `SubscribeToTask`, `GetExtendedAgentCard` | `UnsupportedOperationError` (-32004) |
| push notification config methods | `PushNotificationNotSupportedError` (-32003) |

The target peer is `message.metadata.worldinmotion.to` (an address), or
`message.metadata.worldinmotion.skill` (a skill id), or the same keys in the request's
`metadata`, or the configured `defaultTo`. A message that names none is refused.

`SendMessage` blocks until the task ends unless `configuration.returnImmediately` is true, as the
spec requires. Every task ends by its deadline (`taskTimeoutSeconds`), so a blocking call always
returns.

| mesh `result` | A2A task |
|---|---|
| `done` | `TASK_STATE_COMPLETED`, the text as a `result` artifact |
| `failed` | `TASK_STATE_FAILED`, the text as the status message |
| `declined` | `TASK_STATE_REJECTED` |
| `timeout`, or no result by the deadline | `TASK_STATE_FAILED` (A2A has no timeout state, and canceled means the client asked) |
| `CancelTask` | `TASK_STATE_CANCELED`; the mesh has no cancel, so a later result is dropped |

Refused with the spec's errors: non-text parts (`raw`, `url`, `data`, or a non-`text/*` media
type) and output modes without text (`ContentTypeNotSupportedError`, -32005), follow-up messages
to an existing task (-32004, or -32001 for an unknown task), agent-role messages, empty text,
text over 256 KiB and unknown peers (`-32602`). A result is accepted only from the peer the task
was sent to.

Tasks are kept in memory, at most `maxTasks`, each for `taskTtlSeconds` after its last change.
When full, the oldest finished task is evicted; if every task is still running, `SendMessage`
answers -32603.

## Outbound: the mesh to A2A agents

For each configured agent the gateway fetches its agent card, picks the first `JSONRPC`
interface at protocol `1.0`, sends the task text with `SendMessage` (`returnImmediately: true`),
and polls `GetTask` (backing off from 1 second to 10) until the task ends or the deadline
passes. At the deadline it sends `CancelTask` (best effort) and answers `timeout`.

| remote | mesh `result` |
|---|---|
| a direct `Message`, or `TASK_STATE_COMPLETED` | `done`, with artifact text (or the status message) |
| `TASK_STATE_FAILED`, `TASK_STATE_CANCELED` | `failed` |
| `TASK_STATE_REJECTED` | `declined` |
| `TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_AUTH_REQUIRED` | `failed`: a mesh task has no second turn |
| deadline passed | `timeout` |
| any protocol, network or card error | `failed`, with a short reason |

Non-text parts in a reply are counted, not passed on.

## Safety

- The inbound server binds `127.0.0.1`. Any other bind needs both `allowNonLoopback` and `tls`
  (a PEM certificate and key, served with `node:https`); without TLS it refuses to start.
- Every request's `Host` header must name one of `publicHosts` (default `localhost`,
  `127.0.0.1`, `[::1]`), or it gets 421 before anything else is checked. This stops DNS
  rebinding: a web page cannot point its own host name at the gateway. A configured `publicUrl`
  must use one of these names.
- Every request
  (the agent card too, unless `cardRequiresAuth: false`) needs `Authorization: Bearer <token>`,
  compared in constant time. The token comes from the environment variable `tokenEnv` names.
- Text from A2A is untrusted. It reaches mesh agents only as a `task` from the gateway's
  session; the client marks everything the `wim a2a` process sends as `relayed: true`
  (third-party text) and frames it as another agent's text, never as the person's.
- Credentials never cross directions: the inbound token is checked and dropped, and an external
  agent gets only the header from its own `authHeaderEnv`. Neither is ever logged; logs carry
  ids and addresses, not text.
- External agents: card and interface URLs must be `https`, or `http` to a loopback host, with
  no credentials in them. The interface must be on the card's host. A GET follows at most three
  redirects, all within the same origin; a POST is never redirected. Responses are capped at
  1 MiB and each exchange at `requestTimeoutSeconds`. Results to the mesh are clipped to 256 KiB.
- Peers of kind `a2a` are not offered back out as skills, so the gateway does not relay A2A to
  A2A through itself.

## Configuration

```json
{
  "inbound": {
    "tokenEnv": "WIM_A2A_TOKEN",
    "host": "127.0.0.1",
    "port": 41241,
    "publicHosts": ["localhost", "127.0.0.1", "[::1]"],
    "tls": { "certPath": "/path/cert.pem", "keyPath": "/path/key.pem" },
    "taskTimeoutSeconds": 300,
    "maxTasks": 1000,
    "taskTtlSeconds": 3600
  },
  "outbound": {
    "agents": [
      {
        "name": "weather",
        "cardUrl": "https://weather.example/.well-known/agent-card.json",
        "authHeaderEnv": "WEATHER_AGENT_AUTH"
      }
    ],
    "requestTimeoutSeconds": 15,
    "defaultDeadlineSeconds": 300,
    "maxDeadlineSeconds": 3600,
    "maxConcurrent": 4
  }
}
```

`tls` is optional on loopback and required anywhere else. `authHeaderEnv` holds the whole `Authorization` value, for example `Bearer abc...`.

```ts
import { loadConfig, startGateway } from "@worldinmotion/a2a";

const gw = await startGateway(loadConfig(JSON.parse(raw)), mesh);
// gw.outbound?.sessions() lists the kind-a2a sessions the mesh client should hold.
```
