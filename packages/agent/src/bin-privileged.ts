#!/usr/bin/env node
// wim-agent-privileged-runner: the runner the peer calls through one sudoers line, no arguments.
import { privilegedMain, systemDeps } from "./privileged.ts";

process.exitCode = await privilegedMain(process.argv.slice(2), process.env, [process.execPath, process.argv[1]!], systemDeps());
