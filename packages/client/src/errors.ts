// Errors shared by modules that cannot import each other.

/** Raised for a problem the person has to fix (a missing setup, unsafe permissions). */
export class SetupError extends Error {
  override readonly name = "SetupError";
}
