// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

// The activity webview's entry point, bundled to media/activity.js.

import { boot, type WebviewGlobals } from "./render.ts";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

boot(globalThis as unknown as WebviewGlobals, acquireVsCodeApi());
