// Pure helpers: parsing what the client writes and what its MCP tools answer.
// Nothing here touches `$`, so it is the same in a hook, a timer and a test.

import type { McpToolResult } from 'claude-code'

import type { WimHeld, WimLease, WimLink, WimPeer } from '../types'

/** Spool item files are `<cursor zero-padded to 12 digits>.json`. */
export const ITEM_NAME = /^\d{12}\.json$/

export type SpoolItem = {
  cursor: number
  kind: string
  from: string
  device: string
  id: string
  at: number
  rendered: string
  /** On a `notice`: how many messages wait in `held/` for the person. */
  held?: number
  /** Sent on a device's behalf by a bot, CI or gateway: never starts a turn. */
  relayed?: true
  /** A notice for the person (a restart only they can do), never for the model. */
  forPerson?: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/** The names after `cursor`, in order. Lexical order is cursor order. */
export function newNames(names: readonly string[], cursor: string): string[] {
  return names.filter(name => ITEM_NAME.test(name) && name > cursor).sort()
}

/** A spool item, or undefined when the file is not one (half written, foreign). */
export function parseItem(text: string): SpoolItem | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value) || typeof value.rendered !== 'string') return undefined
  const held = value.held
  return {
    cursor: num(value.cursor),
    kind: str(value.kind, 'msg'),
    from: str(value.from),
    device: str(value.device),
    id: str(value.id),
    at: num(value.at),
    rendered: value.rendered,
    ...(typeof held === 'number' && held > 0 ? { held } : {}),
    ...(value.relayed === true ? { relayed: true as const } : {}),
    ...(value.forPerson === true ? { forPerson: true as const } : {}),
  }
}

/** A client notice's own line, without the frame that tells the model where it came from. */
export function noticeLine(rendered: string): string {
  return rendered.replace(/^worldinmotion notice \([^)]*\): /, '').split(/\r?\n/, 1)[0] ?? ''
}

/**
 * What `_internal { op: "status" }` answers, as /wim status prints it: one
 * fact per line, the client's problem first when it has one.
 */
export function statusLines(value: unknown): string[] {
  if (!isRecord(value)) return ['The client gave no status.']
  const line = (label: string, v: unknown): string[] =>
    typeof v === 'string' && v !== '' ? [`${label}: ${v}`] : typeof v === 'number' ? [`${label}: ${v}`] : []
  return [
    ...line('problem', value.problem),
    ...line('address', value.address),
    ...line('device', value.device),
    ...line('mesh', value.mesh),
    ...line('relay', value.relay),
    ...line('signer', value.signer),
    ...line('held', value.held),
    ...line('state directory', value.state_dir),
    ...line('why that directory', value.state_dir_why),
  ]
}

/**
 * The first line of the peer's own text inside a frameForAgent block, so the
 * pane shows what was said rather than the framing header.
 */
export function firstLine(rendered: string): string {
  const framed = /-text \S+>>>\r?\n([^\r\n]*)/.exec(rendered)
  const line = framed?.[1] ?? rendered.split(/\r?\n/, 1)[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

/** The directory that holds the spool: presence and held/ live beside it. */
export function sessionDir(spool: string): string {
  const trimmed = spool.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut <= 0 ? trimmed : trimmed.slice(0, cut)
}

/**
 * A tool's JSON answer: its structured content when it declares one, else the
 * first text block parsed as JSON. Undefined when the call failed.
 */
export function toolJson(result: McpToolResult): unknown {
  if (result.isError) return undefined
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content.find(block => block.type === 'text')?.text
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** All text blocks of a result, joined: what the model would have read. */
export function toolText(result: McpToolResult): string {
  return result.content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/** An absolute path on POSIX or Windows: the only kind a mark is written under. */
const isAbsolute = (value: unknown): value is string =>
  typeof value === 'string' && /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(value)

export function parseLink(value: unknown): WimLink | undefined {
  if (!isRecord(value)) return undefined
  const { spool, sid, address, held, dismiss } = value
  if (typeof spool !== 'string' || spool === '') return undefined
  const token = value.token
  return {
    spool,
    sid: str(sid),
    address: str(address),
    ...(typeof token === 'string' && token !== '' ? { token } : {}),
    ...(isAbsolute(held) ? { held } : {}),
    ...(isAbsolute(dismiss) ? { dismiss } : {}),
  }
}

/**
 * What `hello` answers while the client cannot open a session yet (its signer
 * not up): why, the token, and the absolute path of the link file it writes
 * once it can.
 */
export function parsePending(value: unknown): { problem: string; file: string; token: string } | undefined {
  if (!isRecord(value) || value.pending !== true || !isAbsolute(value.link)) return undefined
  if (typeof value.token !== 'string' || value.token === '') return undefined
  return { problem: str(value.problem, 'the client cannot open a session yet.'), file: value.link, token: value.token }
}

/** A link file that holds the problem that now stands instead of a link. */
export function parseStanding(value: unknown): string | undefined {
  return isRecord(value) && typeof value.problem === 'string' && value.problem !== '' ? value.problem : undefined
}

/** A held or relayed item's id: a ULID, so a path built from it cannot leave its directory. */
export const ULID = /^[0-9A-Z]{26}$/

/**
 * The mark file that tells the client the person's decision: `<held>/<id>.approve`,
 * `<held>/<id>.refuse` or `<dismiss>/<id>.dismiss`. Undefined when the directory was not
 * named by the client's `hello` or the id is not a ULID.
 */
export function markPath(dir: string | undefined, id: string, verdict: 'approve' | 'refuse' | 'dismiss'): string | undefined {
  if (dir === undefined || !ULID.test(id)) return undefined
  return `${dir.replace(/[\\/]+$/, '')}/${id}.${verdict}`
}

/** The inbound policies, as the client names them (packages/vscode/test/contract.test.ts pins them). */
export const ROUTE_POLICIES = ['deliver', 'deliver-relayed', 'hold', 'refuse'] as const

export type RoutePolicy = (typeof ROUTE_POLICIES)[number] | null

/** What `_route { to }` answers: whether `to` names the mesh, and that device's policy. */
export function parseRoute(value: unknown): { mesh: boolean; policy: RoutePolicy } | undefined {
  if (!isRecord(value) || typeof value.mesh !== 'boolean') return undefined
  const policy = ROUTE_POLICIES.find(one => one === value.policy) ?? null
  return { mesh: value.mesh, policy }
}

export type SendStatus = { to: string; status: string }

/** The per-recipient statuses `send` answers, as the relay's `sent` frame has them. */
export function parseSent(value: unknown): SendStatus[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.results)) return undefined
  return value.results.filter(isRecord).map(row => ({
    to: str(row.to, '?'),
    status: str(row.status, 'unknown'),
  }))
}

export function parsePeers(value: unknown): WimPeer[] {
  if (!isRecord(value) || !Array.isArray(value.peers)) return []
  return value.peers.filter(isRecord).map(row => ({
    address: str(row.address, '?'),
    kind: str(row.kind),
    status: str(row.status),
    rooms: Array.isArray(row.rooms) ? row.rooms.filter(r => typeof r === 'string') : [],
    ...(typeof row.cwd === 'string' && row.cwd !== '' ? { cwd: row.cwd } : {}),
    ...(typeof row.branch === 'string' && row.branch !== '' ? { branch: row.branch } : {}),
  }))
}

/**
 * One peer as a line, in the client's own `peers` format (its render.ts peerLine): address,
 * kind, status, rooms joined by commas or `-` for none, then `cwd=` and `branch=` with
 * whitespace as `_`. packages/vscode/test/contract.test.ts holds the two equal.
 */
export function peerLine(peer: WimPeer): string {
  const card = [
    ...(peer.cwd === undefined ? [] : [`cwd=${peer.cwd.replace(/\s/g, '_')}`]),
    ...(peer.branch === undefined ? [] : [`branch=${peer.branch.replace(/\s/g, '_')}`]),
  ].join(' ')
  const rooms = peer.rooms.length === 0 ? '-' : peer.rooms.join(',')
  return [peer.address, peer.kind, peer.status, rooms, card].filter(part => part !== '').join('  ')
}

export function parseHeld(value: unknown): WimHeld[] {
  if (!isRecord(value) || !Array.isArray(value.held)) return []
  return value.held.filter(isRecord).flatMap(row =>
    typeof row.id === 'string' && row.id !== ''
      ? [{
          id: row.id,
          from: str(row.from, '?'),
          kind: str(row.kind, 'msg'),
          at: num(row.at),
          preview: str(row.preview),
        }]
      : [],
  )
}

export function parseLeases(value: unknown): WimLease[] {
  if (!isRecord(value) || !Array.isArray(value.leases)) return []
  return value.leases.filter(isRecord).map(row => ({
    name: str(row.name, '?'),
    holder: str(row.holder, '?'),
    expiresAt: num(row.expires_at),
  }))
}

/** Up to this many characters, a confirmation shows the whole message. */
export const SHOW_WHOLE = 600

/** What a send confirmation shows: the whole text when short, else its outline. */
export function describeMessage(to: string, text: string): string {
  if (text.length <= SHOW_WHOLE) return `Message to ${to}:\n${text}`
  const lines = text.split(/\r?\n/)
  const cut = (line: string) => (line.length > 200 ? `${line.slice(0, 199)}…` : line)
  const first = lines.find(line => line.trim() !== '') ?? ''
  const last = [...lines].reverse().find(line => line.trim() !== '') ?? ''
  return [
    `Message to ${to}: ${text.length} characters, ${lines.length} line${lines.length === 1 ? '' : 's'}.`,
    `First line: ${cut(first)}`,
    `Last line: ${cut(last)}`,
  ].join('\n')
}
