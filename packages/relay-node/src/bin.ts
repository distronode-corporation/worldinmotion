#!/usr/bin/env node

// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

// The wim-relay command: read the environment, start, and close cleanly on a signal.
import { configFromEnv } from "./config.ts";
import { runUntilSignal, start } from "./server.ts";

runUntilSignal(await start(configFromEnv(process.env, process.argv.slice(2))), process);
