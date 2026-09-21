import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { document as generatedDocument } from "../scripts/openapi-document.js";

describe("generated OpenAPI", () => {
  it("contains only implemented routes, including raw and semantic MVP contracts", async () => {
    const app = buildApp();
    await app.ready();
    const document = app.swagger();
    expect(Object.keys(document.paths ?? {}).sort()).toEqual([
      "/api/v1/events",
      "/api/v1/imports/candidates",
      "/api/v1/imports/sessions",
      "/api/v1/traces",
      "/api/v1/traces/{traceId}",
      "/api/v1/traces/{traceId}/artifacts/{artifactId}",
      "/api/v1/traces/{traceId}/events",
      "/api/v1/traces/{traceId}/graph",
      "/api/v1/traces/{traceId}/nodes/{nodeId}",
      "/api/v1/traces/{traceId}/provider-calls",
      "/api/v1/traces/{traceId}/revisions",
      "/api/v1/traces/{traceId}/snapshot",
      "/api/v1/traces/{traceId}/stream",
      "/healthz",
      "/metrics",
      "/readyz",
      "/v1/traces",
      "/version",
    ]);
    const candidates = generatedDocument.paths["/api/v1/imports/candidates"]?.post?.requestBody as
      { content: Record<string, unknown> } | undefined;
    const sessions = generatedDocument.paths["/api/v1/imports/sessions"]?.post?.requestBody as
      { content: Record<string, unknown> } | undefined;
    expect(Object.keys(candidates?.content ?? {})).toEqual([
      "application/json",
      "application/vnd.intenttrace.session-bundle",
    ]);
    expect(Object.keys(sessions?.content ?? {})).toEqual([
      "application/vnd.intenttrace.session-bundle",
    ]);
    await app.close();
  });
});
