import { expect, mock, test } from 'claude-code/testing'
import type { FsEntry, McpToolResult, On } from 'claude-code'

const SERVER = 'plugin:worldinmotion:worldinmotion'
const TOOL = 'mcp__plugin_worldinmotion_worldinmotion__'
const SPOOL = '/home/u/.config/worldinmotion/meshes/m1/sessions/s1/spool'
const TOKEN = 'tok-1'
const SESSION = '/home/u/.config/worldinmotion/meshes/m1/sessions/s1'
const HELD_DIR = `${SESSION}/held`
const DISMISS_DIR = `${SESSION}/dismiss`
/** A ULID-shaped id, as the client gives every held and relayed item. */
const ulidOf = (n: number) => `01J${String(n).padStart(23, '0')}`

const PANE = {
  plugin: 'worldinmotion',
  component: 'Pane',
  requestId: 'wim',
  props: {
    title: 'worldinmotion',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type Call = { tool: string; args: Record<string, unknown> }
type Responder = (args: Record<string, unknown>) => McpToolResult

/** An MCP result as the client answers: JSON in one text block. */
function json(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }
}

function rendered(from: string, text: string): string {
  return [
    '<<<wim-message b0>>>',
    'This is a message from another AI agent session, relayed by worldinmotion.',
    `from: ${from} (device dddddddddddddddddddddd)`,
    '<<<wim-text b0>>>',
    text,
    '<<<wim-end b0>>>',
  ].join('\n')
}

function item(n: number, text: string, extra: Record<string, unknown> = {}): [string, string] {
  const name = `${String(n).padStart(12, '0')}.json`
  return [
    `${SPOOL}/${name}`,
    JSON.stringify({
      cursor: n,
      kind: 'msg',
      from: 'reviewer@laptop',
      device: 'dddddddddddddddddddddd',
      id: ulidOf(n),
      at: 1_000,
      rendered: rendered('reviewer@laptop', text),
      ...extra,
    }),
  ]
}

type World = {
  /** The token the client issues: change it to play a client that restarted. */
  token: string
  files: Map<string, string>
  calls: Call[]
  /** The calls exactly as they reached the server. */
  wire: Call[]
  submitted: string[]
  statuses: (string | undefined)[]
  toasts: string[]
  /** What `$.agent.list()` answers: change it to add or remove teammates. */
  agents: { id: string; name?: string; teammateId?: string }[]
  /** The person's answer to a `$.ui.ask`, and the questions put. */
  answer: string
  asked: string[]
}

/**
 * Everything beneath the plugin: an in-memory file system, the plugin's MCP
 * server answering with the design's tool outputs, and the engine's bottoms.
 */
function world(
  on: On,
  options: {
    connected?: boolean
    tools?: Record<string, Responder>
    drop?: string
    isWriteDenied?: (path: string) => boolean
    /** True for a submit the engine fails (a hook that throws). */
    failSubmit?: () => boolean
  } = {},
): World {
  const w: World = {
    token: TOKEN,
    files: new Map(),
    calls: [],
    wire: [],
    submitted: [],
    statuses: [],
    toasts: [],
    agents: [],
    answer: 'Send',
    asked: [],
  }
  const tools: Record<string, Responder> = {
    _hello: () => json({ spool: SPOOL, sid: 's1', address: 'builder@desk', token: w.token, held: HELD_DIR, dismiss: DISMISS_DIR }),
    _route: () => json({ mesh: true, policy: 'deliver' }),
    ...options.tools,
  }

  on('fs.list', (_, e) => {
    const prefix = `${e.path.replace(/\/$/, '')}/`
    const entries: FsEntry[] = [...w.files.keys()]
      .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(path => ({ name: path.slice(prefix.length), kind: 'file', size: 1, mtimeMs: 0, isLink: false }))
    return { value: entries }
  })
  on('fs.read', (_, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => {
    if (options.isWriteDenied?.(e.path)) return { deny: `EACCES ${e.path}` }
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('mcp.connect', () =>
    options.connected === false
      ? { value: { isConnected: false, reason: 'failed', message: 'not connected' } }
      : { value: { isConnected: true, server: SERVER } },
  )
  const fail = (text: string): McpToolResult => ({ content: [{ type: 'text', text }], isError: true })
  // As the client: public tools by name, plugin-only ops through `_internal`
  // with the token `hello` issued. A call is recorded as `_<op>` with its
  // args (and token) so tests read it as the operation it is. The client has
  // no op that decides anything: approve, refuse and dismiss are mark files.
  on('mcp.call', (_, e) => {
    w.wire.push({ tool: e.tool, args: e.args })
    if (e.tool.startsWith('_') && e.tool !== '_internal') return { value: fail(`unknown tool ${e.tool}`) }
    if (e.tool !== '_internal') {
      w.calls.push({ tool: e.tool, args: e.args })
      const answer = tools[e.tool]
      return { value: answer ? answer(e.args) : fail('no such tool') }
    }
    const { op, args = {}, token } = e.args as { op: string; args?: Record<string, unknown>; token?: string }
    const name = `_${op}`
    w.calls.push({ tool: name, args: { ...args, ...(token === undefined ? {} : { token }) } })
    // As the client: `status` answers without the token, so a tab that cannot link learns why.
    if (op !== 'hello' && op !== 'status' && token !== w.token) return { value: fail('worldinmotion: internal operations need the token from hello') }
    const answer = tools[name]
    return { value: answer ? answer(args) : fail(`invalid input: op: unknown op ${op}`) }
  })
  on('session.id', () => ({ value: 'claude-session-1' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.status', (_, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('agent.list', () => ({
    value: w.agents.map(agent => ({ description: '', type: 'teammate', status: 'idle' as const, ...agent })),
  }))
  // `$.ui.ask` is a call of AskUserQuestion: this stands for the person.
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const question = e.questions[0]?.question ?? ''
    w.asked.push(question)
    return { result: { questions: e.questions, answers: { [question]: w.answer } } }
  })
  on('prompt.submit', (_, e) => {
    if (options.failSubmit?.()) throw new Error('the engine could not submit')
    if (options.drop !== undefined) return { drop: options.drop }
    w.submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    } as const
  })
  return w
}

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const MODEL = { kind: 'model' } as const
const WIM = {
  command: 'wim',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const
const COMPLETE = { answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' } as const

/** How many times `text` reached the session: as appended rows and as submitted turns. */
function timesShown(session: { appended: () => readonly { message: { content: unknown } }[] }, w: World, text: string): number {
  const count = (whole: string) => whole.split(text).length - 1
  return session.appended().reduce((n, row) => n + count(JSON.stringify(row.message.content)), 0) + w.submitted.reduce((n, one) => n + count(one), 0)
}

test('the handshake calls _hello with the Claude session id', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await $.session.start(START)

  expect(w.calls).toEqual([{ tool: '_hello', args: { claudeSessionId: 'claude-session-1' } }])
  expect(w.files.get(`${SESSION}/presence`)).toBe('idle')
  // A permanent line: this tab's address and what is held for it.
  expect(w.statuses).toEqual(['builder@desk, 0 held'])
})

test('the status line counts what is held, refreshed every 5 seconds and set only when it changes', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  await clock.advance(5000)
  await clock.settle()
  expect(w.statuses).toEqual(['builder@desk, 0 held'])
  w.files.set(`${HELD_DIR}/${ulidOf(1)}.json`, '{}')
  w.files.set(`${HELD_DIR}/${ulidOf(1)}.approve`, '')
  await clock.advance(5000)
  await clock.settle()
  expect(w.statuses).toEqual(['builder@desk, 0 held', 'builder@desk, 1 held'])
})

test('with the client not running, one status line saying so and nothing else', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { connected: false })
  w.files.set(...item(1, 'hello'))
  await $.session.start(START)
  await clock.advance(12_000)
  await clock.settle()

  expect(w.statuses).toEqual([
    "the plugin's client (its MCP server) is not running: not connected. Node.js 22.18 or newer must be on the PATH; /mcp shows the server.",
  ])
  expect(w.calls).toHaveLength(0)
  expect(w.submitted).toHaveLength(0)
  expect(w.files.has(`${SPOOL}/cursor`)).toBe(false)
})

const NOT_SET_UP = 'this device is not set up (no device keys at /home/u/.config/worldinmotion/device.json): run `wim init` first'
const NO_SIGNER = 'the device keys in /home/u/.config/worldinmotion/device.json are encrypted and no signer is running: run `wim agent start` in a terminal you opened yourself'

const LINK_FILE = '/home/u/.config/worldinmotion/links/abc.json'
const pendingHello = (problem: string) => () => json({ pending: true, problem, link: LINK_FILE, token: TOKEN })

test("a device that is not set up shows the client's reason and how to install wim", async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { tools: { _hello: pendingHello(NOT_SET_UP) } })
  await $.session.start(START)
  await clock.advance(5000)
  await clock.settle()

  expect(w.statuses).toHaveLength(1)
  expect(w.statuses[0]).toStartWith(`${NOT_SET_UP}. This tab links by itself once that is done. `)
  expect(w.statuses[0]).toContain('npm install --global worldinmotion')
  expect(w.statuses[0]).toContain('export PATH="$(npm prefix -g)/bin:$PATH"')
  expect(w.statuses[0]).toContain('in a terminal you opened yourself (not this chat)')
})

test("a handshake the client refuses outright shows the client's words, and a prompt tries it again", async ($, on) => {
  let said = 'this device is in 2 meshes: set WIM_MESH or pass --mesh (a, b)'
  const w = world(on, {
    tools: {
      _hello: () =>
        said === ''
          ? json({ spool: SPOOL, sid: 's1', address: 'builder@desk', token: TOKEN, held: HELD_DIR, dismiss: DISMISS_DIR })
          : { content: [{ type: 'text', text: said }], isError: true },
    },
  })
  const clock = mock.clock(on)
  await $.session.start(START)
  expect(w.statuses).toEqual([said])
  // Never from a timer: an MCP call there would prompt the person.
  await clock.advance(30_000)
  await clock.settle()
  expect(w.calls.filter(call => call.tool === '_hello')).toHaveLength(1)

  // The person's next prompt is a dispatch: the handshake runs again there.
  said = ''
  await $.turn.start({ text: 'work', turnId: 't1' })
  expect(w.calls.filter(call => call.tool === '_hello')).toHaveLength(2)
  expect(w.statuses.at(-1)).toBe('builder@desk, 0 held')
  await $.turn.complete(COMPLETE)
  await $.turn.start({ text: 'more', turnId: 't2' })
  expect(w.calls.filter(call => call.tool === '_hello')).toHaveLength(2)
})

test('a tab started before its signer links by itself from the link file, with no MCP call from a timer, and then delivers', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { tools: { _hello: pendingHello(NO_SIGNER) } })
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: { listing: 'none' } }))
  await $.session.start(START)
  // The client's real reason, not a set-up line: the device is set up.
  expect(w.statuses).toEqual([`${NO_SIGNER}. This tab links by itself once that is done.`])
  w.files.set(...item(1, 'sent while the signer was down'))
  await clock.advance(5000)
  await clock.settle()
  expect(w.submitted).toHaveLength(0)
  // A half-written or foreign link file is not a link.
  w.files.set(LINK_FILE, '{"spool":')
  await clock.advance(250)
  await clock.settle()
  w.files.set(LINK_FILE, JSON.stringify({ note: 'not a link' }))
  await clock.advance(250)
  await clock.settle()
  expect(w.statuses).toHaveLength(1)

  // The signer is up: the client opened the session and wrote the link file.
  w.files.set(LINK_FILE, JSON.stringify({ spool: SPOOL, sid: 's1', address: 'builder@desk', held: HELD_DIR, dismiss: DISMISS_DIR }))
  await clock.advance(250)
  await clock.settle()
  expect(w.statuses.at(-1)).toBe('builder@desk, 0 held')
  await clock.advance(250)
  await clock.settle()
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toContain('sent while the signer was down')
  expect(w.files.get(`${SESSION}/presence`)).toBe('idle')
  // Only the one handshake, made in session.start: nothing from the timers.
  expect(w.calls.map(call => call.tool)).toEqual(['_hello'])
  // The token from the kept handshake carries the internal ops.
  await $.tool.call({ tool: 'ListAgents' })
  expect(w.calls).toContainEqual({ tool: '_peers', args: { token: TOKEN } })
})

test('/wim status in a tab waiting on its link file hands the client the token it was issued', async ($, on) => {
  const w = world(on, {
    tools: {
      _hello: pendingHello(NO_SIGNER),
      _status: () => json({ problem: NO_SIGNER, state_dir: '/home/u/.config/worldinmotion', state_dir_why: 'the default' }),
    },
  })
  mock.clock(on)
  await $.session.start(START)
  const ran = await $.command.run({ ...WIM, args: 'status' })
  expect(ran.text).toContain(`  problem: ${NO_SIGNER}`)
  // The repeat handshake and the status op carry the kept token, so the client takes them as this tab's.
  expect(w.calls).toEqual([
    { tool: '_hello', args: { claudeSessionId: 'claude-session-1' } },
    { tool: '_hello', args: { claudeSessionId: 'claude-session-1', token: TOKEN } },
    { tool: '_status', args: { token: TOKEN } },
  ])
})

test('a link file that holds a problem that now stands ends the wait, and the next prompt tries again', async ($, on) => {
  const clock = mock.clock(on)
  const standing = 'this device is in 2 meshes: set WIM_MESH or pass --mesh (a, b)'
  let isPending = true
  const w = world(on, { tools: { _hello: () => (isPending ? pendingHello(NO_SIGNER)() : { content: [{ type: 'text', text: standing }], isError: true }) } })
  await $.session.start(START)
  isPending = false
  w.files.set(LINK_FILE, JSON.stringify({ problem: standing }))
  await clock.advance(250)
  await clock.settle()
  expect(w.statuses.at(-1)).toBe(standing)
  await $.turn.start({ text: 'work', turnId: 't1' })
  // The client accepts a repeat handshake only with the token it issued: it is kept.
  expect(w.calls.filter(call => call.tool === '_hello')).toEqual([
    { tool: '_hello', args: { claudeSessionId: 'claude-session-1' } },
    { tool: '_hello', args: { claudeSessionId: 'claude-session-1', token: TOKEN } },
  ])
})

test('a tab waiting on a link file tries the handshake again at the next prompt, as its client may have restarted', async ($, on) => {
  let isRestarted = false
  const w = world(on, {
    tools: {
      _hello: () =>
        isRestarted ? json({ spool: SPOOL, sid: 's1', address: 'builder@desk', token: TOKEN, held: HELD_DIR, dismiss: DISMISS_DIR }) : pendingHello(NO_SIGNER)(),
    },
  })
  mock.clock(on)
  await $.session.start(START)
  // A new client never writes the file the old one named: the person's next prompt links the tab.
  isRestarted = true
  await $.turn.start({ text: 'work', turnId: 't1' })
  expect(w.calls.filter(call => call.tool === '_hello')).toEqual([
    { tool: '_hello', args: { claudeSessionId: 'claude-session-1' } },
    { tool: '_hello', args: { claudeSessionId: 'claude-session-1', token: TOKEN } },
  ])
  expect(w.statuses.at(-1)).toBe('builder@desk, 0 held')
  expect(w.files.get(`${SESSION}/presence`)).toBe('busy')
})

test('a refused token (the client restarted) runs the handshake again and the op once more', async ($, on) => {
  const w = world(on, { tools: { _peers: () => json({ peers: [{ address: 'reviewer@laptop', kind: 'claude-code', status: 'idle', rooms: [] }] }) } })
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: { listing: 'none' } }))
  mock.clock(on)
  await $.session.start(START)
  w.token = 'tok-2'

  const listed = await $.tool.call({ tool: 'ListAgents' })
  expect((listed.result as { listing: string }).listing).toContain('reviewer@laptop')
  expect(w.calls.map(call => [call.tool, call.args.token])).toEqual([
    ['_hello', undefined],
    ['_peers', TOKEN],
    ['_hello', TOKEN],
    ['_peers', 'tok-2'],
  ])
})

test('a notice for the person is a toast and a status line count, never a turn', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { tools: { _status: () => json({ address: 'builder@desk' }) } })
  await $.session.start(START)
  const restart = 'this device\'s keys were encrypted (wim agent encrypt) while this session was running: restart it so it uses the signer'
  w.files.set(...item(1, '', { kind: 'notice', forPerson: true, rendered: `worldinmotion notice (from the local client, not from a peer or the person): ${restart}` }))
  await clock.advance(250)
  await clock.settle()
  expect(w.toasts).toEqual([`worldinmotion: ${restart}`])
  expect(w.submitted).toHaveLength(0)
  expect(w.files.get(`${SPOOL}/cursor`)).toBe('000000000001.json')

  await clock.advance(5000)
  await clock.settle()
  expect(w.statuses.at(-1)).toBe('builder@desk, 0 held, 1 notice (/wim status)')
  const ran = await $.command.run({ ...WIM, args: 'status' })
  expect(ran.text).toContain(`notice: ${restart}`)
})

test('/wim status prints what the client says about this tab', async ($, on) => {
  const w = world(on, {
    tools: {
      _status: () =>
        json({
          address: 'builder@desk',
          device: 'desk (dddddddddddddddddddddd)',
          mesh: 'm1',
          relay: 'connected',
          signer: 'not used: the key file is plaintext',
          held: 2,
          state_dir: '/home/u/.config/worldinmotion/profiles/abc',
          state_dir_why: 'CLAUDE_CONFIG_DIR is set',
        }),
    },
  })
  mock.clock(on)
  await $.session.start(START)

  const ran = await $.command.run({ ...WIM, args: ' status ' })
  expect(ran.text).toBe(
    [
      'This tab is linked as builder@desk.',
      '  address: builder@desk',
      '  device: desk (dddddddddddddddddddddd)',
      '  mesh: m1',
      '  relay: connected',
      '  signer: not used: the key file is plaintext',
      '  held: 2',
      '  state directory: /home/u/.config/worldinmotion/profiles/abc',
      '  why that directory: CLAUDE_CONFIG_DIR is set',
    ].join('\n'),
  )
  expect(w.calls.at(-1)).toEqual({ tool: '_status', args: { token: TOKEN } })
})

test('/wim status in a tab that cannot link asks without a token and shows the problem', async ($, on) => {
  const w = world(on, {
    tools: {
      _hello: () => ({ content: [{ type: 'text', text: NO_SIGNER }], isError: true }),
      _status: () => json({ problem: NO_SIGNER, state_dir: '/home/u/.config/worldinmotion', state_dir_why: 'the default' }),
    },
  })
  mock.clock(on)
  await $.session.start(START)

  const ran = await $.command.run({ ...WIM, args: 'status' })
  expect(ran.text).toStartWith('This tab is not linked.\n')
  expect(ran.text).toContain(`  problem: ${NO_SIGNER}`)
  expect(ran.text).toContain('  state directory: /home/u/.config/worldinmotion')
  expect(w.calls.at(-1)).toEqual({ tool: '_status', args: {} })
})

test('/wim status says when the client itself is not running', async ($, on) => {
  world(on, { connected: false })
  mock.clock(on)
  await $.session.start(START)
  const ran = await $.command.run({ ...WIM, args: 'status' })
  expect(ran.text).toBe("The plugin's client (its MCP server) is not running: not connected.")
})

test('/wim status reports a client that gives no status', async ($, on) => {
  world(on, { tools: { _status: () => ({ content: [{ type: 'text', text: 'worldinmotion: boom' }], isError: true }) } })
  mock.clock(on)
  await $.session.start(START)
  expect((await $.command.run({ ...WIM, args: 'status' })).text).toBe(
    'This tab is linked as builder@desk.\n  The client did not answer: worldinmotion: boom',
  )
})

test('/wim name renames the tab and links again; anything else gets the usage', async ($, on) => {
  let address = 'builder@desk'
  const w = world(on, {
    tools: {
      _hello: () => json({ spool: SPOOL, sid: 's1', address, token: TOKEN, held: HELD_DIR, dismiss: DISMISS_DIR }),
      rename: args => {
        if (args.name === 'Bad Name') return { content: [{ type: 'text', text: 'a name is 1 to 32 of a-z, 0-9 and -' }], isError: true }
        address = `${String(args.name)}@desk`
        return { content: [{ type: 'text', text: `This session is now ${address}.` }], isError: false }
      },
    },
  })
  mock.clock(on)
  await $.session.start(START)

  expect((await $.command.run({ ...WIM, args: 'name reviewer' })).text).toBe('This session is now reviewer@desk.')
  expect(w.calls.filter(call => call.tool === 'rename')).toEqual([{ tool: 'rename', args: { name: 'reviewer' } }])
  expect(w.statuses.at(-1)).toBe('reviewer@desk, 0 held')
  expect((await $.command.run({ ...WIM, args: 'name Bad Name' })).text).toBe('a name is 1 to 32 of a-z, 0-9 and -')
  expect((await $.command.run({ ...WIM, args: 'name' })).text).toContain('Usage: /wim name <name>')
  expect((await $.command.run({ ...WIM, args: 'help' })).text).toContain('/wim status')
})

test('/wim name in a tab that is not linked says why', async ($, on) => {
  const w = world(on, { tools: { _hello: () => ({ content: [{ type: 'text', text: NO_SIGNER }], isError: true }) } })
  mock.clock(on)
  await $.session.start(START)
  const ran = await $.command.run({ ...WIM, args: 'name reviewer' })
  expect(ran.text).toBe(`This tab is not linked, so it has no name to change. ${NO_SIGNER}`)
  expect(w.calls.some(call => call.tool === 'rename')).toBe(false)
})

test('tool.check allows the plugin its own calls and refuses the model the internal tools', async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))

  const own = await $.tool.check({ tool: `${TOOL}_hello`, input: {}, tool_use_id: 'toolu_plugin_01' })
  expect(own.decision).toBe('allow')

  const ownPublic = await $.tool.check({ tool: `${TOOL}send`, input: {}, tool_use_id: 'toolu_plugin_02' })
  expect(ownPublic.decision).toBe('allow')

  const model = await $.tool.check({ tool: `${TOOL}_approve`, input: { id: 'x' }, tool_use_id: 'toolu_01abc' })
  expect(model.decision).toBe('deny')

  // The model's call to a public tool goes to the normal flow beneath.
  const modelPublic = await $.tool.check({ tool: `${TOOL}send`, input: {}, tool_use_id: 'toolu_01abd' })
  expect(modelPublic.decision).toBe('ask')

  // Read-only public tools are allowed for the model; the rest keep the normal flow.
  for (const name of ['peers', 'inbox', 'wait', 'history']) {
    const read = await $.tool.check({ tool: `${TOOL}${name}`, input: {}, tool_use_id: 'toolu_01abe' })
    expect(read.decision, name).toBe('allow')
  }
  for (const name of ['ask', 'reply', 'send_file', 'rooms', 'lease', 'rename']) {
    const write = await $.tool.check({ tool: `${TOOL}${name}`, input: {}, tool_use_id: 'toolu_01abf' })
    expect(write.decision, name).toBe('ask')
  }
  const internal = await $.tool.check({ tool: `${TOOL}_peers`, input: {}, tool_use_id: 'toolu_01abg' })
  expect(internal.decision).toBe('deny')

  const other = await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_plugin_03' })
  expect(other.decision).toBe('ask')
})

test('while idle, new items are submitted in order and the cursor moves', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const appended = mock.session(on)
  await $.session.start(START)
  w.files.set(...item(2, 'second'))
  w.files.set(...item(1, 'first'))
  await clock.advance(249)
  expect(w.submitted).toHaveLength(0)
  await clock.advance(1)
  await clock.settle()

  expect(w.submitted).toHaveLength(1)
  const text = w.submitted[0] ?? ''
  expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'))
  expect(w.files.get(`${SPOOL}/cursor`)).toBe('000000000002.json')
  expect(appended.appended()).toHaveLength(0)

  // Nothing new: nothing delivered twice.
  await clock.advance(2000)
  expect(w.submitted).toHaveLength(1)
})

test('while busy, items are appended, and the cursor moves', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const session = mock.session(on)
  await $.session.start(START)
  await $.turn.start({ text: 'work', turnId: 't1' })
  expect(w.files.get(`${SESSION}/presence`)).toBe('busy')

  w.files.set(...item(7, 'mid-turn note'))
  await clock.advance(250)
  await clock.settle()

  const rows = session.appended()
  expect(rows).toHaveLength(1)
  expect(JSON.stringify(rows[0]?.message.content)).toContain('mid-turn note')
  expect(w.submitted).toHaveLength(0)
  expect(w.files.get(`${SPOOL}/cursor`)).toBe('000000000007.json')
})

test('an item appended after the last request began is named at the turn end, once, and never repeated', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const session = mock.session(on)
  await $.session.start(START)
  await $.turn.start({ text: 'work', turnId: 't1' })

  // Appended before a request starts: that request carries it.
  w.files.set(...item(1, 'early'))
  await clock.advance(250)
  await clock.settle()
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 3 })
  for await (const _ of step) void _

  // Appended after the last request began: nothing reads it this turn.
  w.files.set(...item(2, 'late'))
  await clock.advance(250)
  await clock.settle()

  await $.turn.complete(COMPLETE)
  await clock.settle()

  // Its text is in the conversation once, as the appended row; the turn the
  // plugin starts names it by sender and id instead of repeating it.
  expect(timesShown(session, w, 'late')).toBe(1)
  expect(w.submitted).toEqual([
    `(worldinmotion: a message from reviewer@laptop (id ${ulidOf(2)}) arrived as your last turn ended. It is in the conversation above, not repeated here.)`,
  ])
  expect(timesShown(session, w, 'early')).toBe(1)
  expect(w.files.get(`${SESSION}/presence`)).toBe('idle')

  // Once: the next turn's end submits nothing more.
  await $.turn.start({ text: '', turnId: 't2' })
  await $.turn.complete({ ...COMPLETE, turnId: 't2' })
  await clock.settle()
  expect(w.submitted).toHaveLength(1)
})

test('a reply whose append is still under way as the turn ends reaches the session once', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const session = mock.session(on)
  // The engine takes 10 ms to store a row: the turn ends in between.
  on('session.append', { door: 'note' }, async (_, e, next) => {
    await clock.sleep(10)
    return next(e)
  })
  await $.session.start(START)
  await $.turn.start({ text: 'work', turnId: 't1' })
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 3 })
  for await (const _ of step) void _

  // The reply and, just behind it, a second message, in one pass.
  w.files.set(...item(1, 'the reply'))
  w.files.set(...item(2, 'right behind it'))
  await clock.advance(250)
  expect(session.appended()).toHaveLength(0)
  await $.turn.complete(COMPLETE)
  await clock.settle()
  expect(w.submitted).toHaveLength(0)
  await clock.advance(50)
  await clock.settle()

  // The reply is the appended row; the turn the plugin starts names it and
  // carries the second message, which came after the turn had ended.
  expect(timesShown(session, w, 'the reply')).toBe(1)
  expect(timesShown(session, w, 'right behind it')).toBe(1)
  expect(session.appended()).toHaveLength(1)
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toStartWith(`(worldinmotion: a message from reviewer@laptop (id ${ulidOf(1)}) arrived as your last turn ended.`)
  expect(w.files.get(`${SPOOL}/cursor`)).toBe('000000000002.json')

  await clock.advance(1000)
  expect(w.submitted).toHaveLength(1)
  expect(session.appended()).toHaveLength(1)
})

test('items the client already took (its cursor file is past them) are not delivered again', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  w.files.set(...item(1, 'read through inbox'))
  w.files.set(...item(2, 'read through wait'))
  w.files.set(...item(3, 'new'))
  // The client's `inbox` or `wait` tool took the first two and moved the file.
  w.files.set(`${SPOOL}/cursor`, '000000000002.json\n')
  await clock.advance(250)
  await clock.settle()

  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toContain('new')
  expect(w.submitted[0]).not.toContain('read through')
  expect(w.files.get(`${SPOOL}/cursor`)).toBe('000000000003.json')
})

test('a failure part-way through a pass hands nothing over twice', async ($, on) => {
  const clock = mock.clock(on)
  let isRefusing = true
  const w = world(on, {
    failSubmit: () => {
      const refuse = isRefusing
      isRefusing = false
      return refuse
    },
  })
  const session = mock.session(on)
  // A hook above refuses to store the second as a row, so it needs a turn of
  // its own, and the engine fails the first submit.
  on('session.append', { door: 'note' }, (_, e, next) =>
    JSON.stringify(e.message.content).includes('second') ? { deny: 'not as a row' } : next(e),
  )
  await $.session.start(START)
  await $.turn.start({ text: 'work', turnId: 't1' })
  w.files.set(...item(1, 'first'))
  w.files.set(...item(2, 'second'))
  w.files.set(...item(3, 'third'))
  await clock.advance(250)
  await clock.settle()
  // The first went; the cursor moved past it and no further.
  expect(timesShown(session, w, 'first')).toBe(1)
  expect(timesShown(session, w, 'second')).toBe(0)
  expect(w.files.get(`${SPOOL}/cursor`)).toBe('000000000001.json')

  await clock.advance(250)
  await clock.settle()
  for (const text of ['first', 'second', 'third']) expect(timesShown(session, w, text)).toBe(1)
  expect(w.files.get(`${SPOOL}/cursor`)).toBe('000000000003.json')
})

test('an item handed over behind one that failed is not handed over again', async ($, on) => {
  const clock = mock.clock(on)
  let isRefusing = true
  const w = world(on, {
    failSubmit: () => {
      const refuse = isRefusing
      isRefusing = false
      return refuse
    },
  })
  await $.session.start(START)
  w.files.set(...item(1, 'please look'))
  w.files.set(...item(2, '', { kind: 'notice', held: 2 }))
  await clock.advance(250)
  await clock.settle()
  // The notice was shown; the message's turn could not be started.
  expect(w.toasts).toEqual(['worldinmotion: 2 messages held for your approval (/wim)'])
  expect(w.submitted).toHaveLength(0)
  expect(w.files.get(`${SPOOL}/cursor`)).toBeUndefined()

  await clock.advance(250)
  await clock.settle()
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toContain('please look')
  // The notice is not shown a second time, and the cursor is past both.
  expect(w.toasts).toHaveLength(1)
  expect(w.files.get(`${SPOOL}/cursor`)).toBe('000000000002.json')
})

test('a held notice raises a toast and does not start a turn', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  w.files.set(...item(3, 'held', { kind: 'notice', held: 2 }))
  await clock.advance(250)
  await clock.settle()

  expect(w.toasts).toEqual(['worldinmotion: 2 messages held for your approval (/wim)'])
  expect(w.submitted).toHaveLength(0)
  expect(w.files.get(`${SPOOL}/cursor`)).toBe('000000000003.json')
})

test('a held receipt raises a toast for the person and does not start a turn', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  w.files.set(...item(3, 'notice', { kind: 'notice', heldBy: 'reviewer@laptop' }))
  w.files.set(...item(4, 'blank', { kind: 'notice', heldBy: '' }))
  await clock.advance(250)
  await clock.settle()

  expect(w.toasts).toEqual([
    "worldinmotion: reviewer@laptop is holding your message for its person's approval; it is not delivered until they approve it there",
  ])
  // A notice with an empty heldBy is an ordinary notice, for the model.
  expect(w.submitted).toHaveLength(1)
  expect(w.files.get(`${SPOOL}/cursor`)).toBe('000000000004.json')
})

test('ListAgents falls back to the peers text when _peers is unavailable', async ($, on) => {
  world(on, {
    tools: { peers: () => ({ content: [{ type: 'text', text: 'reviewer@laptop claude-code idle #ci' }], isError: false }) },
  })
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: { listing: 'researcher (subagent)' } }))

  const listed = await $.tool.call({ tool: 'ListAgents' })
  const result = listed.result as { listing: string; sections?: { kind: string; total: number }[] }
  expect(result.listing).toContain('researcher (subagent)')
  expect(result.listing).toContain('worldinmotion peers (other machines; address with name@device)')
  expect(result.listing).toContain('reviewer@laptop claude-code idle #ci')
  expect(result.sections).toContainEqual(expect.objectContaining({ kind: 'worldinmotion', total: 1 }))
})

test('ListAgents passes cwd and branch through from _peers', async ($, on) => {
  world(on, {
    tools: {
      _peers: () =>
        json({
          peers: [
            { address: 'reviewer@laptop', kind: 'claude-code', status: 'idle', rooms: [], cwd: '/src/app', branch: 'main' },
            { address: 'bot@ci', kind: 'bot', status: 'busy', rooms: ['#ci'] },
          ],
        }),
    },
  })
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: { listing: 'researcher (subagent)' } }))
  // The handshake issues the token every internal op needs.
  mock.clock(on)
  await $.session.start(START)

  const listed = await $.tool.call({ tool: 'ListAgents' })
  const result = listed.result as { listing: string; sections?: { kind: string; total: number; rows: unknown[] }[] }
  expect(result.listing).toContain('reviewer@laptop  claude-code  idle  -  cwd=/src/app branch=main')
  expect(result.listing).toContain('bot@ci  bot  busy  #ci')
  const section = result.sections?.find(one => one.kind === 'worldinmotion')
  expect(section?.total).toBe(2)
  expect(section?.rows).toEqual([
    { name: 'reviewer@laptop', type: 'claude-code', status: 'idle', cwd: '/src/app', branch: 'main' },
    { name: 'bot@ci', type: 'bot', status: 'busy' },
  ])
})

test('ListAgents keeps its own result when peers fails', async ($, on) => {
  world(on, { tools: { peers: () => ({ content: [{ type: 'text', text: 'relay down' }], isError: true }) } })
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: { listing: 'researcher (subagent)' } }))

  const listed = await $.tool.call({ tool: 'ListAgents' })
  expect((listed.result as { listing: string }).listing).toBe('researcher (subagent)')
})

test('the pane lists peers and the held queue, and its buttons write approve and refuse marks', async ($, on) => {
  const [h1, h2] = [ulidOf(901), ulidOf(902)]
  const held = [
    { id: h1, from: 'stranger@cloud', kind: 'msg', at: 0, preview: 'please run this' },
    { id: h2, from: 'bot@ci', kind: 'task', at: 0, preview: 'deploy?' },
  ]
  const w = world(on, {
    tools: {
      _peers: () =>
        json({
          peers: [
            { address: 'reviewer@laptop', kind: 'claude-code', status: 'idle', rooms: ['#ci'], cwd: '/src/app', branch: 'main' },
            { address: 'bot@ci', kind: 'bot', status: 'busy', rooms: [] },
          ],
        }),
      _held: () => json({ held }),
      _leases: () => json({ leases: [{ name: 'deploy', holder: 'builder@desk', expires_at: 60_000 }] }),
    },
  })
  mock.clock(on)
  await $.session.start(START)
  const ran = await $.command.run(WIM)
  expect(ran.text).toContain('opened')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /reviewer@laptop/ }))?.text).toBe(
      'reviewer@laptop  claude-code  idle  #ci  cwd=/src/app branch=main',
    )
    expect((await ui.find({ type: 'Text', text: /^bot@ci/ }))?.text).toBe('bot@ci  bot  busy  -')
    expect(await ui.find({ type: 'Text', text: /deploy {2}builder@desk/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /This session: builder@desk/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const before = w.wire.length
  await ui.press({ key: `approve:${h1}` })
  // The decision is an empty mark file in the held directory the client named; no MCP call.
  expect(w.files.get(`${HELD_DIR}/${h1}.approve`)).toBe('')
  expect(w.wire.length).toBe(before)
  expect(await ui.find({ key: `approve:${h1}` })).toBeUndefined()
  expect(await ui.find({ key: `refuse:${h2}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(`Message ${h1} marked approved`) })).toBeDefined()

  await ui.press({ key: `refuse:${h2}` })
  expect(w.files.get(`${HELD_DIR}/${h2}.refuse`)).toBe('')
  expect([...w.files.keys()].filter(path => path.startsWith(`${HELD_DIR}/`))).toHaveLength(2)
  expect(w.wire.length).toBe(before)
  expect(await ui.find({ type: 'Text', text: /Held for your approval \(0\)/ })).toBeDefined()
  await ui.unmount()
})

test('a held id that is not a ULID, or a client that names no held directory, writes no mark', async ($, on) => {
  let hello: Record<string, unknown> = { spool: SPOOL, sid: 's1', address: 'builder@desk', token: TOKEN, held: HELD_DIR }
  const w = world(on, {
    tools: {
      _hello: () => json(hello),
      _peers: () => json({ peers: [] }),
      _held: () => json({ held: [{ id: '../../../../.bashrc', from: 'stranger@cloud', kind: 'msg', at: 0, preview: 'x' }, { id: ulidOf(903), from: 'a@b', kind: 'msg', at: 0, preview: 'y' }] }),
      _leases: () => json({ leases: [] }),
    },
  })
  mock.clock(on)
  await $.session.start(START)
  await $.command.run(WIM)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'approve:../../../../.bashrc' })
  expect(await ui.find({ type: 'Text', text: /Could not mark \.\.\/\.\.\/\.\.\/\.\.\/\.bashrc approved\./ })).toBeDefined()
  await ui.unmount()

  // An older client, or one whose `hello` named a relative directory: nothing to write under.
  for (const dir of [undefined, 'held']) {
    hello = { spool: SPOOL, sid: 's1', address: 'builder@desk', token: TOKEN, ...(dir === undefined ? {} : { held: dir }) }
    await $.session.start(START)
    await $.command.run(WIM)
    const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await again.press({ key: `refuse:${ulidOf(903)}` })
    expect(await again.find({ type: 'Text', text: new RegExp(`Could not mark ${ulidOf(903)} refused\\.`) })).toBeDefined()
    await again.unmount()
  }
  expect([...w.files.keys()].some(path => /\.(approve|refuse)$/.test(path))).toBe(false)
})

test('a mark that cannot be written is reported, not claimed', async ($, on) => {
  world(on, {
    tools: { _peers: () => json({ peers: [] }), _held: () => json({ held: [{ id: ulidOf(904), from: 'a@b', kind: 'msg', at: 0, preview: 'y' }] }), _leases: () => json({ leases: [] }) },
    isWriteDenied: path => path.startsWith(`${HELD_DIR}/`),
  })
  mock.clock(on)
  await $.session.start(START)
  await $.command.run(WIM)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `approve:${ulidOf(904)}` })
  expect(await ui.find({ type: 'Text', text: new RegExp(`Could not mark ${ulidOf(904)} approved\\.`) })).toBeDefined()
  expect(await ui.find({ key: `approve:${ulidOf(904)}` })).toBeDefined()
  await ui.unmount()
})

test('the pane says why the tab is not linked', async ($, on) => {
  world(on, { tools: { _hello: () => ({ content: [{ type: 'text', text: NOT_SET_UP }], isError: true }) } })
  mock.clock(on)
  await $.session.start(START)
  await $.command.run(WIM)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Not linked/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /wim init/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /npm install --global worldinmotion/ })).toBeDefined()
  await ui.unmount()
})

test('the pane says when the client is not running', async ($, on) => {
  world(on, { connected: false })
  mock.clock(on)
  await $.session.start(START)
  await $.command.run(WIM)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /The plugin's client \(its MCP server\) is not running: not connected\./ })).toBeDefined()
  await ui.unmount()
})

test('a relayed item never starts a turn: it waits in the pane until the person hands it over', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  w.files.set(...item(4, 'pipeline 812 failed', { relayed: true, from: 'ci@build' }))
  await clock.advance(250)
  await clock.settle()

  expect(w.submitted).toHaveLength(0)
  expect(w.toasts).toEqual(['worldinmotion: 1 relayed item in the inbox (/wim)'])
  expect(w.files.get(`${SPOOL}/cursor`)).toBe('000000000004.json')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /pipeline 812 failed/ })).toBeDefined()
  await ui.press({ key: 'deliver:000000000004.json' })
  await clock.settle()
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toContain('pipeline 812 failed')
  expect(await ui.find({ key: 'deliver:000000000004.json' })).toBeUndefined()
  // Handing it over also dismisses it, with a mark file in the directory the client named.
  const dismissals = () => [...w.files.keys()].filter(path => path.startsWith(`${DISMISS_DIR}/`))
  expect(dismissals()).toEqual([`${DISMISS_DIR}/${ulidOf(4)}.dismiss`])
  expect(w.wire.some(call => (call.args as { op?: string }).op === 'dismiss')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /pipeline 812 failed {2}\(shown\)/ })).toBeDefined()
  await ui.press({ key: 'dismiss:000000000004.json' })
  expect(await ui.find({ type: 'Text', text: /pipeline 812 failed {2}\(shown\)/ })).toBeUndefined()
  expect(await ui.find({ key: 'dismiss:000000000004.json' })).toBeUndefined()
  // Handed over already: the client was told once.
  expect(dismissals()).toHaveLength(1)
  await ui.unmount()
})

test('a relayed item is appended while busy and never re-submitted at the turn end', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const session = mock.session(on)
  await $.session.start(START)
  await $.turn.start({ text: 'work', turnId: 't1' })
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 3 })
  for await (const _ of step) void _

  w.files.set(...item(5, 'deploy done', { relayed: true }))
  await clock.advance(250)
  await clock.settle()
  expect(JSON.stringify(session.appended()[0]?.message.content)).toContain('deploy done')
  expect(w.toasts).toHaveLength(0)

  await $.turn.complete(COMPLETE)
  await clock.settle()
  expect(w.submitted).toHaveLength(0)
})

test('the pane asks _peers forPane; ListAgents asks _peers without it', async ($, on) => {
  const w = world(on, { tools: { _peers: () => json({ peers: [] }), _held: () => json({ held: [] }), _leases: () => json({ leases: [] }) } })
  mock.clock(on)
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: { listing: 'none' } }))
  await $.session.start(START)
  await $.command.run(WIM)
  await $.tool.call({ tool: 'ListAgents' })

  const peerCalls = w.calls.filter(call => call.tool === '_peers').map(call => call.args)
  expect(peerCalls).toEqual([{ forPane: true, token: TOKEN }, { token: TOKEN }])
})

const ENGINE_REFUSAL = 'to must be a bare teammate name'

/** The engine's SendMessage beneath the plugin: it refuses name@device, as 2.1.310 does. */
function engineSendMessage(on: On): string[] {
  const reached: string[] = []
  on('tool.call', { tool: 'SendMessage' }, (_, e) => {
    reached.push(String(e.to))
    return String(e.to).includes('@')
      ? { isError: true, result: ENGINE_REFUSAL, text: ENGINE_REFUSAL }
      : { result: { success: true, message: 'sent' } }
  })
  return reached
}

const SENT = (to: string, status = 'routed') =>
  json({ id: '01JAAAAAAAAAAAAAAAAAAAAAAA', results: [{ to, status }] })

test('SendMessage to a mesh address is taken by the bridge before the engine refuses it', async ($, on) => {
  const w = world(on, { tools: { send: () => SENT('bob@laptop-b') } })
  const reached = engineSendMessage(on)
  mock.clock(on)
  await $.session.start(START)

  const ran = await $.tool.call({ tool: 'SendMessage', to: 'bob@laptop-b', message: 'ready for review', notify_when_idle: true })
  expect(ran.isError).toBeUndefined()
  expect(ran.result).toEqual({
    success: true,
    message:
      'Sent through worldinmotion (bob@laptop-b: routed). routed: handed to a live session; queued: that session is offline and the relay keeps it 24 h. Neither means delivered or read, so say "sent".',
  })
  expect(ran.text).toMatch(/^Sent through worldinmotion/)
  expect(ran.text).not.toMatch(/Delivered/)
  expect(reached).toHaveLength(0)
  expect(w.calls).toContainEqual({ tool: '_route', args: { to: 'bob@laptop-b', token: TOKEN } })
  expect(w.calls).toContainEqual({
    tool: 'send',
    args: { to: 'bob@laptop-b', text: 'ready for review', notify_when_idle: true },
  })

  const room = await $.tool.call({ tool: 'SendMessage', to: '#ci', message: 'green' })
  expect((room.result as { success: boolean }).success).toBe(true)
})

test('SendMessage to a local name passes to the engine untouched', async ($, on) => {
  const w = world(on)
  const reached = engineSendMessage(on)

  const ran = await $.tool.call({ tool: 'SendMessage', to: 'researcher', message: 'hi' })
  expect(ran.result).toEqual({ success: true, message: 'sent' })
  expect(reached).toEqual(['researcher'])
  expect(w.calls).toHaveLength(0)
})

test('SendMessage leaves an address to the engine when _route says it is not the mesh', async ($, on) => {
  const w = world(on, { tools: { _route: () => json({ mesh: false, policy: null }) } })
  const reached = engineSendMessage(on)
  mock.clock(on)
  await $.session.start(START)
  w.calls.length = 0

  const ran = await $.tool.call({ tool: 'SendMessage', to: 'stranger@nowhere', message: 'x' })
  expect(ran.isError).toBe(true)
  expect(ran.text).toBe(ENGINE_REFUSAL)
  expect(reached).toEqual(['stranger@nowhere'])
  expect(w.calls.map(call => call.tool)).toEqual(['_route'])
})

test('SendMessage names each status when a recipient is not reached', async ($, on) => {
  world(on, {
    tools: {
      send: () =>
        json({
          id: '01JAAAAAAAAAAAAAAAAAAAAAAA',
          results: [
            { to: 'reviewer@laptop', status: 'routed' },
            { to: 'ghost@nowhere', status: 'unknown' },
          ],
        }),
    },
  })
  engineSendMessage(on)
  // The handshake issues the token every internal op needs.
  mock.clock(on)
  await $.session.start(START)

  const ran = await $.tool.call({ tool: 'SendMessage', to: 'reviewer@laptop', message: 'x' })
  expect(ran.isError).toBe(true)
  const result = ran.result as { success: boolean; error: string }
  expect(result.success).toBe(false)
  expect(result.error).toBe('worldinmotion: not sent (reviewer@laptop: routed, ghost@nowhere: unknown).')
  expect(ran.text).toBe(result.error)
})

test('SendMessage reports a refused send', async ($, on) => {
  world(on, {
    tools: { send: () => ({ content: [{ type: 'text', text: 'refused: matches aws_access_key_id' }], isError: true }) },
  })
  engineSendMessage(on)
  // The handshake issues the token every internal op needs.
  mock.clock(on)
  await $.session.start(START)

  const ran = await $.tool.call({ tool: 'SendMessage', to: 'reviewer@laptop', message: 'x' })
  expect(ran.isError).toBe(true)
  expect((ran.result as { error: string }).error).toContain('aws_access_key_id')
})

test('SendMessage never bridges a name that was a local teammate earlier in the session', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const reached = engineSendMessage(on)
  await $.session.start(START)
  w.agents = [{ id: 'a1', name: 'reviewer', teammateId: 'reviewer@laptop' }]
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.turn.complete(COMPLETE)
  await clock.settle()

  // The teammate has gone, but its address stays local for the session.
  w.agents = []
  await $.tool.call({ tool: 'SendMessage', to: 'reviewer@laptop', message: 'x' })
  expect(reached).toEqual(['reviewer@laptop'])
  expect(w.calls.some(call => call.tool === 'send' || call.tool === '_route')).toBe(false)
})

test('SendMessage asks the person before sending to a device not on deliver', async ($, on) => {
  const w = world(on, {
    tools: { _route: () => json({ mesh: true, policy: 'hold' }), send: () => SENT('stranger@cloud', 'queued') },
  })
  engineSendMessage(on)
  // The handshake issues the token every internal op needs.
  mock.clock(on)
  await $.session.start(START)

  w.answer = 'Do not send'
  const refused = await $.tool.call({ tool: 'SendMessage', to: 'stranger@cloud', message: 'the plan' })
  expect(refused.isError).toBe(true)
  expect((refused.result as { error: string }).error).toContain('did not confirm')
  expect(w.asked[0]).toContain('stranger@cloud')
  expect(w.asked[0]).toContain('hold')
  expect(w.calls.some(call => call.tool === 'send')).toBe(false)

  w.answer = 'Send'
  const sent = await $.tool.call({ tool: 'SendMessage', to: 'stranger@cloud', message: 'the plan' })
  expect((sent.result as { success: boolean }).success).toBe(true)
  expect(w.asked).toHaveLength(2)
  expect(w.calls).toContainEqual({ tool: 'send', args: { to: 'stranger@cloud', text: 'the plan' } })
})

test('SendMessage to a trusted device or a room asks nothing', async ($, on) => {
  const w = world(on, { tools: { send: () => SENT('x') } })
  engineSendMessage(on)
  // The handshake issues the token every internal op needs.
  mock.clock(on)
  await $.session.start(START)

  await $.tool.call({ tool: 'SendMessage', to: 'reviewer@laptop', message: 'x' })
  await $.tool.call({ tool: 'SendMessage', to: '#ci', message: 'x' })
  expect(w.asked).toHaveLength(0)
  expect(w.calls.filter(call => call.tool === 'send')).toHaveLength(2)
})

test("another plugin's $.session.send takes the same route", async ($, on) => {
  const w = world(on, { tools: { send: () => SENT('bob@laptop-b') } })
  const seen: string[] = []
  on('session.send', (_, e) => {
    seen.push(e.to)
    return { isDelivered: true }
  })
  // The handshake issues the token every internal op needs.
  mock.clock(on)
  await $.session.start(START)

  // A trusted device, and still the person is asked: another plugin is sending.
  const sent = await $.session.send({ to: 'bob@laptop-b', text: 'hello', origin: { kind: 'plugin', name: 'other' } })
  expect(sent).toEqual({ isDelivered: true })
  expect(w.asked).toHaveLength(1)
  expect(w.asked[0]).toContain('the plugin other is sending it')
  expect(seen).toHaveLength(0)
  expect(w.calls).toContainEqual({ tool: 'send', args: { to: 'bob@laptop-b', text: 'hello' } })

  w.answer = 'Do not send'
  const declined = await $.session.send({ to: '#ci', text: 'hello', origin: { kind: 'plugin', name: 'other' } })
  expect(declined.isDelivered).toBe(false)
  expect(w.calls.filter(call => call.tool === 'send')).toHaveLength(1)

  const local = await $.session.send({ to: 'local-name', text: 'hello', origin: { kind: 'plugin', name: 'other' } })
  expect(local.isDelivered).toBe(true)
  expect(seen).toEqual(['local-name'])
})

test('presence is busy-mesh for a turn the plugin started with a mesh item, busy for the person', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  w.files.set(...item(1, 'please run the tests'))
  await clock.advance(250)
  await clock.settle()
  expect(w.submitted).toHaveLength(1)
  const presence = () => w.files.get(`${SESSION}/presence`)
  expect(presence()).toBe('idle')

  await $.turn.start({ text: w.submitted[0] ?? '', turnId: 't1' })
  expect(presence()).toBe('busy-mesh')
  await $.turn.complete(COMPLETE)
  await clock.settle()
  expect(presence()).toBe('idle')

  // The person's own next turn: nothing of the plugin's is pending.
  await $.turn.start({ text: 'my own prompt', turnId: 't2' })
  expect(presence()).toBe('busy')
  await $.turn.complete({ ...COMPLETE, turnId: 't2' })
})

test('a dropped mesh submit leaves no mesh turn pending', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { drop: 'blocked' })
  await $.session.start(START)
  w.files.set(...item(1, 'x'))
  await clock.advance(250)
  await clock.settle()

  await $.turn.start({ text: 'my own prompt', turnId: 't1' })
  expect(w.files.get(`${SESSION}/presence`)).toBe('busy')
})

test('a room send is confirmed unless _route says deliver', async ($, on) => {
  const w = world(on, {
    tools: { _route: () => json({ mesh: true, policy: 'hold' }), send: () => SENT('#ci') },
  })
  engineSendMessage(on)
  // The handshake issues the token every internal op needs.
  mock.clock(on)
  await $.session.start(START)

  const ran = await $.tool.call({ tool: 'SendMessage', to: '#ci', message: 'build is green' })
  expect((ran.result as { success: boolean }).success).toBe(true)
  expect(w.asked).toHaveLength(1)
  expect(w.asked[0]).toContain('not every device in this room is one you trust')
})

test('the confirmation shows a short message whole and a long one in outline', async ($, on) => {
  const w = world(on, {
    tools: { _route: () => json({ mesh: true, policy: 'hold' }), send: () => SENT('stranger@cloud') },
  })
  engineSendMessage(on)
  // The handshake issues the token every internal op needs.
  mock.clock(on)
  await $.session.start(START)

  const short = 'line one\nline two'
  await $.tool.call({ tool: 'SendMessage', to: 'stranger@cloud', message: short })
  expect(w.asked[0]).toContain(`Message to stranger@cloud:\n${short}`)
  expect(w.asked[0]).toEndWith('?')

  const long = ['opening line', ...Array.from({ length: 40 }, (_, i) => `middle ${i} ${'x'.repeat(20)}`), 'closing line'].join('\n')
  expect(long.length).toBeGreaterThan(600)
  await $.tool.call({ tool: 'SendMessage', to: 'stranger@cloud', message: long })
  const outline = w.asked[1] ?? ''
  expect(outline).toContain(`${long.length} characters, 42 lines.`)
  expect(outline).toContain('First line: opening line')
  expect(outline).toContain('Last line: closing line')
  expect(outline).not.toContain('middle 5')
})

test('internal tools are described in a few words and kept behind ToolSearch', async ($, on) => {
  on('tool.describe', (_, e) => ({ description: e.description }))
  const provider = { plugin: 'mcp:worldinmotion', tier: 'user' } as const

  const internal = await $.tool.describe({ tool: `${TOOL}_held`, description: 'Lists held messages with a long schema.', provider })
  expect(internal).toEqual({ description: 'Internal to the worldinmotion plugin. Do not call.', isDeferred: true })

  const pub = await $.tool.describe({ tool: `${TOOL}send`, description: 'Sends a message.', provider })
  expect(pub.description).toBe('Sends a message.')
  expect(pub.isDeferred).toBeUndefined()
})

test('every plugin-only call goes through _internal with op, args and the token', async ($, on) => {
  const w = world(on, {
    tools: { _peers: () => json({ peers: [] }), _held: () => json({ held: [] }), _leases: () => json({ leases: [] }) },
  })
  mock.clock(on)
  await $.session.start(START)
  await $.command.run(WIM)

  expect(w.wire[0]).toEqual({ tool: '_internal', args: { op: 'hello', args: { claudeSessionId: 'claude-session-1' } } })
  expect(w.wire).toContainEqual({ tool: '_internal', args: { op: 'peers', args: { forPane: true }, token: TOKEN } })
  expect(w.wire).toContainEqual({ tool: '_internal', args: { op: 'held', args: {}, token: TOKEN } })
  expect(w.wire).toContainEqual({ tool: '_internal', args: { op: 'leases', args: {}, token: TOKEN } })
  expect(w.wire.every(call => call.tool === '_internal' || !call.tool.startsWith('_'))).toBe(true)

  // A reload runs the handshake again: the repeat hello carries the token.
  await $.session.start(START)
  expect(w.wire.filter(call => (call.args as { op?: string }).op === 'hello').at(-1)).toEqual({
    tool: '_internal',
    args: { op: 'hello', args: { claudeSessionId: 'claude-session-1' }, token: TOKEN },
  })
})

test('the model gets no op of _internal; the plugin gets every one', async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  for (const op of ['peers', 'held', 'leases', 'route', 'approve', 'refuse', 'dismiss', 'relayed', 'hello']) {
    const model = await $.tool.check({ tool: `${TOOL}_internal`, input: { op, args: {} }, tool_use_id: 'toolu_01xyz' })
    expect(model.decision, op).toBe('deny')
    const plugin = await $.tool.check({ tool: `${TOOL}_internal`, input: { op, args: {} }, tool_use_id: 'toolu_plugin_9' })
    expect(plugin.decision, op).toBe('allow')
  }
})
