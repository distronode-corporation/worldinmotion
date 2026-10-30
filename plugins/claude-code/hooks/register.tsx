// The worldinmotion mod: delivers mesh messages into the session, bridges
// SendMessage and ListAgents to the mesh, and draws the /wim pane.
//
// The local client (the plugin's MCP server) does the crypto and the relay.
// The mod talks to it two ways: MCP calls made inside hook dispatches (its own
// tool.check allows those), and plain files under the session's spool, read
// from a timer (MCP from a timer would raise a permission prompt).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

import type { WimItem, WimLate, WimPanel, WimRelayed } from '../types'
import type { RoutePolicy } from './parse'
import {
  firstLine,
  ITEM_NAME,
  markPath,
  newNames,
  parseHeld,
  parseItem,
  parseLeases,
  parseLink,
  parseRoute,
  parsePeers,
  parseSent,
  describeMessage,
  peerLine,
  sessionDir,
  toolJson,
  toolText,
} from './parse'

const SERVER = 'worldinmotion'
const TOOL_PREFIX = 'mcp__plugin_worldinmotion_worldinmotion__'
// The client's one internal tool: every plugin-only operation goes through it.
const INTERNAL = '_internal'
// A plugin's own calls carry this prefix; a model's never do.
const PLUGIN_CALL = 'toolu_plugin_'
const PANE = 'wim'
const RECENT_MAX = 20
// Only file reads per tick, so a short period costs little and keeps delivery prompt.
const POLL_MS = 250
// Public tools that only read: allowed for any caller, the model included.
const READ_ONLY = new Set(['peers', 'inbox', 'wait', 'history'])
const SETUP_LINE =
  'worldinmotion: this device is not set up. Download wim.mjs from the worldinmotion GitHub Release, check its SHA-256, and install it as wim (for example `install -m 755 wim.mjs ~/.local/bin/wim`) or run `node wim.mjs`. Then run `wim init --relay <url>` for a new mesh, or `wim init` then `wim join <invite>`, and start a new session.'
const INTERNAL_DESCRIPTION = 'Internal to the worldinmotion plugin. Do not call.'
const AGAIN ='(delivered again: it arrived as your last turn ended)'
const PEERS_HEADING = 'worldinmotion peers (other machines; address with name@device)'

const EMPTY_PANEL: WimPanel = {
  peers: [],
  held: [],
  leases: [],
  note: '',
  waiting: 0,
  heldOnDisk: 0,
}

// Change a shape tag when that value's fields change: a reload keeps what the
// previous code stored, and the tag makes new code read an old value as initial.
const link = atom({ plugin: 'worldinmotion', key: 'link' } as const, null, { shape: 'link-3' })
const cursor = atom({ plugin: 'worldinmotion', key: 'cursor' } as const, '', { shape: 'cursor-1' })
const busy = atom({ plugin: 'worldinmotion', key: 'busy' } as const, false)
// True while the running main-loop turn is one the plugin started with a mesh item.
const meshTurn = atom({ plugin: 'worldinmotion', key: 'meshTurn' } as const, false)
// Mesh submits not yet seen to start their turn, by text.
const pendingSubmits = atom({ plugin: 'worldinmotion', key: 'pendingSubmits' } as const, [], {
  shape: 'pending-1',
})
const late = atom({ plugin: 'worldinmotion', key: 'late' } as const, [], { shape: 'late-1' })
const recent = atom({ plugin: 'worldinmotion', key: 'recent' } as const, [], { shape: 'recent-1' })
const relayed = atom({ plugin: 'worldinmotion', key: 'relayed' } as const, [], { shape: 'relayed-2' })
const teammates = atom({ plugin: 'worldinmotion', key: 'teammates' } as const, [], { shape: 'teammates-1' })
const panel = atom({ plugin: 'worldinmotion', key: 'panel' } as const, EMPTY_PANEL, {
  shape: 'panel-2',
})

// Guards one delivery pass at a time. A reload drops the timer with it.
let isTicking = false

/** One call to the plugin's own server, or undefined when it is not connected. */
async function callTool(
  $: EngineInterface,
  tool: string,
  args: Record<string, unknown>,
): Promise<McpToolResult | undefined> {
  const server = await $.mcp.connect(SERVER)
  if (!server.isConnected) return undefined
  return $.mcp.call(server.server, tool, args)
}

// Every op only reads: the person's decisions are mark files, written by `mark` below, so the
// model cannot make one even when this plugin's hooks are not loaded.
type InternalOp = 'hello' | 'peers' | 'route' | 'held' | 'leases'

/**
 * One operation of `_internal`, carrying the token `hello` handed out (a
 * repeat `hello` carries it too), or undefined when the client is not connected.
 */
async function callInternal(
  $: EngineInterface,
  op: InternalOp,
  args: Record<string, unknown> = {},
): Promise<McpToolResult | undefined> {
  const token = (await read($, link))?.token
  return callTool($, INTERNAL, { op, args, ...(token ? { token } : {}) })
}

/**
 * `busy-mesh` marks a turn a mesh item started, so the client flags what the
 * session sends in it as derived (work is assigned one hop, no further).
 */
async function writePresence($: EngineInterface, state: 'busy' | 'busy-mesh' | 'idle'): Promise<void> {
  const linked = await read($, link)
  if (linked === null) return
  await $.fs.write(`${sessionDir(linked.spool)}/presence`, state).catch(() => undefined)
}

/** Takes the late list and empties it in one versioned write. */
async function takeLate($: EngineInterface): Promise<WimLate[]> {
  let taken: WimLate[] = []
  await update($, late, list => {
    taken = list
    return []
  })
  return taken
}

/** Every submit of the plugin's carries a mesh item: its turn is a mesh turn. */
async function submit($: EngineInterface, text: string): Promise<void> {
  await update($, pendingSubmits, list => [...list, text])
  const sent = await $.prompt.submit({ text }).catch(error => {
    void forgetSubmit($, text)
    throw error
  })
  if (sent.drop !== undefined) {
    await forgetSubmit($, text)
    $.ui.log(`worldinmotion: a delivery was dropped: ${sent.drop}`)
  }
}

async function forgetSubmit($: EngineInterface, text: string): Promise<void> {
  await update($, pendingSubmits, list => {
    const at = list.indexOf(text)
    return at < 0 ? list : [...list.slice(0, at), ...list.slice(at + 1)]
  })
}

/**
 * Whether the main-loop turn now starting is one of the plugin's submits.
 * The turn's text may differ from what was submitted (a hook can reword it),
 * so any pending submit counts and the matching or oldest one is consumed:
 * a person's turn misread as a mesh one only marks more sends as derived.
 */
async function takeSubmit($: EngineInterface, text: string): Promise<boolean> {
  let isMesh = false
  await update($, pendingSubmits, list => {
    isMesh = list.length > 0
    if (!isMesh) return list
    const at = list.indexOf(text)
    const drop = at < 0 ? 0 : at
    return [...list.slice(0, drop), ...list.slice(drop + 1)]
  })
  return isMesh
}

async function redeliverLate($: EngineInterface): Promise<void> {
  const pending = await takeLate($)
  if (pending.length === 0) return
  await submit($, `${AGAIN}\n\n${pending.map(one => one.text).join('\n\n')}`)
}

async function handshake($: EngineInterface): Promise<boolean> {
  const server = await $.mcp.connect(SERVER)
  if (!server.isConnected) {
    $.ui.status(SETUP_LINE)
    return false
  }
  const claudeSessionId = await $.session.id()
  const hello = await callInternal($, 'hello', { claudeSessionId })
  const answered = hello === undefined ? undefined : parseLink(toolJson(hello))
  if (answered === undefined) {
    $.ui.status(SETUP_LINE)
    return false
  }
  const prior = await read($, link)
  await update($, link, () => answered)
  if (prior?.spool !== answered.spool) {
    // A new spool: start from what the client last saw taken, not from our old value.
    const onDisk = await $.fs.read(`${answered.spool}/cursor`).catch(() => '')
    const text = typeof onDisk === 'string' ? onDisk.trim() : ''
    await update($, cursor, () => (ITEM_NAME.test(text) ? text : ''))
  }
  $.ui.status(undefined)
  const isBusy = await read($, busy)
  await writePresence($, !isBusy ? 'idle' : (await read($, meshTurn)) ? 'busy-mesh' : 'busy')
  return true
}

/** One poll of the spool: deliver every new item in order, then move the cursor. */
async function deliver($: EngineInterface): Promise<void> {
  const linked = await read($, link)
  if (linked === null) return
  const entries = await $.fs.list(linked.spool).catch(() => [])
  const fresh = newNames(
    entries.filter(entry => entry.kind === 'file').map(entry => entry.name),
    await read($, cursor),
  )
  if (fresh.length === 0) return

  const toModel: WimLate[] = []
  const relays: WimRelayed[] = []
  const seen: WimItem[] = []
  let last = ''
  for (const name of fresh) {
    const text = await $.fs.read(`${linked.spool}/${name}`).catch(() => undefined)
    // Unreadable now (the client may be replacing it): stop here, keep the order.
    if (typeof text !== 'string') break
    last = name
    const item = parseItem(text)
    if (item === undefined) {
      $.ui.log(`worldinmotion: skipped ${name}, not a spool item`)
      continue
    }
    seen.push({ name, kind: item.kind, from: item.from, line: firstLine(item.rendered), at: item.at })
    if (item.kind === 'notice' && item.held !== undefined) {
      // For the person, not the model: spending a turn on it would only relay it.
      const n = item.held
      $.ui.toast(`worldinmotion: ${n} message${n === 1 ? '' : 's'} held for your approval (/wim)`)
      continue
    }
    if (item.kind === 'notice' && item.heldBy !== undefined) {
      // A message this session sent waits for the recipient device's person: theirs to approve.
      $.ui.toast(`worldinmotion: ${item.heldBy} is holding your message for its person's approval; it is not delivered until they approve it there`)
      continue
    }
    if (item.relayed) {
      relays.push({
        name,
        id: item.id,
        from: item.from,
        line: firstLine(item.rendered),
        at: item.at,
        text: item.rendered,
        isShown: false,
        isDismissed: false,
      })
      continue
    }
    toModel.push({ name, text: item.rendered })
  }
  if (last === '') return

  if (relays.length > 0) await deliverRelayed($, relays)

  if (toModel.length > 0) {
    if (await read($, busy)) {
      for (const one of toModel) {
        const appended = await $.session.append({
          message: { type: 'user', content: [{ type: 'text', text: one.text }] },
        })
        if (appended.deny !== undefined) {
          await submit($, one.text)
          continue
        }
        await update($, late, list => [...list, one])
      }
      // The turn may have ended while we appended; its re-delivery missed these.
      if (!(await read($, busy))) await redeliverLate($)
    } else {
      await submit($, toModel.map(one => one.text).join('\n\n'))
    }
  }

  await $.fs.write(`${linked.spool}/cursor`, last)
  await update($, cursor, () => last)
  await update($, recent, list => [...list, ...seen].slice(-RECENT_MAX))
}

/**
 * Relayed items reach the model only inside a turn that is already running:
 * a bot or gateway must not be able to start one. The rest wait in the pane.
 */
async function deliverRelayed($: EngineInterface, relays: WimRelayed[]): Promise<void> {
  const kept: WimRelayed[] = []
  for (const one of relays) {
    let isShown = false
    if (await read($, busy)) {
      const appended = await $.session.append({
        message: { type: 'user', content: [{ type: 'text', text: one.text }] },
      })
      isShown = appended.deny === undefined
    }
    kept.push({ ...one, isShown })
  }
  await update($, relayed, list => [...list, ...kept].slice(-RECENT_MAX))
  const waiting = kept.filter(one => !one.isShown).length
  if (waiting > 0) {
    $.ui.toast(`worldinmotion: ${waiting} relayed item${waiting === 1 ? '' : 's'} in the inbox (/wim)`)
  }
}

/** The person's press hands a relayed item to the session, as their own act. */
async function handOver($: EngineInterface, name: string): Promise<void> {
  const one = (await read($, relayed)).find(item => item.name === name)
  if (one === undefined) return
  await update($, relayed, list => list.map(item => (item.name === name ? { ...item, isShown: true } : item)))
  if (await read($, busy)) {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: one.text }] } })
  } else {
    void submit($, one.text).catch(() => undefined)
  }
  await dismissInClient($, one)
}

/**
 * Writes the mark file that carries one of the person's decisions to the client, which acts on
 * it at its next pass. Only a press in the pane calls this. False when the client named no
 * directory for it or the write failed.
 */
async function mark($: EngineInterface, id: string, verdict: 'approve' | 'refuse' | 'dismiss'): Promise<boolean> {
  const linked = await read($, link)
  const path = markPath(verdict === 'dismiss' ? linked?.dismiss : linked?.held, id, verdict)
  if (path === undefined) return false
  return $.fs.write(path, '').then(
    () => true,
    () => false,
  )
}

/** Tells the client, once, that the person is done with a relayed item. */
async function dismissInClient($: EngineInterface, one: WimRelayed): Promise<void> {
  if (one.id === '' || one.isDismissed) return
  await update($, relayed, list => list.map(item => (item.name === one.name ? { ...item, isDismissed: true } : item)))
  if (!(await mark($, one.id, 'dismiss'))) $.ui.log(`worldinmotion: could not mark ${one.id} dismissed`)
}

async function dismissRelayed($: EngineInterface, name: string): Promise<void> {
  const one = (await read($, relayed)).find(item => item.name === name)
  await update($, relayed, list => list.filter(item => item.name !== name))
  if (one !== undefined) await dismissInClient($, one)
}

async function tick($: EngineInterface): Promise<void> {
  if (isTicking) return
  isTicking = true
  try {
    await deliver($)
  } catch (error) {
    $.ui.log(`worldinmotion: delivery failed: ${String(error)}`)
  } finally {
    isTicking = false
  }
}

/** Counts read from disk alone, so the 5 second refresh never calls MCP. */
async function paneTick($: EngineInterface): Promise<void> {
  const panes = await $.ui.panes().catch(() => [])
  if (!panes.some(pane => pane.id === PANE && pane.isPlaced)) return
  const linked = await read($, link)
  if (linked === null) return
  const spool = await $.fs.list(linked.spool).catch(() => [])
  const waiting = newNames(spool.map(entry => entry.name), await read($, cursor)).length
  const held = await $.fs.list(linked.held ?? `${sessionDir(linked.spool)}/held`).catch(() => [])
  const heldOnDisk = held.filter(entry => entry.name.endsWith('.json')).length
  const now = await read($, panel)
  if (now.waiting === waiting && now.heldOnDisk === heldOnDisk) return
  await update($, panel, value => ({ ...value, waiting, heldOnDisk }))
}

/** Peers, held queue and leases, from `_internal`: only inside a hook. */
async function refreshPanel($: EngineInterface, note = ''): Promise<void> {
  const server = await $.mcp.connect(SERVER)
  if (!server.isConnected) {
    await update($, panel, value => ({ ...value, note: SETUP_LINE }))
    return
  }
  const ask = (op: InternalOp, args: Record<string, unknown> = {}) =>
    callInternal($, op, args).then(answer => (answer === undefined ? undefined : toolJson(answer)), () => undefined)
  // forPane: card fields of untrusted devices are for the person's eyes only.
  const [peers, held, leases] = await Promise.all([ask('peers', { forPane: true }), ask('held'), ask('leases')])
  await update($, panel, value => ({
    ...value,
    peers: parsePeers(peers),
    held: parseHeld(held),
    leases: parseLeases(leases),
    heldOnDisk: parseHeld(held).length,
    note,
  }))
}

/** The person's Approve or Refuse: a mark file the client acts on at its next pass. */
async function decide($: EngineInterface, op: 'approve' | 'refuse', id: string): Promise<void> {
  const verb = op === 'approve' ? 'approved' : 'refused'
  if (!(await mark($, id, op))) {
    await update($, panel, value => ({ ...value, note: `Could not mark ${id} ${verb}.` }))
    return
  }
  // The client takes the mark within a second; until then `_held` still lists the item.
  await update($, panel, value => ({
    ...value,
    held: value.held.filter(one => one.id !== id),
    note: `Message ${id} marked ${verb}. Press Refresh to see the queue as the client has it.`,
  }))
}

type PeerRow = { name: string; type: string; status?: string; cwd?: string; branch?: string }

/**
 * The mesh peers for ListAgents: structured from the `peers` op (so cwd and branch
 * pass through), else the public `peers` text, one address-led line each.
 */
async function peerRows($: EngineInterface): Promise<{ lines: string[]; rows: PeerRow[] } | undefined> {
  const structured = await callInternal($, 'peers').catch(() => undefined)
  const json = structured === undefined ? undefined : toolJson(structured)
  if (json !== undefined) {
    const peers = parsePeers(json)
    return {
      lines: peers.map(peerLine),
      rows: peers.map(peer => ({
        name: peer.address,
        type: peer.kind === '' ? 'worldinmotion' : peer.kind,
        ...(peer.status === '' ? {} : { status: peer.status }),
        ...(peer.cwd === undefined ? {} : { cwd: peer.cwd }),
        ...(peer.branch === undefined ? {} : { branch: peer.branch }),
      })),
    }
  }
  const text = await callTool($, 'peers', {}).catch(() => undefined)
  if (text === undefined || text.isError) return undefined
  const lines = toolText(text).split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  return { lines, rows: lines.map(line => ({ name: line.split(/\s+/, 1)[0] ?? line, type: 'worldinmotion' })) }
}

const FAILED = 'worldinmotion: the send failed in the plugin.'
// What a send's statuses mean, said with them so no one is told "delivered" for a queued send.
const SENT_MEANING =
  'routed: handed to a live session; queued: that session is offline and the relay keeps it 24 h. Neither means delivered or read, so say "sent".'

/** A room, or exactly one name@device: the only recipients the bridge considers. */
function isMeshShaped(to: string): boolean {
  return to.startsWith('#') || /^[^@\s]+@[^@\s]+$/.test(to)
}

type SendOutcome = { isSent: boolean; text: string }

/**
 * Sends `text` to `to` over the mesh, or answers undefined when `to` is not a
 * mesh route (the engine's own delivery then takes it). The person confirms
 * every send another plugin makes, and any send whose route is not `deliver`
 * (for a room: unless every device in the roster is).
 */
async function bridgeSend(
  $: EngineInterface,
  to: string,
  text: string,
  notifyWhenIdle: true | undefined,
  byPlugin: string | undefined,
): Promise<SendOutcome | undefined> {
  const route = await meshRoute($, to)
  if (route === undefined) return undefined
  if (byPlugin !== undefined || route.policy !== 'deliver') {
    if (!(await confirmSend($, to, sendReason(to, route.policy, byPlugin), text))) {
      return { isSent: false, text: `worldinmotion: the person did not confirm the send to ${to}.` }
    }
  }
  const args = { to, text, ...(notifyWhenIdle ? { notify_when_idle: true } : {}) }
  const answer = await callTool($, 'send', args)
  if (answer === undefined) return { isSent: false, text: SETUP_LINE }
  if (answer.isError) return { isSent: false, text: `worldinmotion refused the send: ${toolText(answer)}` }
  const statuses = parseSent(toolJson(answer))
  if (statuses === undefined || statuses.length === 0) {
    return { isSent: false, text: 'worldinmotion: the client answered no recipient status.' }
  }
  const named = statuses.map(one => `${one.to}: ${one.status}`).join(', ')
  const isSent = statuses.every(one => one.status === 'routed' || one.status === 'queued')
  return isSent
    ? { isSent: true, text: `Sent through worldinmotion (${named}). ${SENT_MEANING}` }
    : { isSent: false, text: `worldinmotion: not sent (${named}).` }
}

/** Records every local agent name and address seen, so none is ever bridged. */
async function noteTeammates($: EngineInterface): Promise<string[]> {
  const agents = await $.agent.list().catch(() => [])
  const names = agents.flatMap(agent => [agent.name, agent.teammateId].filter((n): n is string => n !== undefined))
  const known = await read($, teammates)
  if (names.every(name => known.includes(name))) return known
  return update($, teammates, list => [...new Set([...list, ...names])])
}

type Route = { policy: RoutePolicy }

/**
 * The mesh route for a SendMessage recipient, or undefined to leave it to the
 * engine: a room, or name@device where device is in the current roster and
 * the whole address was never a local teammate's this session.
 */
async function meshRoute($: EngineInterface, to: string): Promise<Route | undefined> {
  if (!isMeshShaped(to)) return undefined
  if (!to.startsWith('#') && (await noteTeammates($)).includes(to)) return undefined
  const answer = await callInternal($, 'route', { to }).catch(() => undefined)
  const route = answer === undefined ? undefined : parseRoute(toolJson(answer))
  if (route === undefined || !route.mesh) return undefined
  return { policy: route.policy }
}

/** Asks the person before sending to a device they have not marked as their own. */
function sendReason(to: string, policy: Route['policy'], byPlugin: string | undefined): string {
  if (byPlugin !== undefined) return `the plugin ${byPlugin} is sending it`
  if (to.startsWith('#')) return 'not every device in this room is one you trust'
  return `that device's policy here is ${policy ?? 'unknown'}, not one you trust`
}

/** Asks the person, showing what would go: all of it when short, else its outline. */
async function confirmSend($: EngineInterface, to: string, reason: string, text: string): Promise<boolean> {
  const question = `${describeMessage(to, text)}\n\nSend it (${reason})?`
  const answer = await $.ui.ask(question, { options: ['Send', 'Do not send'], header: 'wim send' }).catch(() => '')
  return answer === 'Send'
}

function age(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'wim',
      description: 'worldinmotion: peers, recent messages, the held queue and leases',
    })
    const isLinked = await handshake($).catch(error => {
      $.ui.status(`worldinmotion: could not reach the local client (${String(error)})`)
      return false
    })
    if (isLinked) {
      $.clock.every(POLL_MS, () => void tick($))
      $.clock.every(5000, () => void paneTick($).catch(() => undefined))
    }
    return started
  })

  // Allows the mod's own calls to its server and the model's calls to the
  // read-only public tools. `_internal` is the plugin's alone: the model gets
  // no op of it, read-only or not, since every op it needs has a public tool.
  // The model's calls to the other public tools take the normal permission flow.
  on('tool.check', ($, e, next) => {
    if (!e.tool.startsWith(TOOL_PREFIX)) return next(e)
    const name = e.tool.slice(TOOL_PREFIX.length)
    const byPlugin = (e.tool_use_id ?? '').startsWith(PLUGIN_CALL)
    // Another plugin's call carries the prefix too; only ours is allowed.
    const isOurs = next.origin.plugin === $.plugin.name || next.origin.plugin === 'engine'
    if (byPlugin && isOurs) return { decision: 'allow', reason: 'worldinmotion: the plugin itself' }
    if (READ_ONLY.has(name)) return { decision: 'allow', reason: 'worldinmotion: a read-only tool' }
    if (name.startsWith('_')) {
      return { decision: 'deny', reason: `worldinmotion: ${name} is internal to the plugin. Do not call it.` }
    }
    // Public tools only from here on; the set above is the whole read-only list.
    return next(e)
  }).catch(($, e, next) =>
    e.tool.startsWith(`${TOOL_PREFIX}_`) ? { decision: 'deny' } : next(e),
  )

  // A mod cannot remove a tool from the model's list, so the internal ones
  // cost as little as they can there: behind ToolSearch, a few words each.
  on('tool.describe', ($, e, next) =>
    e.tool.startsWith(`${TOOL_PREFIX}_`) ? { description: INTERNAL_DESCRIPTION, isDeferred: true } : next(e),
  )

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const isMesh = await takeSubmit($, e.text)
      await update($, busy, () => true)
      await update($, meshTurn, () => isMesh)
      await writePresence($, isMesh ? 'busy-mesh' : 'busy')
      await noteTeammates($)
    }
    return next(e)
  })

  // Each main-loop request carries every row appended before it, so the late
  // list restarts at each request's start.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) await update($, late, () => [])
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await update($, busy, () => false)
    await update($, meshTurn, () => false)
    await writePresence($, 'idle')
    // Not awaited: the submitted turn starts only after this one has ended.
    void redeliverLate($).catch(error => $.ui.log(`worldinmotion: ${String(error)}`))
    return next(e)
  })

  // The model's SendMessage: the tool refuses name@device before any
  // session.send hook runs, so the bridge takes the call here.
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const to = typeof e.to === 'string' ? e.to : undefined
    if (to === undefined) return next(e)
    const notifyWhenIdle = e.notify_when_idle === true ? true : undefined
    // Another plugin's call of the tool is confirmed like its $.session.send.
    const origin = next.origin.plugin
    const byPlugin = origin === 'engine' || origin === $.plugin.name ? undefined : origin
    const outcome = await bridgeSend($, to, e.message, notifyWhenIdle, byPlugin)
    if (outcome === undefined) return next(e)
    if (outcome.isSent) return { result: { success: true, message: outcome.text }, text: outcome.text }
    return { isError: true, result: { success: false, error: outcome.text }, text: outcome.text }
  }).catch(($, e, next) =>
    next.called || typeof e.to !== 'string' || !isMeshShaped(e.to)
      ? next(e)
      : { isError: true, result: { success: false, error: FAILED }, text: FAILED },
  )

  // Other plugins' $.session.send: the same routing.
  on('session.send', async ($, e, next) => {
    const byPlugin = e.origin.kind === 'plugin' ? e.origin.name : undefined
    const outcome = await bridgeSend($, e.to, e.text, undefined, byPlugin)
    if (outcome === undefined) return next(e)
    return outcome.isSent ? { isDelivered: true } : { isDelivered: false, reason: outcome.text }
  }).catch(($, e, next) =>
    next.called || !isMeshShaped(e.to) ? next(e) : { isDelivered: false, reason: FAILED },
  )

  on('tool.call', { tool: 'ListAgents' }, async ($, e, next) => {
    const ran = await next(e)
    // The mod's own calls raise this hook too; leave them as they are.
    if (e.tool_use_id.startsWith(PLUGIN_CALL)) return ran
    if (ran.deny !== undefined || ran.isError === true) return ran
    const found = await peerRows($)
    if (found === undefined || found.lines.length === 0) return ran
    const listed = ran.result
    return {
      result: {
        ...listed,
        listing: `${listed.listing}\n\n${PEERS_HEADING}\n${found.lines.join('\n')}`,
        sections: [
          ...(listed.sections ?? []),
          { kind: 'worldinmotion', total: found.rows.length, rows: found.rows },
        ],
      },
      ...(ran.context === undefined ? {} : { context: ran.context }),
    }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'wim' }, async $ => {
    await refreshPanel($)
    const opened = await $.ui.open({ id: PANE, title: 'worldinmotion' })
    return { text: opened.isPlaced ? 'worldinmotion pane opened.' : `worldinmotion pane waits: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const linked = await read($, link)
    const shown = await read($, panel)
    const items = await read($, recent)
    const relays = await read($, relayed)
    const now = await $.clock.now()

    return (
      <Box flexDirection="column">
        <Text bold>{linked === null ? 'Not set up' : `This session: ${linked.address}`}</Text>
        {linked === null && <Text dimColor>{SETUP_LINE}</Text>}
        {shown.note !== '' && <Text dimColor>{shown.note}</Text>}

        <Text bold>Peers</Text>
        {shown.peers.length === 0 && <Text dimColor>No peers listed.</Text>}
        {shown.peers.map(peer => (
          <Text>{peerLine(peer)}</Text>
        ))}

        <Text bold>{`Held for your approval (${shown.held.length})`}</Text>
        {shown.held.length === 0 && shown.heldOnDisk > 0 && (
          <Text dimColor>{`${shown.heldOnDisk} held: press Refresh to list them.`}</Text>
        )}
        {shown.held.map(one => (
          <Box flexDirection="column">
            <Text>{`${one.from}  ${one.kind}  ${age(one.at, now)} ago: ${one.preview}`}</Text>
            <Box flexDirection="row">
              <Button key={`approve:${one.id}`} label="Approve" onPress={() => decide($, 'approve', one.id)} />
              <Button key={`refuse:${one.id}`} label="Refuse" onPress={() => decide($, 'refuse', one.id)} />
            </Box>
          </Box>
        ))}

        <Text bold>{`Relayed by bots and gateways (${relays.filter(one => !one.isShown).length} not shown to Claude)`}</Text>
        {relays.length === 0 && <Text dimColor>None.</Text>}
        {[...relays].reverse().map(one => (
          <Box flexDirection="column">
            <Text>{`${one.from}  ${age(one.at, now)}: ${one.line}${one.isShown ? '  (shown)' : ''}`}</Text>
            <Box flexDirection="row">
              {!one.isShown && (
                <Button key={`deliver:${one.name}`} label="Give to Claude" onPress={() => handOver($, one.name)} />
              )}
              <Button key={`dismiss:${one.name}`} label="Dismiss" onPress={() => dismissRelayed($, one.name)} />
            </Box>
          </Box>
        ))}

        <Text bold>Recent</Text>
        {items.length === 0 && <Text dimColor>Nothing delivered yet.</Text>}
        {[...items].reverse().map(item => (
          <Text>{`${item.from}  ${item.kind}  ${age(item.at, now)}: ${item.line}`}</Text>
        ))}
        {shown.waiting > 0 && <Text dimColor>{`${shown.waiting} waiting to be delivered.`}</Text>}

        <Text bold>Leases</Text>
        {shown.leases.length === 0 && <Text dimColor>No leases held.</Text>}
        {shown.leases.map(lease => (
          <Text>{`${lease.name}  ${lease.holder}  ${age(now, lease.expiresAt)} left`}</Text>
        ))}

        <Button key="refresh" label="Refresh" onPress={() => refreshPanel($)} />
      </Box>
    )
  })
}
