import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRuntimeConfig } from "@intenttrace/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const config = loadRuntimeConfig();
const client = postgres(config.DATABASE_URL, { max: 1 });
const database = drizzle(client);
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

try {
  await migrate(database, { migrationsFolder });
  console.log(`IntentTrace migrations applied from ${migrationsFolder}`);
} finally {
  await client.end();
}
