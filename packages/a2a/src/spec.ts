import { z } from "zod";

/**
 * The parts of the Agent2Agent (A2A) protocol this gateway speaks, from specification v1.0.1
 * (protocol version "1.0"): https://github.com/a2aproject/A2A/blob/v1.0.1/docs/specification.md
 * and its normative proto, specification/a2a.proto. JSON uses camelCase field names and enum
 * values are their proto names (section 5.5).
 */

/** The `Major.Minor` protocol version sent in `A2A-Version` and declared in the agent card. */
export const A2A_VERSION = "1.0";

/** Section 8.2: the well-known agent card path. */
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

export const TASK_STATES = [
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

const TERMINAL: ReadonlySet<TaskState> = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);
const INTERRUPTED: ReadonlySet<TaskState> = new Set([
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_AUTH_REQUIRED",
]);

export function isTerminal(state: TaskState): boolean {
  return TERMINAL.has(state);
}

/** Input-required and auth-required pause a task until the client sends more. */
export function isInterrupted(state: TaskState): boolean {
  return INTERRUPTED.has(state);
}

/** Section 5.4: JSON-RPC codes for the A2A errors, and section 9.5 for the standard ones. */
export const ErrorCode = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotificationNotSupported: -32003,
  unsupportedOperation: -32004,
  contentTypeNotSupported: -32005,
  invalidAgentResponse: -32006,
  extendedAgentCardNotConfigured: -32007,
  versionNotSupported: -32009,
} as const;

/** An error a JSON-RPC method answers with. `message` is shown to the A2A client. */
export class A2AError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const metadata = z.record(z.string(), z.unknown());

/** A part has exactly one of `text`, `raw`, `url` or `data` (a proto oneof). */
export const PartSchema = z.looseObject({
  text: z.string().optional(),
  raw: z.string().optional(),
  url: z.string().optional(),
  data: z.unknown().optional(),
  metadata: metadata.optional(),
  filename: z.string().optional(),
  mediaType: z.string().optional(),
});
export type Part = z.infer<typeof PartSchema>;

export const RoleSchema = z.enum(["ROLE_USER", "ROLE_AGENT"]);

export const MessageSchema = z.looseObject({
  messageId: z.string().min(1),
  contextId: z.string().optional(),
  taskId: z.string().optional(),
  role: RoleSchema,
  parts: z.array(PartSchema).min(1),
  metadata: metadata.optional(),
  extensions: z.array(z.string()).optional(),
  referenceTaskIds: z.array(z.string()).optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const TaskStatusSchema = z.looseObject({
  state: z.enum(TASK_STATES),
  message: MessageSchema.optional(),
  timestamp: z.string().optional(),
});
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const ArtifactSchema = z.looseObject({
  artifactId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  parts: z.array(PartSchema),
  metadata: metadata.optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const TaskSchema = z.looseObject({
  id: z.string().min(1),
  contextId: z.string().optional(),
  status: TaskStatusSchema,
  artifacts: z.array(ArtifactSchema).optional(),
  history: z.array(MessageSchema).optional(),
  metadata: metadata.optional(),
});
export type Task = z.infer<typeof TaskSchema>;

/** `SendMessageResponse` is a oneof: a task, or a direct message. */
export const SendMessageResponseSchema = z
  .looseObject({ task: TaskSchema.optional(), message: MessageSchema.optional() })
  .refine((r) => (r.task === undefined) !== (r.message === undefined), "exactly one of task or message");

export const AgentInterfaceSchema = z.looseObject({
  url: z.string(),
  protocolBinding: z.string(),
  tenant: z.string().optional(),
  protocolVersion: z.string(),
});
export type AgentInterface = z.infer<typeof AgentInterfaceSchema>;

export const AgentSkillSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  examples: z.array(z.string()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
});

/** The agent card's required fields (proto `AgentCard`); unknown fields are kept and ignored. */
export const AgentCardSchema = z.looseObject({
  name: z.string(),
  description: z.string(),
  supportedInterfaces: z.array(AgentInterfaceSchema).min(1),
  version: z.string(),
  capabilities: z.looseObject({
    streaming: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
    extendedAgentCard: z.boolean().optional(),
  }),
  defaultInputModes: z.array(z.string()).min(1),
  defaultOutputModes: z.array(z.string()).min(1),
  skills: z.array(AgentSkillSchema),
});
export type AgentCard = z.infer<typeof AgentCardSchema>;

export const SendMessageRequestSchema = z.looseObject({
  tenant: z.string().optional(),
  message: MessageSchema,
  configuration: z
    .looseObject({
      acceptedOutputModes: z.array(z.string()).optional(),
      taskPushNotificationConfig: z.unknown().optional(),
      historyLength: z.number().int().nonnegative().optional(),
      returnImmediately: z.boolean().optional(),
    })
    .optional(),
  metadata: metadata.optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const GetTaskRequestSchema = z.looseObject({
  tenant: z.string().optional(),
  id: z.string().min(1),
  historyLength: z.number().int().nonnegative().optional(),
});

export const CancelTaskRequestSchema = z.looseObject({
  tenant: z.string().optional(),
  id: z.string().min(1),
  metadata: metadata.optional(),
});

export const ListTasksRequestSchema = z.looseObject({
  tenant: z.string().optional(),
  contextId: z.string().optional(),
  status: z.enum(TASK_STATES).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
  historyLength: z.number().int().nonnegative().optional(),
  statusTimestampAfter: z.iso.datetime().optional(),
  includeArtifacts: z.boolean().optional(),
});

const rpcId = z.union([z.string(), z.number(), z.null()]);

export const RpcRequestSchema = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});

/** A response carries `error`, or else its `result` (kept as an unknown extra key). */
export const RpcResponseSchema = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: rpcId,
  error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
});

/** The text of every text part, joined by blank lines. Other parts are counted, not shown. */
export function textOf(parts: readonly Part[]): { text: string; other: number } {
  const texts: string[] = [];
  let other = 0;
  for (const p of parts) {
    if (typeof p.text === "string") texts.push(p.text);
    else other += 1;
  }
  return { text: texts.join("\n\n"), other };
}
