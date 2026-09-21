import type { RawEventKind } from "@intenttrace/schema";

import { lookupTopologyCapability } from "./topology.js";
import { decodeAdapterBytes, normalizeEvent, objectRecord } from "./common.js";
import {
  MalformedAdapterInputError,
  singleAdapterPart,
  UnsupportedAdapterVersionError,
  type AdapterInput,
  type AdapterManifest,
  type AdapterRecord,
  type TraceAdapter,
} from "./types.js";

function unixNanoToIso(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) return undefined;
  const milliseconds = Number(BigInt(value) / 1_000_000n);
  return Number.isSafeInteger(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function otlpAttributes(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return {};
  const entries = value.flatMap((entry) => {
    const record = objectRecord(entry);
    const key = record?.key;
    const wrapped = objectRecord(record?.value);
    if (typeof key !== "string" || !wrapped) return [];
    const child = Object.values(wrapped)[0];
    return [[key, child] as const];
  });
  return Object.fromEntries(entries);
}

function spanKind(name: string, status: "unset" | "ok" | "error"): RawEventKind {
  if (status === "error") return "error";
  if (/tool|command|shell/iu.test(name)) return "tool_call";
  if (/model|llm|completion/iu.test(name)) return "model_call";
  return "span_end";
}

export class OtlpHttpJsonAdapter implements TraceAdapter {
  readonly manifest: AdapterManifest = {
    source: "otlp",
    adapterVersion: "1.0.0",
    supportedFormatVersions: ["1.11-json"],
    status: "implemented",
    topology: lookupTopologyCapability("otlp", "1.0.0"),
  };

  async sniff(input: AdapterInput): Promise<boolean> {
    const part = singleAdapterPart(input);
    try {
      const root = objectRecord(JSON.parse(decodeAdapterBytes(part.bytes)) as unknown);
      return Array.isArray(root?.resourceSpans);
    } catch {
      return false;
    }
  }

  async *parse(input: AdapterInput): AsyncIterable<AdapterRecord> {
    const part = singleAdapterPart(input);
    let root: Record<string, unknown> | null;
    try {
      root = objectRecord(JSON.parse(decodeAdapterBytes(part.bytes)) as unknown);
    } catch (error) {
      throw new MalformedAdapterInputError("otlp", String(error));
    }
    if (!root) throw new MalformedAdapterInputError("otlp", "root must be an object");
    const version =
      typeof root.intenttraceOtlpVersion === "string" ? root.intenttraceOtlpVersion : "1.11-json";
    if (!this.manifest.supportedFormatVersions.includes(version)) {
      throw new UnsupportedAdapterVersionError("otlp", version);
    }
    if (!Array.isArray(root.resourceSpans)) {
      throw new MalformedAdapterInputError("otlp", "resourceSpans must be an array");
    }

    let ordinal = 0;
    for (const resourceSpan of root.resourceSpans) {
      const resource = objectRecord(resourceSpan);
      const resourceAttributes = otlpAttributes(objectRecord(resource?.resource)?.attributes);
      const scopes = Array.isArray(resource?.scopeSpans) ? resource.scopeSpans : [];
      for (const scopeSpan of scopes) {
        const scope = objectRecord(scopeSpan);
        const spans = Array.isArray(scope?.spans) ? scope.spans : [];
        for (const rawSpan of spans) {
          ordinal += 1;
          const span = objectRecord(rawSpan);
          if (!span) {
            yield {
              type: "warning",
              code: "invalid_span",
              message: `span ${ordinal} is not an object`,
            };
            continue;
          }
          const traceId = typeof span.traceId === "string" ? span.traceId : `trace-${ordinal}`;
          const spanId = typeof span.spanId === "string" ? span.spanId : `span-${ordinal}`;
          const name = typeof span.name === "string" && span.name ? span.name : "OTLP span";
          const statusCode = objectRecord(span.status)?.code;
          const status =
            statusCode === 2 || statusCode === "STATUS_CODE_ERROR"
              ? "error"
              : statusCode
                ? "ok"
                : "unset";
          yield {
            type: "event",
            event: normalizeEvent(
              {
                source: "otlp",
                formatVersion: version,
                adapterVersion: this.manifest.adapterVersion,
                sourceIdentity: input.sourceIdentity,
                sessionId: traceId,
                line: ordinal,
              },
              {
                sourceEventId: spanId,
                occurredAt: unixNanoToIso(span.endTimeUnixNano ?? span.startTimeUnixNano),
                kind: spanKind(name, status),
                name,
                status,
                agentId:
                  typeof resourceAttributes["service.name"] === "string"
                    ? resourceAttributes["service.name"]
                    : undefined,
                spanId,
                parentSpanId: typeof span.parentSpanId === "string" ? span.parentSpanId : undefined,
                attributes: { ...resourceAttributes, ...otlpAttributes(span.attributes) },
                payload: span,
              },
            ),
          };
        }
      }
    }
    if (ordinal === 0) {
      yield { type: "warning", code: "empty_export", message: "OTLP request contained no spans" };
    }
  }
}
