import { lookupTopologyCapability } from "../../packages/adapters/src/index.js";
import { loadRuntimeConfig } from "../../packages/config/src/index.js";
import { IntentTraceRepository } from "../../packages/db/src/index.js";
import { UuidSchema } from "../../packages/schema/src/index.js";
import postgres from "../../packages/db/node_modules/postgres/src/index.js";

function usage(): never {
  throw new Error("Usage: pnpm topology:rebuild -- --trace <uuid> | --all");
}

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const traceIndex = args.indexOf("--trace");
const all = args.includes("--all");
if (traceIndex >= 0 === all) usage();
if (
  args.some(
    (argument) =>
      argument !== "--all" && argument !== "--trace" && argument !== args[traceIndex + 1],
  )
)
  usage();

const config = loadRuntimeConfig();
const sql = postgres(config.DATABASE_URL, { max: 1 });
const repository = new IntentTraceRepository(sql, { lookupTopologyCapability });
try {
  const traceIds = all
    ? await repository.listAllTraceIds()
    : [UuidSchema.parse(args[traceIndex + 1])];
  let rebuilt = 0;
  let unchanged = 0;
  for (const traceId of traceIds) {
    const revisionId = await repository.rederiveTopology(traceId);
    if (revisionId) {
      rebuilt += 1;
      process.stdout.write(`${traceId}: rebuilt ${revisionId}\n`);
    } else {
      unchanged += 1;
      process.stdout.write(`${traceId}: unchanged\n`);
    }
  }
  process.stdout.write(`Topology rebuild complete: ${rebuilt} rebuilt, ${unchanged} unchanged.\n`);
} finally {
  await sql.end();
}
