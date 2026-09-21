import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  ProblemDetailsSchema,
  ProviderIntentGraphPatchSchema,
  RawEventPageSchema,
  RawTraceEventInputSchema,
  RawTraceEventSchema,
  SemanticGraphSnapshotSchema,
  SemanticNodeVersionSchema,
  SemanticRevisionSchema,
  SessionCatalogSchema,
  SessionImportOutcomeSchema,
  SessionImportSummarySchema,
  SessionUploadCandidateListSchema,
  SessionUploadCandidateRequestSchema,
  SseEnvelopeSchema,
  SummaryJobEnvelopeSchema,
  TraceListSchema,
  TraceSnapshotSchema,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(here, "../generated");
const check = process.argv.includes("--check");

const schemas = {
  "problem-details.schema.json": ProblemDetailsSchema,
  "intent-graph-patch.schema.json": ProviderIntentGraphPatchSchema,
  "raw-trace-event.schema.json": RawTraceEventSchema,
  "raw-trace-event-input.schema.json": RawTraceEventInputSchema,
  "raw-event-page.schema.json": RawEventPageSchema,
  "semantic-node-version.schema.json": SemanticNodeVersionSchema,
  "semantic-revision.schema.json": SemanticRevisionSchema,
  "semantic-graph-snapshot.schema.json": SemanticGraphSnapshotSchema,
  "session-catalog.schema.json": SessionCatalogSchema,
  "session-import-outcome.schema.json": SessionImportOutcomeSchema,
  "session-import-summary.schema.json": SessionImportSummarySchema,
  "session-upload-candidate-request.schema.json": SessionUploadCandidateRequestSchema,
  "session-upload-candidate-list.schema.json": SessionUploadCandidateListSchema,
  "trace-list.schema.json": TraceListSchema,
  "trace-snapshot.schema.json": TraceSnapshotSchema,
  "sse-envelope.schema.json": SseEnvelopeSchema,
  "summary-job-envelope.schema.json": SummaryJobEnvelopeSchema,
};

let changed = false;

for (const [filename, schema] of Object.entries(schemas)) {
  const document = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
  });
  const content = `${JSON.stringify(document, null, 2)}\n`;
  const output = resolve(outputDirectory, filename);

  if (check) {
    const existing = await readFile(output, "utf8").catch(() => "");
    if (existing !== content) {
      changed = true;
      console.error(`generated schema is stale: ${filename}`);
    }
  } else {
    await writeFile(output, content, "utf8");
  }
}

if (changed) process.exitCode = 1;
