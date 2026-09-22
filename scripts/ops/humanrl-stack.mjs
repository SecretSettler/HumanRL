#!/usr/bin/env node
/**
 * One command to a running HumanRL: `pnpm humanrl:up`.
 *
 *   up      start PostgreSQL, migrate, run api + worker + web, load the demo
 *           trace, print the URL and open it
 *   down    stop what `up` started
 *   status  show what is running and the URL
 *   import  import your own Codex or Claude sessions (see --help)
 *
 * With Docker Compose available the whole stack runs in containers, exactly
 * as IntentTrace ships it. Without it (no compose plugin, or a Docker daemon
 * that is out of disk) the services run on the host: PostgreSQL from a
 * `docker run`, or a Homebrew `postgresql@17`, or an already reachable
 * DATABASE_URL. Logs and pids live under `.intenttrace/`.
 */
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stateDir = join(root, ".intenttrace");
const logDir = join(stateDir, "logs");
const pidFile = join(stateDir, "humanrl.pids");
const pgFile = join(stateDir, "humanrl.postgres");
const WEB_PORT = Number(process.env.HUMANRL_WEB_PORT ?? 3000);
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const PG_CONTAINER = "humanrl-postgres";
const PG_PORT = 15432;

const env = {
  ...readEnvExample(),
  ...process.env,
  NEXT_TELEMETRY_DISABLED: "1",
  TURBO_TELEMETRY_DISABLED: "1",
};

function readEnvExample() {
  const out = {};
  for (const line of readFileSync(join(root, ".env.example"), "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
    if (match && match[2] !== "") out[match[1]] = match[2];
  }
  return out;
}

function log(message) {
  process.stdout.write(`\u001b[36m▸\u001b[0m ${message}\n`);
}

function fail(message) {
  process.stderr.write(`\u001b[31m✖\u001b[0m ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit", ...options });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed`);
}

function quiet(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function pnpm(args, options) {
  run("corepack", ["pnpm", ...args], options);
}

async function waitFor(url, label, seconds = 90) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  fail(`${label} did not come up within ${seconds}s (${url}); see ${logDir}`);
}

function openBrowser(url) {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawnSync(opener, [url], { stdio: "ignore" });
}

function hasCompose() {
  return quiet("docker", ["compose", "version"]) !== null;
}

function hasDocker() {
  return quiet("docker", ["info"]) !== null;
}

// ---------- PostgreSQL on the host path ----------

function pgReachable(url) {
  const probe = spawnSync(
    "node",
    [
      "-e",
      `import("postgres").then(async (m)=>{const sql=m.default(process.argv[1],{connect_timeout:3});await sql\`select 1\`;await sql.end();}).catch(()=>process.exit(1))`,
      url,
    ],
    { cwd: join(root, "packages/db"), env, encoding: "utf8" },
  );
  return probe.status === 0;
}

function brewPostgres() {
  const prefix = quiet("brew", ["--prefix", "postgresql@17"]);
  if (!prefix) return null;
  const bin = join(prefix, "bin");
  const data = join(quiet("brew", ["--prefix"]) ?? "/opt/homebrew", "var/postgresql@17");
  return existsSync(join(bin, "pg_ctl")) && existsSync(data) ? { bin, data } : null;
}

async function ensurePostgres() {
  const url = env.DATABASE_URL;
  if (pgReachable(url)) {
    log(`PostgreSQL already reachable at ${url.replace(/\/\/.*@/u, "//…@")}`);
    return;
  }
  if (hasDocker()) {
    log(`Starting PostgreSQL in Docker (${PG_CONTAINER} on 127.0.0.1:${PG_PORT})`);
    spawnSync("docker", ["rm", "-f", PG_CONTAINER], { stdio: "ignore" });
    const started = spawnSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        PG_CONTAINER,
        "-e",
        "POSTGRES_DB=intenttrace",
        "-e",
        "POSTGRES_USER=intenttrace",
        "-e",
        "POSTGRES_PASSWORD=intenttrace",
        "-p",
        `127.0.0.1:${PG_PORT}:5432`,
        "postgres:18",
      ],
      { encoding: "utf8" },
    );
    if (started.status === 0) {
      writeFileSync(pgFile, "docker\n");
      for (let attempt = 0; attempt < 30 && !pgReachable(url); attempt += 1) await sleep(1000);
      if (pgReachable(url)) return;
    }
    log("Docker could not provide PostgreSQL; trying Homebrew postgresql@17");
  }
  const brew = brewPostgres();
  if (brew) {
    log(`Starting Homebrew postgresql@17 on port ${PG_PORT}`);
    run(join(brew.bin, "pg_ctl"), [
      "-D",
      brew.data,
      "-l",
      join(logDir, "postgres.log"),
      "-o",
      `-p ${PG_PORT} -k /tmp`,
      "start",
    ]);
    writeFileSync(pgFile, `brew ${brew.bin} ${brew.data}\n`);
    const psql = join(brew.bin, "psql");
    spawnSync(
      psql,
      [
        "-h",
        "127.0.0.1",
        "-p",
        String(PG_PORT),
        "-d",
        "postgres",
        "-c",
        "CREATE ROLE intenttrace LOGIN PASSWORD 'intenttrace' SUPERUSER;",
      ],
      { stdio: "ignore" },
    );
    spawnSync(
      psql,
      [
        "-h",
        "127.0.0.1",
        "-p",
        String(PG_PORT),
        "-d",
        "postgres",
        "-c",
        "CREATE DATABASE intenttrace OWNER intenttrace;",
      ],
      { stdio: "ignore" },
    );
    if (pgReachable(url)) return;
  }
  fail(
    `No PostgreSQL. Either install Docker (with the compose plugin), or \`brew install postgresql@17\`, or start one yourself and export DATABASE_URL (currently ${url}).`,
  );
}

// ---------- host services ----------

function startService(name, args) {
  const out = openSync(join(logDir, `${name}.log`), "a");
  const child = spawn("corepack", ["pnpm", ...args], {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  return `${name}=${child.pid}`;
}

async function upHost() {
  mkdirSync(logDir, { recursive: true });
  mkdirSync(join(root, env.ARTIFACT_ROOT ?? ".intenttrace/artifacts"), { recursive: true });
  if (!existsSync(join(root, "node_modules"))) {
    log("Installing dependencies");
    pnpm(["install", "--frozen-lockfile"]);
  }
  await ensurePostgres();
  log("Building workspace packages");
  pnpm(["--filter", "./packages/*", "build"], { stdio: "ignore" });
  log("Applying database migrations");
  pnpm(["--filter", "@intenttrace/db", "migrate"], { stdio: "ignore" });
  log("Starting api, worker and web");
  const pids = [
    startService("api", ["--filter", "@intenttrace/api", "dev"]),
    startService("worker", ["--filter", "@intenttrace/worker", "dev"]),
    startService("web", [
      "--filter",
      "@intenttrace/web",
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(WEB_PORT),
    ]),
  ];
  writeFileSync(pidFile, `${pids.join("\n")}\n`);
  await waitFor(`http://127.0.0.1:${env.API_PORT ?? 3001}/readyz`, "API");
  await waitFor(`${WEB_ORIGIN}/healthz`, "Web");
  return WEB_ORIGIN;
}

function upCompose() {
  log("Docker Compose found; starting the containerised stack");
  pnpm(["docker:up"]);
  const origin = quiet("node", ["scripts/ops/docker-stack.mjs", "url"]);
  const match = /IntentTrace Web: (\S+)/u.exec(origin ?? "");
  if (!match) fail("could not read the web URL from docker-stack");
  return match[1];
}

async function up() {
  const useCompose = process.env.HUMANRL_HOST !== "1" && hasCompose();
  const origin = useCompose ? upCompose() : await upHost();
  log("Loading the recorded nine-lane IMO demo trace");
  pnpm(["demo:load"], { env: { ...env, INTENTTRACE_WEB_ORIGIN: origin } });
  const traces = await (await globalThis.fetch(`${origin}/api/v1/traces`)).json();
  const demo = traces.traces.find((trace) => /IMO 2025/u.test(trace.title)) ?? traces.traces[0];
  const url = demo ? `${origin}/traces/${demo.id}` : `${origin}/traces`;
  process.stdout.write(`\nHumanRL is up: ${url}\n`);
  process.stdout.write(
    `Import your own sessions: pnpm humanrl:import -- --source codex --path ~/.codex/sessions --newest --max-files 1\n`,
  );
  process.stdout.write(`Stop it: pnpm humanrl:down\n\n`);
  if (process.env.HUMANRL_NO_OPEN !== "1") openBrowser(url);
}

function down() {
  if (hasCompose() && quiet("docker", ["compose", "-f", "docker-compose.yml", "ps", "-q"])) {
    pnpm(["docker:down"]);
  }
  if (existsSync(pidFile)) {
    for (const line of readFileSync(pidFile, "utf8").split("\n")) {
      const [name, pid] = line.split("=");
      if (!pid) continue;
      try {
        process.kill(-Number(pid), "SIGTERM");
        log(`stopped ${name}`);
      } catch {
        try {
          process.kill(Number(pid), "SIGTERM");
          log(`stopped ${name}`);
        } catch {
          // already gone
        }
      }
    }
    rmSync(pidFile);
  }
  if (existsSync(pgFile)) {
    const [kind, bin, data] = readFileSync(pgFile, "utf8").trim().split(" ");
    if (kind === "docker") spawnSync("docker", ["rm", "-f", PG_CONTAINER], { stdio: "ignore" });
    if (kind === "brew") spawnSync(join(bin, "pg_ctl"), ["-D", data, "stop"], { stdio: "ignore" });
    log("stopped PostgreSQL");
    rmSync(pgFile);
  }
}

async function status() {
  const web = await globalThis
    .fetch(`${WEB_ORIGIN}/healthz`)
    .then((r) => r.ok)
    .catch(() => false);
  const api = await globalThis
    .fetch(`http://127.0.0.1:${env.API_PORT ?? 3001}/readyz`)
    .then((r) => r.ok)
    .catch(() => false);
  process.stdout.write(`web ${web ? "up" : "down"} at ${WEB_ORIGIN}\napi ${api ? "up" : "down"}\n`);
  if (existsSync(pidFile)) process.stdout.write(readFileSync(pidFile, "utf8"));
}

function importSessions(args) {
  if (args.includes("--help") || args.length === 0) {
    process.stdout.write(
      [
        "Usage: pnpm humanrl:import -- --source <codex|claude|opencode|omp|grok> --path <dir> [--newest --max-files N | --session <id>...]",
        "",
        "  --newest --max-files 1   import the most recently modified session under <dir>",
        "  --session ID             import a catalog id printed by `pnpm humanrl:import -- discover --source … --path …`",
        "",
        "Examples:",
        "  pnpm humanrl:import -- --source codex --path ~/.codex/sessions --newest --max-files 1",
        "  pnpm humanrl:import -- --source claude --path ~/.claude/projects --newest --max-files 3",
        "",
      ].join("\n"),
    );
    return;
  }
  if (args[0] === "discover") {
    pnpm(["--filter", "@intenttrace/collector", "dev", ...args]);
    return;
  }
  pnpm(["--filter", "@intenttrace/collector", "dev", "import", ...args, "--api", WEB_ORIGIN]);
  process.stdout.write(`\nOpen ${WEB_ORIGIN}/traces and pick the new trace.\n`);
}

const [command = "help", ...rest] = process.argv.slice(2);
switch (command) {
  case "up":
    await up();
    break;
  case "down":
    down();
    break;
  case "status":
    await status();
    break;
  case "import":
    importSessions(rest);
    break;
  default:
    process.stdout.write("Usage: pnpm humanrl:<up|down|status|import>\n");
}
