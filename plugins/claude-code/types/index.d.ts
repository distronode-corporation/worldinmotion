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
  /**
   * The device's keys are in the signer: a mark is no decision then (the client refuses it), so
   * the pane's buttons say where to decide instead.
   */
  isSigned?: boolean
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
 * A spool item whose turn the engine dropped (a Stop stands, a hook refused
 * it): the session never read it, so the cursor stays before it and no
 * `delivered` receipt goes. A turn end hands it over again.
 */
export type WimKept = {
  name: string
  /** The message's id: one entry an item, so a retry never hands it over twice. */
  id: string
  text: string
  /** What the pane's Recent list shows once it is handed over. */
  item: WimItem
  /** True while a turn end's submit of it is under way: no other takes it, no pass moves the cursor past it. */
  isSending: boolean
}

/**
 * An item that never starts a turn: one a bot, CI or gateway relayed for a
 * device, or a quiet notice (`isQuiet`). The pane lists it, and the person may
 * hand it to the session.
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
  /**
   * A notice the client spooled `quiet` (an idle notice that may not wake, a lapsed watch, a
   * refused arm): listed apart from relayed items. Absent on a value stored before it existed,
   * which was a relayed item.
   */
  isQuiet?: true
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
  /** Held by the loop breaker (not by policy): the pane also offers to resume its device. */
  isBreaker: boolean
  /** The set it is decided with (one per sending device or CI rule); an older client's item is a set of its own. */
  set: string
  /** Who that set is from. */
  setTitle: string
  /** A CI notice: what its job claimed. */
  ci?: string
  /** A CI notice whose approval pins its rule's ids: those ids. It is approved only on its own, in a terminal. */
  pins?: string
}

/** Held items decided together, oldest first; `ids` has each message once. */
export type WimHeldSet = { key: string; title: string; items: WimHeld[]; first: number; last: number }

/** A loop breaker pause the client reports: who tripped it, the rule with its numbers, and how it ends. */
export type WimPaused = { from: string; why: string; ends: string }

export type WimLease = { name: string; holder: string; expiresAt: number }

/** What the pane draws besides the delivered items. */
export type WimPanel = {
  peers: WimPeer[]
  held: WimHeld[]
  paused: WimPaused[]
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
      /** Mesh items submitted whose turn has not started yet, with when each was submitted. */
      pendingSubmits: Shaped<{ text: string; at: number }[]>
      /** When the last main-loop turn ended. */
      idleSince: number
      late: Shaped<WimLate[]>
      /** Spool items whose turn was dropped, waiting for a turn end to hand them over. */
      kept: Shaped<WimKept[]>
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
