import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyServerOptions } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { z } from "zod";

import { createUnavailableApiServices, type ApiServices } from "./services.js";
import { registerTraceRoutes } from "./trace-routes.js";

export interface ReadinessResult {
  ready: boolean;
  postgres: "ok" | "error" | "skipped";
}

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  readiness?: () => Promise<ReadinessResult>;
  version?: string;
  gitCommit?: string;
  services?: ApiServices;
  uploadMaxBytes?: number;
}

const HealthSchema = z
  .object({ service: z.literal("api"), status: z.literal("ok"), gate: z.literal(5) })
  .strict();
const ReadySchema = z
  .object({
    service: z.literal("api"),
    status: z.enum(["ready", "degraded"]),
    dependencies: z.object({ postgres: z.string() }).strict(),
  })
  .strict();
const VersionSchema = z
  .object({
    service: z.literal("api"),
    version: z.string(),
    gitCommit: z.string(),
    schemaVersion: z.literal("1.0.0"),
  })
  .strict();

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? false,
    genReqId: () => randomUUID(),
    bodyLimit: 16 * 1024 * 1024,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const uploadMaxBytes = options.uploadMaxBytes ?? 64 * 1024 * 1024;
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: uploadMaxBytes },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.addContentTypeParser(
    "application/vnd.intenttrace.session-bundle",
    { parseAs: "buffer", bodyLimit: uploadMaxBytes },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.addHook("preParsing", async (request, _reply, payload) => {
    if (request.headers["content-encoding"] !== "gzip") return payload;
    request.headers["content-encoding"] = "identity";
    delete request.headers["content-length"];
    return payload.pipe(createGunzip());
  });
  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      void reply.status(400).send({
        type: "https://intenttrace.local/problems/validation",
        title: "Request validation failed",
        status: 400,
        code: "validation_failed",
        requestId: request.id,
      });
      return;
    }
    const failureCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "";
    if (failureCode === "FST_ERR_CTP_INVALID_JSON_BODY") {
      void reply.status(400).send({
        type: "https://intenttrace.local/problems/validation",
        title: "Request validation failed",
        status: 400,
        code: "validation_failed",
        requestId: request.id,
      });
      return;
    }
    if (failureCode === "FST_ERR_CTP_BODY_TOO_LARGE") {
      void reply.status(413).send({
        type: "https://intenttrace.local/problems/payload-too-large",
        title: "Payload too large",
        status: 413,
        code: "payload_too_large",
        requestId: request.id,
      });
      return;
    }
    if (failureCode === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      void reply.status(415).send({
        type: "https://intenttrace.local/problems/unsupported-media-type",
        title: "Unsupported media type",
        status: 415,
        code: "unsupported_media_type",
        requestId: request.id,
      });
      return;
    }
    request.log.error({ err: error }, "request failed");
    void reply.status(500).send({
      type: "https://intenttrace.local/problems/internal",
      title: "Internal server error",
      status: 500,
      code: "internal_error",
      requestId: request.id,
    });
  });

  void app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "IntentTrace API",
        description: "Implemented local IntentTrace MVP routes; planned APIs are not exposed.",
        version: options.version ?? "0.0.0",
      },
      servers: [{ url: "http://127.0.0.1:3001", description: "loopback development" }],
    },
    transform: jsonSchemaTransform,
  });
  void app.register(swaggerUi, { routePrefix: "/documentation" });

  void app.register(async function implementedRoutes(routes) {
    const startedAt = Date.now();
    routes.get(
      "/healthz",
      {
        schema: {
          operationId: "getHealth",
          summary: "Process liveness",
          response: { 200: HealthSchema },
        },
      },
      async () => ({ service: "api" as const, status: "ok" as const, gate: 5 as const }),
    );

    routes.get(
      "/metrics",
      {
        schema: { operationId: "getMetrics", summary: "Minimal Prometheus process metrics" },
      },
      async (_request, reply) =>
        reply
          .type("text/plain; version=0.0.4; charset=utf-8")
          .send(
            `# HELP intenttrace_api_up API process liveness\n# TYPE intenttrace_api_up gauge\nintenttrace_api_up 1\n# HELP intenttrace_api_uptime_seconds Process uptime\n# TYPE intenttrace_api_uptime_seconds counter\nintenttrace_api_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}\n`,
          ),
    );

    routes.get(
      "/readyz",
      {
        schema: {
          operationId: "getReadiness",
          summary: "PostgreSQL readiness",
          response: { 200: ReadySchema, 503: ReadySchema },
        },
      },
      async (_request, reply) => {
        const result = await (options.readiness?.() ??
          Promise.resolve({
            ready: true,
            postgres: "skipped" as const,
          }));
        if (!result.ready) reply.status(503);
        return {
          service: "api" as const,
          status: result.ready ? ("ready" as const) : ("degraded" as const),
          dependencies: { postgres: result.postgres },
        };
      },
    );

    routes.get(
      "/version",
      {
        schema: {
          operationId: "getVersion",
          summary: "Build and schema version",
          response: { 200: VersionSchema },
        },
      },
      async () => ({
        service: "api" as const,
        version: options.version ?? "0.0.0",
        gitCommit: options.gitCommit ?? "development",
        schemaVersion: "1.0.0" as const,
      }),
    );
  });

  void app.register(registerTraceRoutes, {
    services: options.services ?? createUnavailableApiServices(),
    uploadMaxBytes,
  });

  return app;
}
import { randomUUID } from "node:crypto";
import { createGunzip } from "node:zlib";
