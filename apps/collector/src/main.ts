#!/usr/bin/env node
import { formatCollectorFatalError, runCollector } from "./cli.js";

try {
  process.exitCode = await runCollector(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`intenttrace: ${formatCollectorFatalError(error)}\n`);
  process.exitCode = 2;
}
