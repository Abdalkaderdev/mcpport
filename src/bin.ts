#!/usr/bin/env node
import { run } from "./cli.ts";

try {
  process.exitCode = run(process.argv.slice(2));
} catch (e) {
  console.error(`mcpport: ${(e as Error).message}`);
  process.exitCode = 2;
}
