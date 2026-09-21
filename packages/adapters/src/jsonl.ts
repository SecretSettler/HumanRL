import { RawTraceEventInputSchema } from "@intenttrace/schema";

import {
  decodeAdapterBytes,
  objectRecord,
  readSessionRecords,
  type SessionRecord,
} from "./common.js";
import { lookupTopologyCapability } from "./topology.js";
import {
  MalformedAdapterInputError,
  normalizeAdapterInput,
  singleAdapterPart,
  UnsupportedAdapterVersionError,
  type AdapterInput,
  type AdapterManifest,
  type AdapterRecord,
  type TraceAdapter,
} from "./types.js";

export class CanonicalJsonlAdapter implements TraceAdapter {
  readonly manifest: AdapterManifest = {
    source: "jsonl",
    adapterVersion: "1.0.0",
    supportedFormatVersions: ["1.0.0"],
    status: "implemented",
    topology: lookupTopologyCapability("jsonl", "1.0.0"),
  };
  async sniff(input: AdapterInput): Promise<boolean> {
    const part = singleAdapterPart(input);
    try {
      return RawTraceEventInputSchema.safeParse(
        readSessionRecords(decodeAdapterBytes(part.bytes))[0]?.value,
      ).success;
    } catch {
      return false;
    }
  }
  async *parse(input: AdapterInput): AsyncIterable<AdapterRecord> {
    for (const part of normalizeAdapterInput(input).parts) {
      let records: SessionRecord[];
      try {
        records = readSessionRecords(decodeAdapterBytes(part.bytes));
      } catch (error) {
        throw new MalformedAdapterInputError("jsonl", `${part.path}: ${String(error)}`);
      }
      for (const record of records) {
        const object = objectRecord(record.value);
        const version = object?.schemaVersion;
        if (typeof version === "string" && !this.manifest.supportedFormatVersions.includes(version))
          throw new UnsupportedAdapterVersionError("jsonl", version);
        const parsed = RawTraceEventInputSchema.safeParse(record.value);
        if (!parsed.success)
          throw new MalformedAdapterInputError(
            "jsonl",
            `${part.path} line ${record.line}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
          );
        yield { type: "event", event: parsed.data };
        yield {
          type: "artifact",
          key: `${part.path}:event-${parsed.data.source.sourceEventId}`,
          sourceEventId: parsed.data.source.sourceEventId,
          bytes: record.bytes,
          mediaType: "application/json",
        };
      }
    }
  }
}
