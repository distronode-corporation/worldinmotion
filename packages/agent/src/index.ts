// @worldinmotion/agent: a worldinmotion peer that wakes on a message from an allowed device and
// runs one job through a runner command. The SDK runner is a separate entry ("./sdk-runner"), so
// importing this module never loads the Claude Agent SDK.

export { DEFAULT_PASS_ENV, loadConfig, PROFILE_NAME, type WorkerConfig } from "./config.ts";
export { codeMatches, parseProfile, stripCode, type ProfileParse } from "./gate.ts";
export { DailyLedger, RateLimit, utcDay } from "./limits.ts";
export {
  encodeRequest,
  RUNNER_EXIT,
  RUNNER_MAX_BYTES,
  RUNNER_MAX_REQUEST_BYTES,
  runJob,
  runnerEnv,
  signalGroup,
  truncateUtf8,
  type RunDeps,
  type RunnerOutcome,
  type RunnerRequest,
  type RunnerSpec,
} from "./runner.ts";
export {
  BUSY,
  DAILY_CAP,
  FAILED,
  NO_TASK,
  NOT_ACCEPTED,
  NOT_ACCEPTED_DERIVED,
  readCode,
  runWorker,
  TIMED_OUT,
  TRUNCATED_NOTE,
  Worker,
  type ReplyStatus,
  type RunWorkerDeps,
  type WorkerIO,
  type WorkerItem,
  type WorkerOptions,
} from "./worker.ts";
export { builtInRunner, METADATA_ADDRESSES, MIN_NODE, nodeSupported, PLACEHOLDER, placeholders, privilegedRunner, runDoctor, SUDOERS_PATH, type Check, type DoctorDeps, type DoctorInput, type FileStat, type PrivilegedView } from "./doctor.ts";
export { allowProblem, initNotes, LIMITS, PRIVILEGED_PEER_TIMEOUT, privilegedTemplate, workerTemplate, type AuthMode, type InitMode, type InitOptions } from "./init.ts";
export { exitFor, parseRequest, runOnce, type OnceIO } from "./once.ts";
export { lookupUser, probe, PROBE_SCRIPT, serviceNoNewPrivs, type NoNewPrivs, type ExecFile, type ProbeAnswer, type ProbeOp, type Spawn, type UserId } from "./probe.ts";
