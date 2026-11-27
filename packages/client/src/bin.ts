#!/usr/bin/env node

// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { main } from "./cli.ts";
import { processIo } from "./io.ts";
process.exit(await main(process.argv.slice(2), process.env, processIo(process)));
