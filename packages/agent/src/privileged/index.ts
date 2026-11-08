// The privileged side of `wim agent`: the runner the peer calls through sudo, its config, the
// loopback auth proxy and its in-memory sign-in, the sender check on the signed frame, and the job.

export { ANTHROPIC_AUDIENCE, ConfigError, loadPrivilegedConfig, ownerProblem, parsePrivilegedConfig, PRIVILEGED_CONFIG_PATH, PRIVILEGED_RUNNER_PATH, READ_ONLY_TOOLS, sudoersLine, type ReadRule, type SecureRead, type Auth, type Identity, type PrivilegedConfig, type Profile } from "./config.ts";
export { AUTH_TIMEOUT_MS, loadAnthropicCredentials, OAUTH_BETA, upstreamAuth, within, type AnthropicCredentials, type AuthDeps, type TokenSource } from "./auth.ts";
export { FrameError, parseRecipient, pinMatches, SEEN_WINDOW_MS, verifyFrame, type PinnedSender, type RecipientKeys, type Verified } from "./frame.ts";
export { PROXY_PATHS, startProxy, type ProxyOptions, type RunningProxy, type UpstreamAuth, type UpstreamFetch } from "./proxy.ts";
export { awsWebIdentityToken, fetchIdentityToken, IDENTITY_TIMEOUT_MS, IdentityError, type IdentityDeps } from "./identity.ts";
export { MAX_ANSWER_BYTES, MAX_API_BODY_BYTES, privilegedMain, type JobHandle, type JobSpec, type Lock, type PrivilegedDeps } from "./main.ts";
export { chooseProfile, EXIT, LOCAL_DEVICE, MAX_REQUEST_BYTES, parseRequest, Refusal, usableCode } from "./request.ts";
export { acquireLock, ancestorsAllRoot, codeProblem, FLOCK_BUSY, lookupUser, memAvailableMb, readAll, secureDir, secureRead, secureWrite, startJob, systemDeps } from "./system.ts";
export { loadSdkQuery, sdkOptions, workerMain, type JobOptions, type Query, type WorkerIO } from "./worker.ts";
