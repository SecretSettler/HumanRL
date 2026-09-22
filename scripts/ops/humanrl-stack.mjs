#!/usr/bin/env node
/**
 * The `humanrl` command.
 *
 *   humanrl                 start HumanRL if it is not running and open it
 *   humanrl codex [N]       import your newest N Codex sessions (default 1) and open the newest
 *   humanrl claude [N]      the same for Claude Code sessions
 *   humanrl import <path>   import a session file or directory (source guessed from the path)
 *   humanrl status          what is running, and the URL
 *   humanrl stop            stop everything `humanrl` started
 *
 * With Docker Compose available the whole stack runs in containers, exactly
 * as IntentTrace ships it. Without it (no compose plugin, or a Docker daemon
 * that is out of disk) the services run on the host: PostgreSQL from a
 * `docker run`, or a Homebrew `postgresql@17`, or an already reachable
 * DATABASE_URL. Logs, pids and the web origin live under `.intenttrace/`.
 */
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stateDir = join(root, ".intenttrace");
const logDir = join(stateDir, "logs");
const pidFile = join(stateDir, "humanrl.pids");
const pgFile = join(stateDir, "humanrl.postgres");
const originFile = join(stateDir, "humanrl.origin");
const SESSION_DIRS = {
  codex: join(process.env.HOME ?? "", ".codex", "sessions"),
  claude: join(process.env.HOME ?? "", ".claude", "projects"),
};
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

async function isUp(origin) {
  return globalThis
    .fetch(`${origin}/healthz`)
    .then((response) => response.ok)
    .catch(() => false);
}

function savedOrigin() {
  return existsSync(originFile) ? readFileSync(originFile, "utf8").trim() : WEB_ORIGIN;
}

async function demoUrl(origin) {
  const traces = await (await globalThis.fetch(`${origin}/api/v1/traces`)).json();
  const demo = traces.traces.find((trace) => /IMO 2025/u.test(trace.title)) ?? traces.traces[0];
  return demo ? `${origin}/traces/${demo.id}` : `${origin}/traces`;
}

function show(url) {
  process.stdout.write(`\n${url}\n\n`);
  if (process.env.HUMANRL_NO_OPEN !== "1") openBrowser(url);
}

/** Start the stack unless it is already answering; returns the web origin. */
async function ensureUp() {
  const origin = savedOrigin();
  if (await isUp(origin)) return origin;
  const useCompose = process.env.HUMANRL_HOST !== "1" && hasCompose();
  const started = useCompose ? upCompose() : await upHost();
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(originFile, `${started}\n`);
  log("Loading the recorded nine-lane IMO demo trace");
  pnpm(["demo:load"], { env: { ...env, INTENTTRACE_WEB_ORIGIN: started }, stdio: "ignore" });
  return started;
}

async function up() {
  const origin = await ensureUp();
  const url = await demoUrl(origin);
  process.stdout.write(
    `\nHumanRL is up. Next: \`humanrl codex\` or \`humanrl claude\` imports your latest session; \`humanrl stop\` shuts it down.\n`,
  );
  show(url);
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
  if (existsSync(originFile)) rmSync(originFile);
}

async function status() {
  const origin = savedOrigin();
  const web = await isUp(origin);
  process.stdout.write(`${web ? "running" : "stopped"} · ${origin}\n`);
  if (web) {
    const traces = await (await globalThis.fetch(`${origin}/api/v1/traces`)).json();
    for (const trace of traces.traces)
      process.stdout.write(
        `  ${trace.title.slice(0, 60).padEnd(60)}  ${origin}/traces/${trace.id}\n`,
      );
  }
}

function guessSource(path) {
  if (/[/\\]\.codex[/\\]|rollout-\d{4}-\d{2}-\d{2}T/u.test(path)) return "codex";
  if (/[/\\]\.claude[/\\]/u.test(path)) return "claude";
  if (/[/\\]\.local[/\\]share[/\\]opencode|opencode/iu.test(path)) return "opencode";
  return null;
}

function collector(args) {
  const result = spawnSync(
    "corepack",
    ["pnpm", "--silent", "--filter", "@intenttrace/collector", "dev", ...args],
    { cwd: root, env, encoding: "utf8" },
  );
  const records = [];
  for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // not one of ours
    }
  }
  return { status: result.status, records, raw: `${result.stdout}\n${result.stderr}` };
}

/**
 * Newest sessions first, as the collector's discovery ranks them. Sessions
 * over the collector's size limit are reported separately so `humanrl codex`
 * skips them instead of failing on a 500 MB transcript that is still open.
 */
function discover(source, path) {
  const { status, records, raw } = collector([
    "discover",
    "--source",
    source,
    "--path",
    path,
    "--limit",
    "50",
  ]);
  const catalog = records.find((record) => record.command === "discover" && record.sessions);
  if (status !== 0 || !catalog) {
    process.stderr.write(raw);
    fail(`could not list ${source} sessions under ${path}`);
  }
  return catalog;
}

/** Import chosen catalog ids and return the trace ids, in the order given. */
function collect(source, path, sessionIds) {
  const { status, records, raw } = collector([
    "import",
    "--source",
    source,
    "--path",
    path,
    "--api",
    savedOrigin(),
    ...sessionIds.flatMap((id) => ["--session", id]),
  ]);
  const traceIds = records
    .filter((record) => record.level === "result" && record.traceId)
    .map((record) => record.traceId);
  for (const record of records.filter((record) => record.level === "error"))
    process.stderr.write(`  ${record.code ?? "error"}: ${record.message}\n`);
  const summary = records.find((record) => record.level === "summary");
  if (summary)
    log(
      `${summary.imported} imported, ${summary.failed} failed, ${summary.inserted} events inserted, ${summary.duplicates} already known`,
    );
  if (status !== 0 && traceIds.length === 0) {
    process.stderr.write(raw);
    fail(`import failed (source ${source}, path ${path})`);
  }
  return traceIds;
}

/**
 * The directories that hold whole session bundles, newest first. The
 * collector keeps at most 50 candidates per root and picks them by path
 * before ordering by time, so handing it `~/.codex/sessions` with a summer's
 * worth of transcripts hides the newest ones. Codex bundles live in a day
 * directory, Claude Code bundles in a project directory (sidecars sit in
 * subdirectories next to the transcript), so those are the roots.
 */
function bundleRoots(source, path) {
  if (source !== "codex" && source !== "claude") return [path];
  // A Claude Code transcript is only recognised next to its sidecars, so a
  // single file is looked up through its directory and matched below.
  if (statSync(path).isFile()) return [source === "claude" ? dirname(path) : path];
  const roots = new Map();
  const skipDirs = new Set(["memory", "subagents", "tool-results", "node_modules"]);
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(child);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      if (source === "codex" && !entry.name.startsWith("rollout-")) continue;
      const mtime = statSync(child).mtimeMs;
      roots.set(directory, Math.max(roots.get(directory) ?? 0, mtime));
    }
  };
  walk(path);
  return [...roots.entries()].sort((a, b) => b[1] - a[1]).map(([directory]) => directory);
}

async function importSessions(source, path, count) {
  const origin = await ensureUp();
  if (!existsSync(path)) fail(`${path} does not exist`);
  log(`Looking for ${source} sessions under ${path}`);
  const file = statSync(path).isFile() ? statSync(path) : null;
  const isThatFile = (session) =>
    file === null ||
    session.byteLength === file.size ||
    Math.trunc(Date.parse(session.modifiedAt)) === Math.trunc(file.mtimeMs);
  const chosen = [];
  let tooLarge = 0;
  for (const rootDir of bundleRoots(source, path)) {
    if (chosen.length >= count) break;
    const catalog = discover(source, rootDir);
    tooLarge += catalog.failed.filter((item) => item.code === "file_too_large").length;
    for (const session of catalog.sessions.filter(isThatFile)) {
      if (chosen.length >= count) break;
      chosen.push({ ...session, rootDir });
    }
  }
  if (tooLarge > 0) {
    log(
      `Skipping ${tooLarge} session${tooLarge === 1 ? "" : "s"} over the collector's 64 MiB limit`,
    );
  }
  if (chosen.length === 0) fail(`no importable ${source} session under ${path}`);
  chosen.sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
  log(
    `Importing the newest ${chosen.length}: ${chosen
      .map((item) => `${item.eventCount} events, ${new Date(item.lastActivityAt).toLocaleString()}`)
      .join(" · ")}`,
  );
  const byRoot = new Map();
  for (const item of chosen)
    byRoot.set(item.rootDir, [...(byRoot.get(item.rootDir) ?? []), item.id]);
  const traceIds = [];
  for (const [rootDir, ids] of byRoot) traceIds.push(...collect(source, rootDir, ids));
  if (traceIds.length === 0) fail("nothing was imported");
  show(`${origin}/traces/${traceIds[0]}`);
}

function usage() {
  process.stdout.write(
    [
      "humanrl                  start HumanRL (if needed) and open the demo trace",
      "humanrl codex [N]        import your newest N Codex sessions (default 1) and open the newest",
      "humanrl claude [N]       the same for Claude Code sessions",
      "humanrl import <path>    import a session file or directory; add --source codex|claude|opencode|omp|grok if it cannot be guessed",
      "humanrl status           running or not, the URL, and the traces you have",
      "humanrl stop             stop everything humanrl started",
      "",
      `Session directories: codex ${SESSION_DIRS.codex} · claude ${SESSION_DIRS.claude}`,
      "",
    ].join("\n"),
  );
}

function countArg(value, fallback = 1) {
  const count = Number(value ?? fallback);
  if (!Number.isInteger(count) || count < 1) fail(`expected a positive number, got ${value}`);
  return count;
}

const [command = "up", ...rest] = process.argv.slice(2);
switch (command) {
  case "up":
  case "start":
  case "open":
    await up();
    break;
  case "codex":
  case "claude":
    await importSessions(
      command,
      process.env[`HUMANRL_${command.toUpperCase()}_DIR`] ?? SESSION_DIRS[command],
      countArg(rest[0]),
    );
    break;
  case "import": {
    const path = rest.find((arg) => !arg.startsWith("--") && !/^\d+$/u.test(arg));
    if (!path) fail("humanrl import <path> [N] [--source …]");
    const flagIndex = rest.indexOf("--source");
    const source = flagIndex >= 0 ? rest[flagIndex + 1] : guessSource(resolve(path));
    if (!source)
      fail(
        `cannot tell what kind of session ${path} is; add --source codex|claude|opencode|omp|grok`,
      );
    const count = countArg(
      rest.find((arg) => /^\d+$/u.test(arg)),
      1,
    );
    await importSessions(source, resolve(path), count);
    break;
  }
  case "status":
    await status();
    break;
  case "stop":
  case "down":
    down();
    break;
  default:
    usage();
}
