import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function runCompose(arguments_, capture = false) {
  const result = spawnSync("docker", ["compose", "-f", "docker-compose.yml", ...arguments_], {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) {
    process.stderr.write(`Unable to run Docker Compose: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return capture ? result.stdout.trim() : "";
}

function showUrl() {
  const binding = runCompose(["port", "web", "3000"], true);
  const match = /^127\.0\.0\.1:(\d+)$/u.exec(binding);
  if (!match) {
    process.stderr.write(
      "Web container is not running or its loopback port could not be discovered. Run `pnpm docker:up` first.\n",
    );
    process.exit(1);
  }

  const origin = `http://127.0.0.1:${match[1]}`;
  process.stdout.write(`IntentTrace Web: ${origin}\n`);
  process.stdout.write(`Health: ${origin}/healthz\n`);
  process.stdout.write(`API status proxy: ${origin}/api/status\n`);
  process.stdout.write("Internal only: api:3001, postgres:5432\n");
}

const command = process.argv[2] ?? "help";

switch (command) {
  case "up":
    runCompose(["up", "-d", "--build", "--wait", "--remove-orphans"]);
    showUrl();
    break;
  case "url":
    showUrl();
    break;
  case "status":
    runCompose(["ps"]);
    break;
  case "down":
    runCompose(["down"]);
    break;
  case "help":
  case "--help":
  case "-h":
    process.stdout.write(
      [
        "Usage: pnpm docker:<up|url|status|down>",
        "",
        "The default stack publishes only Web on an automatically allocated loopback port.",
        "Set INTENTTRACE_WEB_PORT explicitly only when a stable host port is required.",
        "",
      ].join("\n"),
    );
    break;
  default:
    process.stderr.write(`Unknown docker-stack command: ${command}\n`);
    process.exit(2);
}
