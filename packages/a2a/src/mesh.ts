/**
 * What the gateway needs from a worldinmotion mesh connection. The real implementation comes
 * from `@worldinmotion/client`; tests use a fake.
 */

import type { ResultStatus } from "@worldinmotion/protocol";

export type { ResultStatus };

export interface MeshPeer {
  /** `session@device`. */
  address: string;
  /** The session kind, such as `claude-code`, `bot` or `a2a`. */
  kind: string;
  /** `idle`, `busy` or `offline`. */
  status: string;
}

export interface MeshResult {
  /** The id of the task this answers. */
  reply_to: string;
  status: ResultStatus;
  text: string;
  /** The address that sent the result. */
  from: string;
}

export interface MeshTask {
  id: string;
  /** The address the task was sent to. */
  to: string;
  from: string;
  text: string;
  /** Integer milliseconds since the Unix epoch. */
  deadline?: number;
}

/** A plain `msg`, for peers that can deliver them. */
export interface MeshMessage {
  id: string;
  to: string;
  from: string;
  text: string;
}

export interface MeshPort {
  peers(): Promise<MeshPeer[]>;
  /** Sends a `task`. Returns its message id, which the `result` names in `reply_to`. */
  sendTask(to: string, text: string, opts: { deadline?: number }): Promise<{ id: string }>;
  onResult(cb: (r: MeshResult) => void): void;
  onTask(cb: (t: MeshTask) => void): void;
  sendResult(to: string, taskId: string, status: ResultStatus, text: string): Promise<void>;
  /**
   * Optional: plain messages addressed to the gateway's sessions. A message to an external agent
   * is relayed like a task with no deadline, and answered with a `result` naming it.
   */
  onMessage?(cb: (m: MeshMessage) => void): void;
}
