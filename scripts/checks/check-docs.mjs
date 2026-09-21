import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import process from "node:process";

import GithubSlugger from "github-slugger";

const root = resolve(import.meta.dirname, "../..");
const docsRoot = join(root, "docs");

const required = [
  "README.md",
  "architecture.md",
  "decisions.md",
  "contracts.md",
  "contracts/api.md",
  "contracts/api/openapi.yaml",
  "database.md",
  "development.md",
  "operations.md",
  "operations/runbooks.md",
  "security.md",
  "testing.md",
  "reference.md",
  "project/plan.md",
  "project/progress.md",
  "project/readiness.md",
  "design/product-spec.md",
  "design/source-package.md",
  "design/research/import-experience.md",
  "design/research/slim-runtime-and-queue-removal.md",
  "design/source/IntentTrace_Design_Package.zip",
  "design/source/manifest.sha256",
  "design/prototype/intenttrace_ui_prototype.html",
  "design/prototype/intenttrace_ui_preview.png",
  "assets/trace-list.png",
  "assets/workbench.png",
];

const failures = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await walk(path)));
    else paths.push(path);
  }
  return paths;
}

// GitHub renders heading anchors with github-slugger, so the real slugger is the
// only honest oracle here: CJK headings keep their characters while full-width
// punctuation such as `：` is deleted rather than turned into a separator.
const headingSlugs = new Map();

async function slugsFor(path) {
  const cached = headingSlugs.get(path);
  if (cached) return cached;
  const slugger = new GithubSlugger();
  const slugs = new Set();
  let fenced = false;
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    if (/^\s*(?:```|~~~)/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    const heading = fenced ? null : /^#{1,6}\s+(.*?)\s*$/u.exec(line);
    if (heading)
      slugs.add(
        slugger.slug(
          heading[1]
            .replace(/`([^`]*)`/gu, "$1")
            .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
            .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/gu, "$1"),
        ),
      );
  }
  headingSlugs.set(path, slugs);
  return slugs;
}

async function checkInternalLinks(content, path) {
  const label = relative(root, path);
  for (const link of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const raw = link[1].trim().replace(/^<|>$/gu, "");
    if (/^(?:https?:|mailto:)/u.test(raw)) continue;
    const [target, fragment] = raw.split("#");
    const destination = target ? resolve(dirname(path), decodeURIComponent(target)) : path;
    try {
      await stat(destination);
    } catch {
      failures.push(`${label}: broken internal link ${raw}`);
      continue;
    }
    if (!fragment || extname(destination) !== ".md") continue;
    if (!(await slugsFor(destination)).has(decodeURIComponent(fragment)))
      failures.push(`${label}: broken anchor ${raw}`);
  }
}

for (const entry of required) {
  try {
    const info = await stat(join(docsRoot, entry));
    if (!info.isFile() || info.size === 0) failures.push(`Missing substantive file: docs/${entry}`);
  } catch {
    failures.push(`Missing required file: docs/${entry}`);
  }
}

const decisions = await readFile(join(docsRoot, "decisions.md"), "utf8");
const adrSections = [...decisions.matchAll(/^## ADR (\d{4})[:：]/gmu)].map((match) => match[1]);
const expectedAdrSections = Array.from({ length: 14 }, (_, index) =>
  String(index + 1).padStart(4, "0"),
);
if (adrSections.join(",") !== expectedAdrSections.join(","))
  failures.push(
    `docs/decisions.md must contain ADR sections ${expectedAdrSections[0]}-${expectedAdrSections.at(-1)} in order, found [${adrSections.join(",")}]`,
  );

if (!/^## ADR index$/mu.test(decisions))
  failures.push("docs/decisions.md must keep its `## ADR index` section");

const allFiles = await walk(docsRoot);
const normativeMarkdown = allFiles.filter(
  (path) =>
    extname(path) === ".md" &&
    !path.startsWith(join(docsRoot, "design", "source") + sep) &&
    !path.startsWith(join(docsRoot, "design", "prototype") + sep),
);
const frontmatterFields = ["status", "owner", "last_reviewed", "normative", "milestone"];

for (const path of normativeMarkdown) {
  const content = await readFile(path, "utf8");
  const label = relative(root, path);
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(content);
  if (!match) {
    failures.push(`${label}: missing YAML frontmatter`);
    continue;
  }
  for (const field of frontmatterFields) {
    if (!new RegExp(`^${field}:\\s*\\S+`, "mu").test(match[1]))
      failures.push(`${label}: missing ${field}`);
  }
  if (content.slice(match[0].length).trim().length < 120)
    failures.push(`${label}: content is too short`);

  await checkInternalLinks(content, path);
}

// The front-door READMEs are gated for link resolution only. Frontmatter and
// length are a docs/ convention, but a dead link in a README is the most visible
// failure this repository can ship, and docs/-only walking is how one shipped.
for (const name of ["README.md", "README.zh-CN.md"]) {
  const path = join(root, name);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) throw new Error("not a substantive file");
  } catch {
    failures.push(`Missing required file: ${name}`);
    continue;
  }
  await checkInternalLinks(await readFile(path, "utf8"), path);
}

const archivePath = join(docsRoot, "design", "source", "IntentTrace_Design_Package.zip");
const archiveHash = createHash("sha256")
  .update(await readFile(archivePath))
  .digest("hex");
const expectedArchiveHash = "947efe8970e2cf29b8bf1334da927d1b888364b1480d81f4687b0e0deb0c580d";
if (archiveHash !== expectedArchiveHash)
  failures.push(`Design archive hash mismatch: ${archiveHash}`);

const sourceRoot = join(docsRoot, "design", "source");
const manifest = await readFile(join(sourceRoot, "manifest.sha256"), "utf8");
for (const line of manifest.trim().split("\n")) {
  const match = /^([a-f0-9]{64})[ ]{2}(.+)$/u.exec(line);
  if (!match) {
    failures.push(`Invalid source manifest line: ${line}`);
    continue;
  }
  const bytes = await readFile(join(sourceRoot, match[2]));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== match[1]) failures.push(`Source hash mismatch: ${match[2]}`);
}

const configuration = await readFile(join(docsRoot, "reference.md"), "utf8");
const configSource = await readFile(join(root, "packages", "config", "src", "index.ts"), "utf8");
for (const key of configSource.matchAll(/^[ ]{4}([A-Z][A-Z0-9_]+):/gmu)) {
  if (!configuration.includes(`\`${key[1]}\``))
    failures.push(`Configuration reference missing ${key[1]}`);
}

const imageLock = await readFile(join(root, "infra", "images.lock"), "utf8");
const lockedImages = imageLock
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));
if (
  lockedImages.length !== 2 ||
  lockedImages.some((line) => !/@sha256:[a-f0-9]{64}$/u.test(line))
) {
  failures.push("infra/images.lock must contain exactly two digest-pinned images");
}
const imageConsumers = await Promise.all([
  readFile(join(root, "infra", "Dockerfile"), "utf8"),
  readFile(join(root, "docker-compose.yml"), "utf8"),
  readFile(join(root, ".github", "workflows", "ci.yml"), "utf8"),
]);
for (const image of lockedImages) {
  if (!imageConsumers.some((consumer) => consumer.includes(image))) {
    failures.push(`Locked image is not consumed: ${image}`);
  }
}

const baselineVersions = [
  ["package.json", "devDependencies", "typescript", "6.0.3"],
  ["apps/web/package.json", "dependencies", "next", "16.3.0"],
  ["apps/web/package.json", "dependencies", "react", "19.2.8"],
  ["apps/web/package.json", "dependencies", "@xyflow/react", "12.11.2"],
  ["apps/api/package.json", "dependencies", "fastify", "5.11.2"],
  ["packages/schema/package.json", "dependencies", "zod", "4.4.3"],
  ["packages/db/package.json", "dependencies", "drizzle-orm", "0.45.2"],
  ["packages/graph-layout/package.json", "dependencies", "elkjs", "0.12.0"],
];
for (const [manifestPath, section, name, expectedVersion] of baselineVersions) {
  const packageManifest = JSON.parse(await readFile(join(root, manifestPath), "utf8"));
  if (packageManifest[section]?.[name] !== expectedVersion) {
    failures.push(`${manifestPath}: expected ${name}@${expectedVersion}`);
  }
}
if ((await readFile(join(root, ".node-version"), "utf8")).trim() !== "24.18.1") {
  failures.push(".node-version must be 24.18.1");
}

const expectedLicenseHash = "0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0";
const licenseBytes = await readFile(join(root, "LICENSE"));
const licenseHash = createHash("sha256").update(licenseBytes).digest("hex");
if (licenseHash !== expectedLicenseHash) {
  failures.push(`LICENSE must be the verified GNU AGPLv3 text: ${licenseHash}`);
}
if (!licenseBytes.toString("utf8").includes("13. Remote Network Interaction")) {
  failures.push("LICENSE is missing GNU AGPLv3 section 13");
}

const communityFiles = [
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  ".github/CODEOWNERS",
  ".github/CODE_OF_CONDUCT.md",
  ".github/CONTRIBUTING.md",
  ".github/SECURITY.md",
  ".github/SUPPORT.md",
  ".github/dependabot.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/pull_request_template.md",
];
for (const path of communityFiles) {
  const absolutePath = join(root, path);
  try {
    const info = await stat(absolutePath);
    if (!info.isFile() || info.size < 100)
      failures.push(`Missing substantive community file: ${path}`);
    if (extname(absolutePath) === ".md") {
      await checkInternalLinks(await readFile(absolutePath, "utf8"), absolutePath);
    }
  } catch {
    failures.push(`Missing community file: ${path}`);
  }
}

const packageManifests = [
  "package.json",
  ...(await readdir(join(root, "apps"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => `apps/${entry.name}/package.json`),
  ...(await readdir(join(root, "packages"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/package.json`),
];
for (const manifestPath of packageManifests) {
  const manifest = JSON.parse(await readFile(join(root, manifestPath), "utf8"));
  if (manifest.license !== "AGPL-3.0-only") {
    failures.push(`${manifestPath}: license must be AGPL-3.0-only`);
  }
}
const cargoManifest = await readFile(
  join(root, "apps", "desktop", "src-tauri", "Cargo.toml"),
  "utf8",
);
if (!/^license = "AGPL-3.0-only"$/mu.test(cargoManifest)) {
  failures.push("apps/desktop/src-tauri/Cargo.toml: license must be AGPL-3.0-only");
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Documentation checks passed (${normativeMarkdown.length} normative Markdown files).\n`,
  );
}
