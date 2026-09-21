import { spawnSync } from "node:child_process";
import process from "node:process";

const result = spawnSync(
  "docker",
  ["compose", "-f", "docker-compose.yml", "config", "--format", "json"],
  {
    encoding: "utf8",
    env: { ...process.env, INTENTTRACE_WEB_PORT: "" },
  },
);

if (result.error) {
  process.stderr.write(`Unable to run Docker Compose: ${result.error.message}\n`);
  process.exit(1);
}
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const config = JSON.parse(result.stdout);
const failures = [];

for (const serviceName of ["api", "postgres", "worker", "migrate"]) {
  if ((config.services?.[serviceName]?.ports ?? []).length > 0) {
    failures.push(`${serviceName} must not publish a host port`);
  }
}

const webPorts = config.services?.web?.ports ?? [];
if (webPorts.length !== 1)
  failures.push(`web must publish exactly one port, found ${webPorts.length}`);
const webPort = webPorts[0];
if (webPort?.host_ip !== "127.0.0.1") failures.push("web host port must bind 127.0.0.1");
if (webPort?.target !== 3000) failures.push("web host port must target container port 3000");
if (webPort?.published !== undefined) {
  failures.push("web host port must be dynamically allocated when INTENTTRACE_WEB_PORT is unset");
}
const expectedNetworkName = `${config.name}_default`;
if (config.networks?.default?.name !== expectedNetworkName) {
  failures.push(`default Compose network must be project-scoped as ${expectedNetworkName}`);
}
if (config.networks?.default?.external === true) {
  failures.push("default Compose network must not reuse an external network");
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  "Compose topology check passed: one dynamic loopback Web port; all other services are internal on a project-scoped network.\n",
);
