// Errors shared by modules that cannot import each other.

/** Raised for a problem the person has to fix (a missing setup, unsafe permissions). */
export class SetupError extends Error {
  override readonly name = "SetupError";
}

/**
 * A set-up problem that clears without a new session, so `wim mcp` keeps trying: the device is set
 * up but its signer cannot act now (none is running, or it is locked), or the device has no keys
 * or no mesh yet (the person is setting it up in a terminal).
 */
export class NotReadyYet extends SetupError {}
