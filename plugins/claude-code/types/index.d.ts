// The values the worldinmotion mod keeps in $.state. They outlive a hot reload
// of the module, so the spool path, the cursor and busy/idle survive one.

/** What the `hello` op of `_internal` answered for this session. */
export type WimLink = {
  spool: string
  sid: string
  address: string
  /** Proves to the client that an internal call comes from this session's plugin. */
  token?: string
  /** The session's held directory: the person's approve and refuse marks go here. */
  held?: string
  /** Where the person's dismiss marks for relayed items go. */
  dismiss?: string
}

/** One delivered spool item, as the pane lists it. */
export type WimItem = {
  name: string
  kind: string
  from: string
  line: string
  at: number
}

/**
 * An item appended while a request was already under way. Its text is in the
 * conversation once; at the turn's end the model is told it is there, by
 * sender and id, and the text is not repeated.
 */
export type WimLate = { name: string; from: string; id: string }

/**
 * An item a bot, CI or gateway relayed for a device. It never starts a turn:
 * the pane lists it, and the person may hand it to the session.
 */
export type WimRelayed = {
  name: string
  /** The item's id, which names its dismiss mark. */
  id: string
  from: string
  line: string
  at: number
  text: string
  /** True once appended into a running turn; false while only the pane has it. */
  isShown: boolean
  /** True once a dismiss mark told the client the person is done with it. */
  isDismissed: boolean
}

export type WimPeer = {
  address: string
  kind: string
  status: string
  rooms: string[]
  /** From the peer's encrypted card, when it shares one. */
  cwd?: string
  branch?: string
}

export type WimHeld = {
  id: string
  from: string
  kind: string
  at: number
  preview: string
}

export type WimLease = { name: string; holder: string; expiresAt: number }

/** What the pane draws besides the delivered items. */
export type WimPanel = {
  peers: WimPeer[]
  held: WimHeld[]
  leases: WimLease[]
  note: string
  waiting: number
  heldOnDisk: number
}

declare module 'claude-code' {
  interface PluginState {
    worldinmotion: {
      link: Shaped<WimLink | null>
      /** Why the tab is not linked, in the client's words; '' once it is. */
      problem: Shaped<string>
      /** Notices the client meant for the person, newest last. */
      alerts: Shaped<string[]>
      /** The status line last shown. */
      statusShown: Shaped<string>
      /** A handshake the client kept: the link file it writes once it can open a session. */
      pendingLink: Shaped<{ file: string; token: string } | null>
      /** The last token the client issued this tab. */
      issuedToken: Shaped<string>
      cursor: Shaped<string>
      busy: boolean
      /** The running main-loop turn was started by the plugin with a mesh item. */
      meshTurn: boolean
      /** Mesh items submitted whose turn has not started yet. */
      pendingSubmits: Shaped<string[]>
      late: Shaped<WimLate[]>
      /** Spool items a delivery pass claimed whose cursor has not moved past them yet. */
      handed: Shaped<string[]>
      recent: Shaped<WimItem[]>
      panel: Shaped<WimPanel>
      relayed: Shaped<WimRelayed[]>
      /** Every local teammate name or address seen this session: never bridged. */
      teammates: Shaped<string[]>
    }
  }
}
