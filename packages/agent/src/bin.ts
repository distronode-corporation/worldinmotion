#!/usr/bin/env node
// `wim-agent-runner`: the built-in runner as a process. SIGTERM stops the job (exit 5).
import { runnerMain } from "./sdk-runner.ts";
const ac = new AbortController();
process.once("SIGTERM", () => ac.abort());
const io = { stdin: process.stdin, stdout: (text: string) => void process.stdout.write(text), stderr: (line: string) => void process.stderr.write(`${line}\n`) };
process.exitCode = await runnerMain(process.argv.slice(2), { ...io, env: process.env, cwd: process.cwd(), signal: ac.signal });
