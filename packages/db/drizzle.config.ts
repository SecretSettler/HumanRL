import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ?? "postgres://intenttrace:intenttrace@127.0.0.1:5432/intenttrace",
  },
  strict: true,
  verbose: true,
});
