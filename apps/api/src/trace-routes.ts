import { setTimeout as delay } from "node:timers/promises";

import {
  aggregateTopologyCapabilities,
  computeSessionCandidateId,
  detectSourceKind,
  discoverSessionCandidates,
  logicalSessionRootIdentity,
  OtlpHttpJsonAdapter,
  prepareSessionParts,
  redactCatalogEntry,
  sessionBundleContentSha256,
  uploadSessionKey,
  type PreparedTraceBundle,
} from "@intenttrace/adapters";
import {
  IntegrityConflictError,
  RepositoryNotFoundError,
  StaleSummaryJobError,
} from "@intenttrace/db";
import {
  HumanNodeEditSchema,
  IngestResultSchema,
  OtlpPartialSuccessSchema,
  ProviderCallAuditListSchema,
  RawEventPageSchema,
  RawTraceEventInputSchema,
  SemanticGraphSnapshotSchema,
  SemanticRevisionListSchema,
  SessionImportBatchOutcomeSchema,
  SessionUploadCandidateListSchema,
  SessionUploadCandidateRequestSchema,
  TraceListSchema,
  TraceSnapshotSchema,
  TraceSummarySchema,
  UuidSchema,
  type ImportSourceKind,
} from "@intenttrace/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { parseSessionBundleFrame, SESSION_BUNDLE_MEDIA_TYPE } from "./session-bundle.js";
import type { ApiServices } from "./services.js";

const TraceParamsSchema = z.object({ traceId: UuidSchema }).strict();
const ArtifactParamsSchema = TraceParamsSchema.extend({ artifactId: UuidSchema }).strict();
const NodeParamsSchema = TraceParamsSchema.extend({ nodeId: UuidSchema }).strict();
const EventQuerySchema = z
  .object({
    after: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
  })
  .strict();
const TraceListQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();
const GraphQuerySchema = z.object({ revisionId: UuidSchema.optional() }).strict();
const RevisionListQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
  .strict();
const ArtifactQuerySchema = z
  .object({
    offset: z.coerce.number().int().nonnegative().default(0),
    length: z.coerce.number().int().min(1).max(8_388_608).default(1_048_576),
  })
  .strict();
const StreamQuerySchema = z
  .object({
    cursor: z
      .string()
      .regex(/^[0-9]+$/u)
      .optional(),
  })
  .strict();
const DeleteTraceQuerySchema = z.object({ confirm: UuidSchema }).strict();
const ImportUploadQuerySchema = z.object({}).strict();

function problem(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  detail: string,
) {
  return reply.status(status).send({
    type: `https://intenttrace.local/problems/${code}`,
    title:
      status === 404
        ? "Resource not found"
        : status === 409
          ? "Integrity conflict"
          : "Request failed",
    status,
    detail,
    instance: request.url,
    code,
    requestId: request.id,
  });
}

async function persistPayload(
  services: ApiServices,
  input: z.infer<typeof RawTraceEventInputSchema>,
): Promise<z.infer<typeof RawTraceEventInputSchema>> {
  if (input.payload === undefined) return input;
  await services.repository.ensureTrace(input);
  const bytes = new TextEncoder().encode(JSON.stringify(input.payload));
  const metadata = await services.artifactStore.put({
    traceId: input.traceId,
    bytes,
    mediaType: "application/json",
  });
  const artifact = await services.repository.registerArtifact({
    traceId: input.traceId,
    sha256: metadata.sha256,
    byteLength: metadata.byteLength,
    mediaType: metadata.mediaType,
    storageKey: metadata.sha256,
  });
  const event = { ...input };
  delete event.payload;
  return RawTraceEventInputSchema.parse({
    ...event,
    payloadRef: {
      artifactId: artifact.id,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
    },
    artifactRefs: [...new Set([...event.artifactRefs, artifact.id])],
  });
}

function formatSse(event: {
  id: string;
  traceId: string;
  revisionId: string | null;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({
    schemaVersion: "1.0.0",
    eventId: event.id,
    traceId: event.traceId,
    occurredAt: event.occurredAt,
    revisionId: event.revisionId,
    type: event.type,
    payload: event.payload,
  })}\n\n`;
}

function bundleSourceIdentity(parts: readonly { path: string; bytes: Uint8Array }[]): string {
  return `bundle-${sessionBundleContentSha256(parts).slice(0, 32)}`;
}

function sessionCandidateId(
  source: ImportSourceKind,
  rootIdentity: string,
  paths: readonly string[],
): string {
  return computeSessionCandidateId(source, rootIdentity, paths);
}

interface ImportCandidate {
  clientRef: string;
  candidateId: string;
  partRefs: string[];
  source: ImportSourceKind;
  prepared: PreparedTraceBundle | null;
  partialHead: boolean;
  failureCode: "preflight_failed" | null;
  failureMessage: string | null;
}

function companionMayBelongToSource(path: string, source: ImportSourceKind): boolean {
  if (source === "claude") {
    return (
      path.includes("/subagents/") || path.startsWith("subagents/") || path.endsWith(".meta.json")
    );
  }
  if (source === "opencode") return path.endsWith("-wal") || path.endsWith("-shm");
  if (source === "omp") return /\/(?:[^/]+)\.(?:jsonl|ndjson)$/iu.test(path);
  return false;
}

async function discoverCandidates(
  sourceHint: ImportSourceKind | "auto",
  parts: readonly {
    clientRef: string;
    path: string;
    bytes: Uint8Array;
    modifiedAt: string;
    complete: boolean;
  }[],
): Promise<ImportCandidate[]> {
  const sourceByRootRef = new Map<string, ImportSourceKind>();
  if (sourceHint === "auto") {
    const potentialRoots = parts.filter(
      (part) =>
        !part.path.includes("/subagents/") &&
        !part.path.startsWith("subagents/") &&
        !part.path.endsWith(".meta.json") &&
        !part.path.endsWith("-wal") &&
        !part.path.endsWith("-shm"),
    );
    for (const part of potentialRoots.slice(0, 50)) {
      const source = await detectSourceKind({
        parts: [{ path: part.path, bytes: part.bytes }],
        sourceIdentity: bundleSourceIdentity([{ path: part.path, bytes: part.bytes }]),
      });
      if (
        source === "jsonl" ||
        source === "otlp" ||
        source === "codex" ||
        source === "claude" ||
        source === "opencode" ||
        source === "omp" ||
        source === "grok"
      ) {
        sourceByRootRef.set(part.clientRef, source);
      }
    }
  }
  const candidates: ImportCandidate[] = [];
  const sources = sourceHint === "auto" ? [...new Set(sourceByRootRef.values())] : [sourceHint];
  let remainingRoots = 50;
  for (const source of sources) {
    if (remainingRoots === 0) break;
    const rootRefs = new Set(
      [...sourceByRootRef.entries()]
        .filter(([, detectedSource]) => detectedSource === source)
        .map(([ref]) => ref),
    );
    const sourceParts = parts
      .filter(
        (part) =>
          sourceHint !== "auto" ||
          rootRefs.has(part.clientRef) ||
          companionMayBelongToSource(part.path, source),
      )
      .map((part) => ({ ...part, byteLength: part.bytes.byteLength }));
    const discovered = await discoverSessionCandidates(source, sourceParts, remainingRoots);
    remainingRoots -= discovered.length;
    for (const candidate of discovered) {
      if (candidates.length >= 50) break;
      const selectedParts = sourceParts.filter((part) =>
        candidate.partRefs.includes(part.clientRef),
      );
      if (candidate.failureCode) {
        candidates.push({
          clientRef: candidate.clientRef,
          candidateId: candidate.candidateId,
          partRefs: candidate.partRefs,
          source,
          prepared: null,
          partialHead: selectedParts.some((part) => !part.complete),
          failureCode: candidate.failureCode,
          failureMessage: candidate.failureMessage,
        });
        continue;
      }
      const adapterParts = selectedParts.map((part) => ({ path: part.path, bytes: part.bytes }));
      const sourceIdentity = bundleSourceIdentity(adapterParts);
      try {
        const bundles = await prepareSessionParts(source, adapterParts, sourceIdentity, {
          id: uploadSessionKey(source, sessionBundleContentSha256(adapterParts)),
          byteLength: selectedParts.reduce((total, part) => total + part.bytes.byteLength, 0),
          modifiedAt: selectedParts
            .map((part) => part.modifiedAt)
            .sort()
            .at(-1)!,
        });
        for (const [bundleIndex, prepared] of bundles.entries()) {
          if (candidates.length >= 50) break;
          candidates.push({
            clientRef:
              bundles.length === 1
                ? candidate.clientRef
                : `${candidate.clientRef}:logical-${bundleIndex + 1}`,
            candidateId: sessionCandidateId(
              source,
              logicalSessionRootIdentity(candidate.rootIdentity, bundleIndex, bundles.length),
              adapterParts.map((part) => part.path),
            ),
            partRefs: candidate.partRefs,
            source,
            prepared,
            partialHead: selectedParts.some((part) => !part.complete),
            failureCode: null,
            failureMessage: null,
          });
        }
      } catch {
        candidates.push({
          clientRef: candidate.clientRef,
          candidateId: candidate.candidateId,
          partRefs: candidate.partRefs,
          source,
          prepared: null,
          partialHead: selectedParts.some((part) => !part.complete),
          failureCode: "preflight_failed",
          failureMessage: "Session preflight failed; no events were imported",
        });
      }
    }
  }
  return candidates.slice(0, 50);
}

async function persistPreparedBundle(
  services: ApiServices,
  prepared: PreparedTraceBundle,
): Promise<{ inserted: number; duplicates: number; warnings: number; traceId: string }> {
  const firstEvent = prepared.events[0]!.event;
  await services.repository.ensureTrace(firstEvent);
  const artifactIds = new Map<string, string>();
  for (const artifact of prepared.artifacts) {
    const metadata = await services.artifactStore.put({
      traceId: firstEvent.traceId,
      bytes: artifact.bytes,
      mediaType: artifact.mediaType,
    });
    const registered = await services.repository.registerArtifact({
      traceId: firstEvent.traceId,
      sha256: metadata.sha256,
      byteLength: metadata.byteLength,
      mediaType: metadata.mediaType,
      storageKey: metadata.sha256,
    });
    artifactIds.set(artifact.key, registered.id);
  }
  let inserted = 0;
  let duplicates = 0;
  let warnings = prepared.warnings.length;
  const send = async (input: z.infer<typeof RawTraceEventInputSchema>) => {
    const result = await services.repository.ingest(await persistPayload(services, input));
    if (result.duplicate) duplicates += 1;
    else inserted += 1;
    warnings += result.warnings.length;
  };
  for (const preparedEvent of prepared.events) {
    await send(
      RawTraceEventInputSchema.parse({
        ...preparedEvent.event,
        artifactRefs: [
          ...new Set([
            ...preparedEvent.event.artifactRefs,
            ...preparedEvent.artifactKeys.map((key) => artifactIds.get(key)!),
          ]),
        ],
      }),
    );
  }
  await send(prepared.completionMarker);
  return { inserted, duplicates, warnings, traceId: firstEvent.traceId };
}

export interface TraceRouteOptions {
  services: ApiServices;
  uploadMaxBytes: number;
}

export async function registerTraceRoutes(
  app: FastifyInstance,
  options: TraceRouteOptions,
): Promise<void> {
  const { services, uploadMaxBytes } = options;
  app.post(
    "/api/v1/events",
    {
      schema: {
        operationId: "ingestRawEvent",
        summary: "Append one normalized raw trace fact",
        body: RawTraceEventInputSchema,
        response: { 200: IngestResultSchema, 201: IngestResultSchema },
      },
    },
    async (request, reply) => {
      try {
        const input = await persistPayload(services, RawTraceEventInputSchema.parse(request.body));
        const result = await services.repository.ingest(input);
        return reply.status(result.duplicate ? 200 : 201).send(result);
      } catch (error) {
        if (error instanceof IntegrityConflictError) {
          return problem(
            reply,
            request,
            409,
            error.code,
            `${error.message}; existing=${error.existingEventId}`,
          );
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/traces",
    {
      schema: {
        operationId: "exportOtlpTraces",
        summary: "OTLP/HTTP JSON trace receiver",
        body: z.record(z.string(), z.unknown()),
        response: { 200: OtlpPartialSuccessSchema },
      },
    },
    async (request, reply) => {
      const adapter = new OtlpHttpJsonAdapter();
      let rejectedSpans = 0;
      const errors: string[] = [];
      const bytes = new TextEncoder().encode(JSON.stringify(request.body));
      for await (const record of adapter.parse({
        parts: [{ path: ".", bytes }],
        sourceIdentity: "otlp-http",
      })) {
        if (record.type === "warning") {
          errors.push(record.message);
          continue;
        }
        if (record.type !== "event") continue;
        try {
          await services.repository.ingest(await persistPayload(services, record.event));
        } catch (error) {
          rejectedSpans += 1;
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return reply.status(200).send({
        partialSuccess: {
          rejectedSpans,
          errorMessage: errors.join("; ").slice(0, 1000),
        },
      });
    },
  );

  app.post(
    "/api/v1/imports/candidates",
    {
      bodyLimit: uploadMaxBytes,
      schema: {
        operationId: "inspectImportCandidates",
        summary: `Inspect candidate metadata or ${SESSION_BUNDLE_MEDIA_TYPE}`,
        response: { 200: SessionUploadCandidateListSchema },
      },
    },
    async (request, reply) => {
      let includePreviews = false;
      let candidates: ImportCandidate[];
      if (Buffer.isBuffer(request.body)) {
        try {
          const frame = parseSessionBundleFrame(request.body);
          if (frame.candidateIds.length !== 0) {
            return problem(
              reply,
              request,
              400,
              "invalid_session_bundle",
              "Candidate inspection requires candidateIds=[]",
            );
          }
          candidates = await discoverCandidates(
            frame.source,
            frame.parts.map((part) => ({ ...part, complete: true })),
          );
        } catch {
          return problem(
            reply,
            request,
            400,
            "invalid_session_bundle",
            "Invalid session bundle frame",
          );
        }
      } else {
        const parsedBody = SessionUploadCandidateRequestSchema.safeParse(request.body);
        if (!parsedBody.success) {
          return problem(
            reply,
            request,
            400,
            "validation_failed",
            "Invalid candidate metadata request",
          );
        }
        const body = parsedBody.data;
        includePreviews = body.includePreviews;
        candidates = await discoverCandidates(
          "auto",
          body.parts.map((part) => {
            let bytes =
              part.headBase64 === undefined
                ? Buffer.alloc(0)
                : Buffer.from(part.headBase64, "base64");
            if (!part.complete) {
              const cut = bytes.lastIndexOf(0x0a);
              bytes = cut >= 0 ? bytes.subarray(0, cut + 1) : Buffer.alloc(0);
            }
            return {
              clientRef: part.clientRef,
              path: part.path,
              bytes,
              modifiedAt: part.modifiedAt,
              complete: part.complete,
            };
          }),
        );
      }
      const traceIds = [
        ...new Set(
          candidates.flatMap((candidate) =>
            candidate.prepared ? [candidate.prepared.events[0]!.event.traceId] : [],
          ),
        ),
      ];
      const known = new Map(
        (await services.repository.listTracesByIds(traceIds)).map((trace) => [
          trace.id,
          trace.eventCount,
        ]),
      );
      let alreadyImportedCount = 0;
      const responseCandidates = candidates.map((candidate) => {
        const traceId = candidate.prepared?.events[0]?.event.traceId ?? null;
        const importedEventCount = traceId === null ? null : (known.get(traceId) ?? null);
        if (importedEventCount !== null) alreadyImportedCount += 1;
        const descriptor = candidate.prepared
          ? redactCatalogEntry(candidate.prepared.descriptor, includePreviews)
          : null;
        return {
          clientRef: candidate.clientRef,
          candidateId: candidate.candidateId,
          partRefs: candidate.partRefs,
          source: candidate.source,
          title: descriptor?.title ?? null,
          projectHint: descriptor?.projectHint ?? null,
          firstPromptPreview: descriptor?.firstPromptPreview ?? null,
          lastPromptPreview: descriptor?.lastPromptPreview ?? null,
          partialHead: candidate.partialHead,
          traceId,
          imported: importedEventCount !== null,
          importedEventCount,
          failureCode: candidate.failureCode,
          failureMessage: candidate.failureMessage,
        };
      });
      return reply.status(200).send({
        protocolVersion: 2,
        candidates: responseCandidates,
        alreadyImportedCount,
      });
    },
  );

  app.post(
    "/api/v1/imports/sessions",
    {
      bodyLimit: uploadMaxBytes,
      schema: {
        operationId: "importUploadedSession",
        summary: `Import selected logical traces from ${SESSION_BUNDLE_MEDIA_TYPE}`,
        querystring: ImportUploadQuerySchema,
        response: { 200: SessionImportBatchOutcomeSchema },
      },
    },
    async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) {
        return problem(
          reply,
          request,
          415,
          "unsupported_media_type",
          `session upload requires ${SESSION_BUNDLE_MEDIA_TYPE}`,
        );
      }
      let frame: ReturnType<typeof parseSessionBundleFrame>;
      try {
        frame = parseSessionBundleFrame(request.body);
      } catch {
        return problem(
          reply,
          request,
          400,
          "invalid_session_bundle",
          "Invalid session bundle frame",
        );
      }
      if (frame.candidateIds.length === 0) {
        return problem(
          reply,
          request,
          400,
          "invalid_session_bundle",
          "Import requires at least one candidate ID",
        );
      }
      const candidates = await discoverCandidates(
        frame.source,
        frame.parts.map((part) => ({ ...part, complete: true })),
      );
      if (candidates.length === 0 && frame.source === "auto") {
        return problem(
          reply,
          request,
          422,
          "unknown_source_format",
          "Unable to determine the session format",
        );
      }
      const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
      if (
        frame.candidateIds.some((id) => {
          const candidate = byId.get(id);
          return candidate === undefined || candidate.prepared === null;
        })
      ) {
        return problem(
          reply,
          request,
          409,
          "stale_session",
          "Session changed after inspection; inspect again",
        );
      }
      try {
        const results = [];
        for (const id of frame.candidateIds) {
          const candidate = byId.get(id)!;
          const prepared = candidate.prepared!;
          const result = await persistPreparedBundle(services, prepared);
          results.push({
            candidateId: id,
            sessionId: prepared.descriptor.id,
            ...result,
          });
        }
        return reply.status(200).send({
          protocolVersion: 2,
          level: "result",
          command: "upload",
          results,
        });
      } catch (error) {
        if (error instanceof IntegrityConflictError) {
          return problem(
            reply,
            request,
            409,
            error.code,
            `${error.message}; existing=${error.existingEventId}`,
          );
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/traces",
    {
      schema: {
        operationId: "listTraces",
        summary: "List local traces",
        querystring: TraceListQuerySchema,
        response: { 200: TraceListSchema },
      },
    },
    async (request) => {
      const query = TraceListQuerySchema.parse(request.query);
      return services.repository.listTraces(query.limit);
    },
  );

  app.patch(
    "/api/v1/traces/:traceId/nodes/:nodeId",
    {
      schema: {
        operationId: "editSemanticNode",
        summary: "Create a human semantic revision and optionally pin a node",
        params: NodeParamsSchema,
        body: HumanNodeEditSchema,
        response: { 200: SemanticGraphSnapshotSchema },
      },
    },
    async (request, reply) => {
      const { traceId, nodeId } = NodeParamsSchema.parse(request.params);
      try {
        const revisionId = await services.repository.editSemanticNode(
          traceId,
          nodeId,
          HumanNodeEditSchema.parse(request.body),
        );
        return await services.repository.getGraph(traceId, revisionId);
      } catch (error) {
        if (error instanceof RepositoryNotFoundError) {
          return problem(reply, request, 404, error.code, error.message);
        }
        if (error instanceof StaleSummaryJobError) {
          return problem(reply, request, 409, error.code, error.message);
        }
        throw error;
      }
    },
  );

  app.delete(
    "/api/v1/traces/:traceId",
    {
      schema: {
        operationId: "deleteTrace",
        summary: "Permanently delete one local trace after explicit ID confirmation",
        params: TraceParamsSchema,
        querystring: DeleteTraceQuerySchema,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const { traceId } = TraceParamsSchema.parse(request.params);
      const { confirm } = DeleteTraceQuerySchema.parse(request.query);
      if (confirm !== traceId) {
        return problem(reply, request, 409, "confirmation_mismatch", "confirm must equal traceId");
      }
      try {
        await services.repository.deleteTraceData(traceId);
        await services.artifactStore.deleteTrace(traceId);
        return reply.status(204).send();
      } catch (error) {
        if (error instanceof RepositoryNotFoundError) {
          return problem(reply, request, 404, error.code, error.message);
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/traces/:traceId",
    {
      schema: {
        operationId: "getTrace",
        summary: "Get trace metadata",
        params: TraceParamsSchema,
        response: { 200: TraceSummarySchema },
      },
    },
    async (request, reply) => {
      try {
        return await services.repository.getTrace(TraceParamsSchema.parse(request.params).traceId);
      } catch (error) {
        if (error instanceof RepositoryNotFoundError) {
          return problem(reply, request, 404, error.code, error.message);
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/traces/:traceId/events",
    {
      schema: {
        operationId: "listRawEvents",
        summary: "Page append-only raw events by ingest sequence",
        params: TraceParamsSchema,
        querystring: EventQuerySchema,
        response: { 200: RawEventPageSchema },
      },
    },
    async (request) => {
      const { traceId } = TraceParamsSchema.parse(request.params);
      const query = EventQuerySchema.parse(request.query);
      return services.repository.listRawEvents(traceId, query.after, query.limit);
    },
  );

  app.get(
    "/api/v1/traces/:traceId/snapshot",
    {
      schema: {
        operationId: "getTraceSnapshot",
        summary: "Get raw trace snapshot at the current watermark",
        params: TraceParamsSchema,
        querystring: EventQuerySchema,
        response: { 200: TraceSnapshotSchema },
      },
    },
    async (request) => {
      const { traceId } = TraceParamsSchema.parse(request.params);
      const query = EventQuerySchema.parse(request.query);
      const [trace, raw, agents, graph, topologyData] = await Promise.all([
        services.repository.getTrace(traceId),
        services.repository.listRawEvents(traceId, query.after, query.limit),
        services.repository.getAgentTimeline(traceId),
        services.repository.getGraph(traceId),
        services.repository.getObservedTopology(traceId),
      ]);
      return {
        trace,
        raw,
        agents,
        revision: graph?.revision ?? null,
        topology: {
          declared: aggregateTopologyCapabilities(topologyData.sources),
          observed: topologyData.observed,
        },
      };
    },
  );

  app.get(
    "/api/v1/traces/:traceId/graph",
    {
      schema: {
        operationId: "getSemanticGraph",
        summary: "Get one committed semantic graph revision",
        params: TraceParamsSchema,
        querystring: GraphQuerySchema,
        response: { 200: SemanticGraphSnapshotSchema },
      },
    },
    async (request, reply) => {
      const { traceId } = TraceParamsSchema.parse(request.params);
      const query = GraphQuerySchema.parse(request.query);
      const graph = await services.repository.getGraph(traceId, query.revisionId);
      if (!graph) {
        return problem(reply, request, 404, "not_found", "semantic graph revision was not found");
      }
      return graph;
    },
  );

  app.get(
    "/api/v1/traces/:traceId/revisions",
    {
      schema: {
        operationId: "listSemanticRevisions",
        summary: "List committed semantic revisions, newest first",
        params: TraceParamsSchema,
        querystring: RevisionListQuerySchema,
        response: { 200: SemanticRevisionListSchema },
      },
    },
    async (request) => {
      const { traceId } = TraceParamsSchema.parse(request.params);
      const query = RevisionListQuerySchema.parse(request.query);
      return { revisions: await services.repository.listRevisions(traceId, query.limit) };
    },
  );

  app.get(
    "/api/v1/traces/:traceId/provider-calls",
    {
      schema: {
        operationId: "listProviderCalls",
        summary: "Audit summary provider calls and recorded cost fields",
        params: TraceParamsSchema,
        response: { 200: ProviderCallAuditListSchema },
      },
    },
    async (request) => ({
      calls: await services.repository.listProviderCalls(
        TraceParamsSchema.parse(request.params).traceId,
      ),
    }),
  );

  app.get(
    "/api/v1/traces/:traceId/artifacts/:artifactId",
    {
      schema: {
        operationId: "getArtifactRange",
        summary: "Read an evidence artifact byte range",
        params: ArtifactParamsSchema,
        querystring: ArtifactQuerySchema,
      },
    },
    async (request, reply) => {
      try {
        const { traceId, artifactId } = ArtifactParamsSchema.parse(request.params);
        const query = ArtifactQuerySchema.parse(request.query);
        const artifact = await services.repository.getArtifact(traceId, artifactId);
        const bytes = await services.artifactStore.getRange(
          traceId,
          artifact.sha256,
          query.offset,
          query.length,
        );
        return reply
          .header(
            "content-type",
            artifact.mediaType === "text/html" || artifact.mediaType === "image/svg+xml"
              ? "application/octet-stream"
              : artifact.mediaType,
          )
          .header("content-disposition", `attachment; filename="artifact-${artifactId}"`)
          .header("content-security-policy", "default-src 'none'; sandbox")
          .header("accept-ranges", "bytes")
          .header("x-content-type-options", "nosniff")
          .send(Buffer.from(bytes));
      } catch (error) {
        if (error instanceof RepositoryNotFoundError) {
          return problem(reply, request, 404, error.code, error.message);
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/traces/:traceId/stream",
    {
      schema: {
        operationId: "streamTraceEvents",
        summary: "Resume durable trace events with Last-Event-ID or cursor",
        params: TraceParamsSchema,
        querystring: StreamQuerySchema,
      },
    },
    async (request, reply) => {
      const { traceId } = TraceParamsSchema.parse(request.params);
      const query = StreamQuerySchema.parse(request.query);
      const header = request.headers["last-event-id"];
      let cursor = BigInt(query.cursor ?? (typeof header === "string" ? header : "0"));
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const bounds = await services.repository.getStreamBounds(traceId);
      if (cursor > 0n && bounds.earliest !== null && cursor < bounds.earliest - 1n) {
        reply.raw.write(
          `id: ${bounds.earliest - 1n}\nevent: resync.required\ndata: ${JSON.stringify({
            schemaVersion: "1.0.0",
            traceId,
            type: "resync.required",
            payload: { requestedCursor: String(cursor), earliestCursor: String(bounds.earliest) },
          })}\n\n`,
        );
        cursor = bounds.earliest - 1n;
      }
      let heartbeatAt = Date.now();
      while (!request.raw.destroyed) {
        const events = await services.repository.listStreamEvents(traceId, cursor);
        for (const event of events) {
          reply.raw.write(formatSse(event));
          cursor = BigInt(event.id);
        }
        if (Date.now() - heartbeatAt >= 15_000) {
          reply.raw.write(`event: heartbeat\ndata: {"cursor":"${cursor}"}\n\n`);
          heartbeatAt = Date.now();
        }
        await delay(500);
      }
    },
  );
}
