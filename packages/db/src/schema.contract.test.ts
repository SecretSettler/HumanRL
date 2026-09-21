import { describe, expect, it } from "vitest";

import {
  claimEvidence,
  rawEvents,
  revisionNodeMembers,
  semanticEdgeVersions,
  semanticNodeVersions,
  semanticRevisions,
  streamEvents,
} from "./schema.js";

describe("persistence contract", () => {
  it("defines version-scoped evidence and durable stream tables", () => {
    expect(rawEvents).toBeTruthy();
    expect(semanticRevisions).toBeTruthy();
    expect(semanticNodeVersions).toBeTruthy();
    expect(revisionNodeMembers).toBeTruthy();
    expect(claimEvidence).toBeTruthy();
    expect(streamEvents).toBeTruthy();
  });

  it("preserves nullable audit metadata for immutable semantic edge versions", () => {
    expect(semanticEdgeVersions.evidenceEventIds.name).toBe("evidence_event_ids");
    expect(semanticEdgeVersions.evidenceEventIds.notNull).toBe(false);
    expect(semanticEdgeVersions.provenance.name).toBe("provenance");
    expect(semanticEdgeVersions.provenance.notNull).toBe(false);
  });
});
