// The privileged side of `wim worker`: the runner the peer calls through sudo, its config, the
// Workload Identity Federation token broker, and the job it runs as the worker user.

export { ANTHROPIC_AUDIENCE, ConfigError, loadPrivilegedConfig, parsePrivilegedConfig, PRIVILEGED_CONFIG_PATH, PRIVILEGED_RUNNER_PATH, READ_ONLY_TOOLS, rootOwnedProblem, sudoersLine, type Auth, type Identity, type PrivilegedConfig, type Profile } from "./config.ts";
export { REFRESH_MS, TokenBroker, type BrokerFs, type BrokerOptions } from "./broker.ts";
export { awsWebIdentityToken, fetchIdentityToken, IdentityError, type IdentityDeps } from "./identity.ts";
export { MAX_ANSWER_BYTES, privilegedMain, type JobHandle, type JobSpec, type Lock, type PrivilegedDeps } from "./main.ts";
export { chooseProfile, EXIT, LOCAL_DEVICE, MAX_REQUEST_BYTES, parseRequest, Refusal, usableCode } from "./request.ts";
export { acquireLock, FLOCK_BUSY, lookupUser, memAvailableMb, readAll, startJob, systemDeps } from "./system.ts";
export { loadSdkQuery, sdkOptions, workerMain, type JobOptions, type Query, type WorkerIO } from "./worker.ts";
