import { resolve } from "node:path";

import { z } from "zod";

const BooleanStringSchema = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

export const RuntimeConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    APP_VERSION: z.string().min(1).default("0.0.0"),
    GIT_COMMIT: z.string().min(1).default("development"),
    API_HOST: z.string().min(1).default("127.0.0.1"),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    DATABASE_URL: z
      .string()
      .url()
      .default("postgres://intenttrace:intenttrace@127.0.0.1:15432/intenttrace"),
    ARTIFACT_ROOT: z
      .string()
      .min(1)
      .default(".intenttrace/artifacts")
      .transform((value) => resolve(value)),
    IMPORT_UPLOAD_MAX_BYTES: z.coerce.number().int().min(65536).max(536870912).default(67108864),
    PROVIDER_MODE: z.enum(["mock", "openai", "deepseek"]).default("mock"),
    PROVIDER_EGRESS_ENABLED: BooleanStringSchema,
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_MODEL: z.string().min(1).optional(),
    OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
    DEEPSEEK_API_KEY: z.string().min(1).optional(),
    DEEPSEEK_MODEL: z.string().min(1).optional(),
    DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
    PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
    PROVIDER_MAX_EVENTS: z.coerce.number().int().min(1).max(4096).default(256),
    PROVIDER_DAILY_BUDGET_USD: z.coerce.number().min(0).max(10_000).default(0),
  })
  .superRefine((value, context) => {
    if (value.PROVIDER_MODE === "mock") return;
    if (!value.PROVIDER_EGRESS_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["PROVIDER_EGRESS_ENABLED"],
        message: "cloud provider requires explicit egress",
      });
    }
    if (value.PROVIDER_DAILY_BUDGET_USD <= 0) {
      context.addIssue({
        code: "custom",
        path: ["PROVIDER_DAILY_BUDGET_USD"],
        message: "cloud provider requires a positive budget",
      });
    }
    if (value.PROVIDER_MODE === "openai" && (!value.OPENAI_API_KEY || !value.OPENAI_MODEL)) {
      context.addIssue({
        code: "custom",
        path: ["OPENAI_API_KEY"],
        message: "OpenAI key and explicit model are required",
      });
    }
    if (
      value.PROVIDER_MODE === "openai" &&
      new URL(value.OPENAI_BASE_URL).hostname !== "api.openai.com"
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPENAI_BASE_URL"],
        message: "OpenAI egress host is not allowlisted",
      });
    }
    if (value.PROVIDER_MODE === "deepseek" && (!value.DEEPSEEK_API_KEY || !value.DEEPSEEK_MODEL)) {
      context.addIssue({
        code: "custom",
        path: ["DEEPSEEK_API_KEY"],
        message: "DeepSeek key and explicit model are required",
      });
    }
    if (
      value.PROVIDER_MODE === "deepseek" &&
      new URL(value.DEEPSEEK_BASE_URL).hostname !== "api.deepseek.com"
    ) {
      context.addIssue({
        code: "custom",
        path: ["DEEPSEEK_BASE_URL"],
        message: "DeepSeek egress host is not allowlisted",
      });
    }
  });

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = RuntimeConfigSchema.safeParse(environment);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.join(".") || "environment")
      .join(", ");
    throw new Error(`Invalid IntentTrace configuration: ${fields}`);
  }
  return parsed.data;
}
