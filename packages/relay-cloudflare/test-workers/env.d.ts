// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import type { Env as RelayEnv } from "../src/config.ts";

declare global {
  namespace Cloudflare {
    // `env` from cloudflare:test and cloudflare:workers carries the Worker's bindings.
    interface Env extends RelayEnv {}
  }
}
