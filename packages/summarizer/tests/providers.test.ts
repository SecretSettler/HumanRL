import { describe, expect, it } from "vitest";

import { SchemaVersion } from "@intenttrace/schema";

import {
  DeepSeekJsonSummaryProvider,
  FoundationMockSummaryProvider,
  OpenAIResponsesSummaryProvider,
  redactProviderText,
} from "../src/index.js";
import type { ProviderUnavailableError } from "../src/index.js";

const eventId = "019fbbb3-4324-7d43-8f9c-cd489a92cb28";
const revisionId = "019fbbb3-4324-7d43-8f9c-cd489a92cb29";
const nonce = "019fbbb3-4324-7d43-8f9c-cd489a92cb30";
const patch = {
  schemaVersion: SchemaVersion,
  jobNonce: nonce,
  baseRevisionId: revisionId,
  operations: [],
  diagnostics: ["raw only"],
};
const input = {
  jobNonce: nonce,
  baseRevisionId: revisionId,
  eventSketch: [`${eventId}|log|ok|agent|token=super-secret-value`],
  allowedEventIds: [eventId],
  allowedArtifactIds: [],
  allowedAgentIds: ["agent"],
  allowedNodeIds: [],
  locale: "zh-CN",
};

describe("provider safety boundary", () => {
  it("selects visible semantic content instead of trailing telemetry", async () => {
    const provider = new FoundationMockSummaryProvider();
    const artifactId = "019fbbb3-4324-7d43-8f9c-cd489a92cb31";
    const completionId = "019fbbb3-4324-7d43-8f9c-cd489a92cb32";
    const result = await provider.summarizeChunk({
      ...input,
      eventSketch: [
        JSON.stringify({
          eventId,
          kind: "assistant_message",
          status: "ok",
          agentId: "agent",
          name: "Assistant · Implemented durable session content extraction",
          contentType: "assistant_message",
          artifactIds: [artifactId],
        }),
        JSON.stringify({
          eventId: completionId,
          kind: "trace_complete",
          status: "ok",
          agentId: "system",
          name: "Offline import complete",
          contentType: "lifecycle",
          artifactIds: [],
        }),
      ],
      allowedEventIds: [eventId, completionId],
      allowedArtifactIds: [artifactId],
    });
    const node = result.operations.find((operation) => operation.op === "add_node");
    expect(node?.op === "add_node" ? node.node.title : null).toContain("durable session content");
    expect(node?.op === "add_node" ? Object.keys(node.node).sort() : null).toEqual([
      "claims",
      "kind",
      "title",
    ]);
    expect(node?.op === "add_node" ? node.node.claims[0]?.evidenceEventIds : null).toEqual([
      eventId,
      completionId,
    ]);
  });

  it("redacts common secrets before egress", () => {
    const result = redactProviderText(
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz token=super-secret-value",
    );
    expect(result.text).not.toContain("super-secret-value");
    expect(result.report.replacements).toBeGreaterThanOrEqual(2);
  });

  it("uses Responses structured outputs and validates the returned patch locally", async () => {
    let requestBody = "";
    const provider = new OpenAIResponsesSummaryProvider({
      apiKey: "test",
      model: "explicit-model",
      baseUrl: "https://example.test/v1",
      timeoutMs: 1000,
      maxEvents: 10,
      fetch: async (_url, init) => {
        requestBody = String(init?.body);
        return new Response(JSON.stringify({ output_text: JSON.stringify(patch) }), {
          status: 200,
        });
      },
    });
    await expect(provider.summarizeChunk(input)).resolves.toEqual(patch);
    expect(requestBody).toContain('"type":"json_schema"');
    expect(requestBody).not.toContain("super-secret-value");
  });

  it("uses DeepSeek JSON mode but rejects invalid local schema output", async () => {
    const provider = new DeepSeekJsonSummaryProvider({
      apiKey: "test",
      model: "explicit-model",
      baseUrl: "https://example.test",
      timeoutMs: 1000,
      maxEvents: 10,
      fetch: async (_url, init) => {
        expect(String(init?.body)).toContain('"type":"json_object"');
        return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
          status: 200,
        });
      },
    });
    await expect(provider.summarizeChunk(input)).rejects.toMatchObject<
      Partial<ProviderUnavailableError>
    >({ code: "bad_json" });
  });
});
