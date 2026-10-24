/**
 * WebSocket close codes on a wim/1 connection (SPEC section 8). 1000 to 1015 are the standard
 * codes of RFC 6455; 4000 to 4999 are application codes.
 */
export const CLOSE = {
  /** Either side: a normal close, such as after `bye` or when a client stops. */
  bye: 1000,
  /** Relay: the mesh expired, or the connection sent nothing for too long. */
  goingAway: 1001,
  /** Relay: the client sent a binary frame. */
  textOnly: 1003,
  /** Relay: a recovery connection's roster was published (section 4a). */
  recovered: 4000,
  /** Relay: the connection did not authenticate in time (10 seconds, or a joiner's invite expired). */
  authTimeout: 4001,
  /** Client only: the relay did not answer a `ping`. A relay never sends it. */
  pingTimeout: 4002,
  /** Relay: authentication was refused. */
  unauthorized: 4003,
  /** Relay: this device was revoked from the roster. */
  revoked: 4004,
  /** Relay: a frame was malformed or too large. */
  protocol: 4008,
  /** Relay: a newer connection took over this session or this join. */
  replaced: 4009,
  /** Relay: a rate or count limit was hit. */
  limited: 4029,
} as const;
