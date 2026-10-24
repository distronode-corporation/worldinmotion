#!/usr/bin/env node
import { main } from "./cli.ts";
import { processIo } from "./io.ts";
process.exit(await main(process.argv.slice(2), process.env, processIo(process)));
