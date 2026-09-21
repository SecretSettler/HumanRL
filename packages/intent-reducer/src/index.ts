import { createHash } from "node:crypto";

import {
  ProviderIntentGraphPatchSchema,
  type CanonicalClaim,
  type ProviderClaim,
  type ProviderIntentGraphPatch,
  type ReducerDerivedEdgeKind,
  type SemanticEdgeKind,
  type SemanticNodeKind,
  type SemanticNodeStatus,
  type TopologyCapability,
  type TraceSourceKind,
} from "@intenttrace/schema";

export interface PatchValidationContext {
  expectedBaseRevisionId: string;
  expectedJobNonce: string;
  allowedEventIds: ReadonlySet<string>;
  allowedArtifactIds: ReadonlySet<string>;
  allowedAgentIds: ReadonlySet<string>;
  allowedNodeIds: ReadonlySet<string>;
  allowedEdgeIds: ReadonlySet<string>;
  pinnedNodeIds: ReadonlySet<string>;
}

export interface PatchValidationIssue {
  code:
    | "schema_invalid"
    | "stale_revision"
    | "nonce_mismatch"
    | "unknown_reference"
    | "unknown_evidence"
    | "duplicate_temporary_ref"
    | "pinned_node";
  operationIndex?: number;
  detail: string;
}

export interface ReducerNode {
  logicalNodeId: string;
  versionId: string;
  kind: SemanticNodeKind;
  status: SemanticNodeStatus;
  title: string;
  claims: CanonicalClaim[];
  primaryParentId: string | null;
  primaryAgentId: string | null;
  participantAgentIds: string[];
  artifactIds: string[];
  pinnedByHuman: boolean;
  startedAt: string | null;
  endedAt: string | null;
  layout: { x: number; y: number } | null;
}

export interface ReducerEdge {
  logicalEdgeId: string;
  versionId: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: SemanticEdgeKind;
  evidenceEventIds: string[];
  provenance: "stated" | "inferred" | "mixed";
  retired: boolean;
}

export interface ReducerGraphState {
  nodes: ReducerNode[];
  edges: ReducerEdge[];
}

export interface ReducerRawFact {
  eventId: string;
  sourceKind: TraceSourceKind;
  adapterVersion: string;
  sourceEventId: string;
  ingestSeq: string;
  kind: string;
  status: string;
  agentId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
  causationEventId: string | null;
  artifactRefs: readonly string[];
  parentAgentId?: string;
  spawnedAgentIds?: readonly string[];
  joinedAgentIds?: readonly string[];
  joinedBy?: string;
  senderAgentId?: string;
  recipientAgentId?: string;
  messageId?: string;
  onBehalfOf?: string;
  assignedBy?: string;
  topologyProvenance?: "stated" | "inferred";
}

export interface ReducerTopologyContext {
  traceId: string;
  eventWatermark: string;
  facts: readonly ReducerRawFact[];
  capabilities: ReadonlyMap<string, TopologyCapability>;
  registeredArtifactIds: ReadonlySet<string>;
}

export type PatchApplyResult =
  | { ok: false; issues: PatchValidationIssue[] }
  | {
      ok: true;
      patch: ProviderIntentGraphPatch;
      state: ReducerGraphState;
      changedNodeIds: string[];
      changedEdgeIds: string[];
      diagnostics: string[];
    };

export interface TopologyDerivationResult {
  state: ReducerGraphState;
  changedNodeIds: string[];
  changedEdgeIds: string[];
  diagnostics: string[];
}

export function topologyCapabilityKey(sourceKind: TraceSourceKind, adapterVersion: string): string {
  return `${sourceKind}\0${adapterVersion}`;
}

function deterministicUuid(namespace: string, value: string): string {
  const bytes = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(value)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function confidence(claim: ProviderClaim): CanonicalClaim["confidence"] {
  const evidenceCount = new Set(claim.evidenceEventIds).size;
  if (claim.provenance === "stated" && evidenceCount >= 1) return "high";
  if (claim.provenance === "mixed" && evidenceCount >= 2) return "high";
  if (evidenceCount >= 1 && claim.provenance !== "inferred") return "medium";
  return "low";
}

function canonicalClaim(claim: ProviderClaim): CanonicalClaim {
  return {
    kind: claim.kind,
    text: claim.text,
    provenance: claim.provenance,
    confidence: confidence(claim),
    evidenceEventIds: [...new Set(claim.evidenceEventIds)].sort(),
  };
}

export type PatchValidationResult =
  { ok: true; patch: ProviderIntentGraphPatch } | { ok: false; issues: PatchValidationIssue[] };

function collectEvidence(
  operation: ProviderIntentGraphPatch["operations"][number],
): readonly string[] {
  if (operation.op === "add_node") {
    return operation.node.claims.flatMap((claim) => claim.evidenceEventIds);
  }
  if (operation.op === "update_node") {
    return [
      ...operation.evidenceEventIds,
      ...(operation.set.claims?.flatMap((claim) => claim.evidenceEventIds) ?? []),
    ];
  }
  return operation.evidenceEventIds;
}

export function validateProviderPatch(
  input: unknown,
  context: PatchValidationContext,
): PatchValidationResult {
  const parsed = ProviderIntentGraphPatchSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: [
        {
          code: "schema_invalid",
          detail: parsed.error.issues.map((issue) => issue.message).join("; "),
        },
      ],
    };
  }

  const patch = parsed.data;
  const issues: PatchValidationIssue[] = [];
  if (patch.baseRevisionId !== context.expectedBaseRevisionId) {
    issues.push({
      code: "stale_revision",
      detail: "patch base revision does not match current revision",
    });
  }
  if (patch.jobNonce !== context.expectedJobNonce) {
    issues.push({ code: "nonce_mismatch", detail: "patch nonce does not match summary job" });
  }

  const temporaryNodes = new Set<string>();
  for (const [index, operation] of patch.operations.entries()) {
    if (operation.op !== "add_node") continue;
    if (temporaryNodes.has(operation.ref)) {
      issues.push({
        code: "duplicate_temporary_ref",
        operationIndex: index,
        detail: operation.ref,
      });
    }
    temporaryNodes.add(operation.ref);
  }

  for (const [index, operation] of patch.operations.entries()) {
    for (const eventId of collectEvidence(operation)) {
      if (!context.allowedEventIds.has(eventId)) {
        issues.push({ code: "unknown_evidence", operationIndex: index, detail: eventId });
      }
    }
    if (operation.op === "update_node") {
      if (!context.allowedNodeIds.has(operation.ref)) {
        issues.push({ code: "unknown_reference", operationIndex: index, detail: operation.ref });
      }
      if (context.pinnedNodeIds.has(operation.ref)) {
        issues.push({ code: "pinned_node", operationIndex: index, detail: operation.ref });
      }
    }
    if (operation.op === "suggest_merge") {
      for (const nodeId of [operation.survivorNodeId, ...operation.mergedNodeIds]) {
        if (!context.allowedNodeIds.has(nodeId)) {
          issues.push({ code: "unknown_reference", operationIndex: index, detail: nodeId });
        }
        if (context.pinnedNodeIds.has(nodeId)) {
          issues.push({ code: "pinned_node", operationIndex: index, detail: nodeId });
        }
      }
    }
  }
  return issues.length === 0 ? { ok: true, patch } : { ok: false, issues };
}

interface NodeAnchor {
  node: ReducerNode;
  facts: ReducerRawFact[];
  evidence: Set<string>;
  startSeq: bigint;
  endSeq: bigint;
  lane: string | null;
}

function compareNodeId(left: NodeAnchor, right: NodeAnchor): number {
  return left.node.logicalNodeId.localeCompare(right.node.logicalNodeId);
}

function orderedFacts(context: ReducerTopologyContext): ReducerRawFact[] {
  return [...context.facts]
    .filter((fact) => BigInt(fact.ingestSeq) <= BigInt(context.eventWatermark))
    .sort((left, right) => {
      const delta = BigInt(left.ingestSeq) - BigInt(right.ingestSeq);
      return delta < 0n ? -1 : delta > 0n ? 1 : left.eventId.localeCompare(right.eventId);
    });
}

function buildAnchors(
  nodes: readonly ReducerNode[],
  facts: readonly ReducerRawFact[],
): NodeAnchor[] {
  const factById = new Map(facts.map((fact) => [fact.eventId, fact]));
  return nodes.flatMap((node) => {
    const evidence = new Set(node.claims.flatMap((claim) => claim.evidenceEventIds));
    const resolved = [...evidence]
      .map((eventId) => factById.get(eventId))
      .filter((fact): fact is ReducerRawFact => Boolean(fact))
      .sort((left, right) => {
        const delta = BigInt(left.ingestSeq) - BigInt(right.ingestSeq);
        return delta < 0n ? -1 : delta > 0n ? 1 : left.eventId.localeCompare(right.eventId);
      });
    if (resolved.length === 0) return [];
    const lanes = resolved.flatMap((fact) => (fact.agentId ? [fact.agentId] : []));
    return [
      {
        node,
        facts: resolved,
        evidence,
        startSeq: BigInt(resolved[0]!.ingestSeq),
        endSeq: BigInt(resolved.at(-1)!.ingestSeq),
        lane: lanes[0] ?? null,
      },
    ];
  });
}

function exactAnchor(anchors: readonly NodeAnchor[], fact: ReducerRawFact): NodeAnchor | undefined {
  return anchors
    .filter((anchor) => anchor.evidence.has(fact.eventId))
    .sort((left, right) =>
      left.startSeq === right.startSeq
        ? compareNodeId(left, right)
        : left.startSeq < right.startSeq
          ? -1
          : 1,
    )[0];
}

function outboundEndpoint(
  anchors: readonly NodeAnchor[],
  lane: string | null,
  fact: ReducerRawFact,
): NodeAnchor | undefined {
  const exact = exactAnchor(anchors, fact);
  if (exact && exact.lane === lane) return exact;
  if (!lane) return undefined;
  const eventSeq = BigInt(fact.ingestSeq);
  return anchors
    .filter((anchor) => anchor.lane === lane && anchor.startSeq <= eventSeq)
    .sort((left, right) =>
      left.startSeq === right.startSeq
        ? compareNodeId(left, right)
        : left.startSeq > right.startSeq
          ? -1
          : 1,
    )[0];
}

function inboundEndpoint(
  anchors: readonly NodeAnchor[],
  lane: string | null,
  fact: ReducerRawFact,
): NodeAnchor | undefined {
  const exact = exactAnchor(anchors, fact);
  if (exact && exact.lane === lane) return exact;
  if (!lane) return undefined;
  const eventSeq = BigInt(fact.ingestSeq);
  return anchors
    .filter((anchor) => anchor.lane === lane && anchor.endSeq >= eventSeq)
    .sort((left, right) =>
      left.endSeq === right.endSeq
        ? compareNodeId(left, right)
        : left.endSeq < right.endSeq
          ? -1
          : 1,
    )[0];
}

function laneFirst(anchors: readonly NodeAnchor[], lane: string): NodeAnchor | undefined {
  return anchors
    .filter((anchor) => anchor.lane === lane)
    .sort((left, right) =>
      left.startSeq === right.startSeq
        ? compareNodeId(left, right)
        : left.startSeq < right.startSeq
          ? -1
          : 1,
    )[0];
}

function laneLast(anchors: readonly NodeAnchor[], lane: string): NodeAnchor | undefined {
  return anchors
    .filter((anchor) => anchor.lane === lane)
    .sort((left, right) =>
      left.endSeq === right.endSeq
        ? compareNodeId(left, right)
        : left.endSeq > right.endSeq
          ? -1
          : 1,
    )[0];
}

function capabilityFor(
  context: ReducerTopologyContext,
  fact: ReducerRawFact,
): TopologyCapability | undefined {
  return context.capabilities.get(topologyCapabilityKey(fact.sourceKind, fact.adapterVersion));
}

function structuralProvenance(
  relation: "spawn" | "join" | "peerMessages",
  context: ReducerTopologyContext,
  facts: readonly ReducerRawFact[],
): "stated" | "inferred" | null {
  for (const fact of facts) {
    const fidelity = capabilityFor(context, fact)?.[relation] ?? "unsupported";
    if (fidelity === "unsupported") return null;
    if (fidelity === "inferred" || fact.topologyProvenance === "inferred") return "inferred";
  }
  return "stated";
}

/**
 * `kind` is deliberately narrowed to `ReducerDerivedEdgeKind`: the compiler,
 * not a convention, is what keeps a reserved edge name out of a committed graph.
 */
interface DesiredEdge {
  kind: ReducerDerivedEdgeKind;
  sourceNodeId: string;
  targetNodeId: string;
  evidenceEventIds: string[];
  provenance: "stated" | "inferred";
}

function addDesiredEdge(edges: Map<string, DesiredEdge>, edge: DesiredEdge): void {
  if (edge.sourceNodeId === edge.targetNodeId) return;
  edge.evidenceEventIds = [...new Set(edge.evidenceEventIds)].sort();
  const key = `${edge.kind}\0${edge.sourceNodeId}\0${edge.targetNodeId}`;
  const previous = edges.get(key);
  if (!previous) {
    edges.set(key, edge);
    return;
  }
  previous.evidenceEventIds = [
    ...new Set([...previous.evidenceEventIds, ...edge.evidenceEventIds]),
  ].sort();
  if (edge.provenance === "inferred") previous.provenance = "inferred";
}

function nodeDerivedFields(
  anchor: NodeAnchor,
  registeredArtifactIds: ReadonlySet<string>,
): Pick<ReducerNode, "status" | "primaryAgentId" | "participantAgentIds" | "artifactIds"> {
  const participantAgentIds = [
    ...new Set(anchor.facts.flatMap((fact) => (fact.agentId ? [fact.agentId] : []))),
  ].sort();
  const artifactIds = [
    ...new Set(
      anchor.facts.flatMap((fact) =>
        fact.artifactRefs.filter((id) => registeredArtifactIds.has(id)),
      ),
    ),
  ].sort();
  const hasError = anchor.facts.some((fact) => fact.status === "error");
  const hasCompletion = anchor.facts.some(
    (fact) => fact.kind === "trace_complete" || fact.kind === "agent_end",
  );
  return {
    status:
      anchor.node.kind === "issue" && hasError
        ? "blocked"
        : anchor.node.kind === "result" && hasCompletion
          ? "completed"
          : "active",
    primaryAgentId: anchor.facts.find((fact) => fact.agentId)?.agentId ?? null,
    participantAgentIds,
    artifactIds,
  };
}

function parentFor(
  anchor: NodeAnchor,
  anchors: readonly NodeAnchor[],
  facts: readonly ReducerRawFact[],
): string | null {
  if (anchor.node.pinnedByHuman) return anchor.node.primaryParentId;
  if (anchor.lane) {
    const prior = anchors
      .filter(
        (candidate) =>
          candidate !== anchor &&
          candidate.lane === anchor.lane &&
          candidate.endSeq < anchor.startSeq,
      )
      .sort((left, right) =>
        left.endSeq === right.endSeq
          ? compareNodeId(left, right)
          : left.endSeq > right.endSeq
            ? -1
            : 1,
      )[0];
    if (prior) return prior.node.logicalNodeId;
  }
  const childStart = anchor.lane
    ? facts.find(
        (fact) =>
          fact.kind === "agent_start" &&
          fact.agentId === anchor.lane &&
          Boolean(fact.parentAgentId),
      )
    : undefined;
  const parentAgentId = childStart?.parentAgentId;
  if (parentAgentId) {
    const dispatchFact = facts.find(
      (fact) =>
        fact.agentId === parentAgentId &&
        fact.sourceKind === childStart.sourceKind &&
        fact.adapterVersion === childStart.adapterVersion &&
        ((childStart.parentSpanId !== null && fact.spanId === childStart.parentSpanId) ||
          fact.spawnedAgentIds?.includes(anchor.lane ?? "")),
    );
    if (dispatchFact) {
      const exact = outboundEndpoint(anchors, parentAgentId, dispatchFact);
      if (exact) return exact.node.logicalNodeId;
    }
    const parent = anchors
      .filter(
        (candidate) => candidate.lane === parentAgentId && candidate.endSeq <= anchor.startSeq,
      )
      .sort((left, right) =>
        left.endSeq === right.endSeq
          ? compareNodeId(left, right)
          : left.endSeq > right.endSeq
            ? -1
            : 1,
      )[0];
    if (parent) return parent.node.logicalNodeId;
  }
  const request = anchors
    .filter((candidate) => candidate.node.kind === "request")
    .sort((left, right) =>
      left.startSeq === right.startSeq
        ? compareNodeId(left, right)
        : left.startSeq < right.startSeq
          ? -1
          : 1,
    )[0];
  return request?.node.logicalNodeId ?? null;
}

export function deriveTopology(
  current: ReducerGraphState,
  context: ReducerTopologyContext,
): TopologyDerivationResult {
  const facts = orderedFacts(context);
  const nodes = current.nodes.map((node) => ({
    ...node,
    claims: node.claims.map((item) => ({ ...item, evidenceEventIds: [...item.evidenceEventIds] })),
    participantAgentIds: [...node.participantAgentIds],
    artifactIds: [...node.artifactIds],
    layout: node.layout ? { ...node.layout } : null,
  }));
  let anchors = buildAnchors(nodes, facts);
  const changedNodeIds = new Set<string>();

  for (const anchor of anchors) {
    if (anchor.node.pinnedByHuman) continue;
    const derived = nodeDerivedFields(anchor, context.registeredArtifactIds);
    const primaryParentId = parentFor(anchor, anchors, facts);
    const persisted = { ...derived, primaryParentId };
    if (
      anchor.node.status === derived.status &&
      anchor.node.primaryAgentId === derived.primaryAgentId &&
      anchor.node.primaryParentId === primaryParentId &&
      canonicalJson(anchor.node.participantAgentIds) ===
        canonicalJson(derived.participantAgentIds) &&
      canonicalJson(anchor.node.artifactIds) === canonicalJson(derived.artifactIds)
    )
      continue;
    Object.assign(anchor.node, persisted, {
      versionId: deterministicUuid(
        "semantic-node-derived-version",
        anchor.node.versionId + canonicalJson(persisted),
      ),
    });
    changedNodeIds.add(anchor.node.logicalNodeId);
  }
  anchors = buildAnchors(nodes, facts);

  const desired = new Map<string, DesiredEdge>();

  // Spawn edges.
  const seenChildLanes = new Set<string>();
  for (const childStart of facts.filter(
    (fact) => fact.kind === "agent_start" && fact.agentId && fact.parentAgentId,
  )) {
    const childLane = childStart.agentId!;
    if (seenChildLanes.has(childLane)) continue;
    seenChildLanes.add(childLane);
    const parentFact = facts.find(
      (fact) =>
        fact.agentId === childStart.parentAgentId &&
        fact.sourceKind === childStart.sourceKind &&
        fact.adapterVersion === childStart.adapterVersion &&
        ((childStart.parentSpanId !== null && fact.spanId === childStart.parentSpanId) ||
          fact.spawnedAgentIds?.includes(childLane)),
    );
    if (!parentFact) continue;
    // `passthrough` sources reach this point only through the structured
    // `parentSpanId`/`spawnedAgentIds` match required above, so no extra gate
    // is needed here; `structuralProvenance` still rejects `unsupported`.
    const provenance = structuralProvenance("spawn", context, [parentFact, childStart]);
    const source = outboundEndpoint(anchors, childStart.parentAgentId ?? null, parentFact);
    const target = laneFirst(anchors, childLane);
    if (!provenance || !source || !target) continue;
    addDesiredEdge(desired, {
      kind: "decomposes_to",
      sourceNodeId: source.node.logicalNodeId,
      targetNodeId: target.node.logicalNodeId,
      evidenceEventIds: [parentFact.eventId, childStart.eventId],
      provenance,
    });
  }

  // Join edges.
  const pairedEnds = new Set<string>();
  for (const result of facts.filter(
    (fact) => fact.kind === "tool_result" && fact.joinedAgentIds?.length,
  )) {
    for (const childLane of result.joinedAgentIds ?? []) {
      const childEnd = [...facts]
        .filter(
          (fact) =>
            fact.kind === "agent_end" &&
            fact.agentId === childLane &&
            BigInt(fact.ingestSeq) <= BigInt(result.ingestSeq) &&
            !pairedEnds.has(fact.eventId),
        )
        .sort((left, right) => (BigInt(left.ingestSeq) > BigInt(right.ingestSeq) ? -1 : 1))[0];
      if (!childEnd) continue;
      pairedEnds.add(childEnd.eventId);
      const provenance = structuralProvenance("join", context, [childEnd, result]);
      const source = laneLast(anchors, childLane);
      const target = inboundEndpoint(anchors, result.agentId, result);
      if (!provenance || !source || !target) continue;
      addDesiredEdge(desired, {
        kind: "hands_off_to",
        sourceNodeId: source.node.logicalNodeId,
        targetNodeId: target.node.logicalNodeId,
        evidenceEventIds: [childEnd.eventId, result.eventId],
        provenance,
      });
    }
  }

  // Peer-message edges.
  const seenMessages = new Set<string>();
  for (const message of facts.filter(
    (fact) =>
      fact.senderAgentId && fact.recipientAgentId && fact.senderAgentId !== fact.recipientAgentId,
  )) {
    const identity =
      message.messageId ??
      `${message.sourceKind}\0${message.adapterVersion}\0${message.sourceEventId}`;
    if (seenMessages.has(identity)) continue;
    seenMessages.add(identity);
    const provenance = structuralProvenance("peerMessages", context, [message]);
    const source = outboundEndpoint(anchors, message.senderAgentId!, message);
    const target = inboundEndpoint(anchors, message.recipientAgentId!, message);
    if (!provenance || !source || !target) continue;
    addDesiredEdge(desired, {
      kind: "hands_off_to",
      sourceNodeId: source.node.logicalNodeId,
      targetNodeId: target.node.logicalNodeId,
      evidenceEventIds: [message.eventId],
      provenance,
    });
  }

  // Produces and depends_on require an explicit producer fact and registered artifact membership.
  for (const write of facts.filter(
    (fact) =>
      fact.kind === "file_write" &&
      fact.onBehalfOf &&
      fact.artifactRefs.some((id) => context.registeredArtifactIds.has(id)),
  )) {
    const producer = outboundEndpoint(anchors, write.agentId, write);
    const beneficiary = anchors
      .filter(
        (anchor) =>
          anchor.lane === write.onBehalfOf &&
          anchor.node.artifactIds.some(
            (id) => write.artifactRefs.includes(id) && context.registeredArtifactIds.has(id),
          ),
      )
      .sort((left, right) =>
        left.startSeq === right.startSeq
          ? compareNodeId(left, right)
          : left.startSeq < right.startSeq
            ? -1
            : 1,
      )[0];
    if (!producer || !beneficiary) continue;
    const provenance = write.topologyProvenance === "inferred" ? "inferred" : "stated";
    addDesiredEdge(desired, {
      kind: "produces",
      sourceNodeId: producer.node.logicalNodeId,
      targetNodeId: beneficiary.node.logicalNodeId,
      evidenceEventIds: [write.eventId],
      provenance,
    });
    const producedArtifacts = producer.node.artifactIds.filter(
      (id) => write.artifactRefs.includes(id) && context.registeredArtifactIds.has(id),
    );
    if (producedArtifacts.length === 0) continue;
    for (const consumer of anchors.filter(
      (anchor) =>
        anchor !== producer && anchor.node.artifactIds.some((id) => producedArtifacts.includes(id)),
    )) {
      addDesiredEdge(desired, {
        kind: "depends_on",
        sourceNodeId: consumer.node.logicalNodeId,
        targetNodeId: producer.node.logicalNodeId,
        evidenceEventIds: [write.eventId],
        provenance,
      });
    }
  }

  // Blocks edges.
  for (const failure of facts.filter(
    (fact) => fact.kind === "tool_result" && fact.status === "error",
  )) {
    const issue = exactAnchor(anchors, failure);
    if (!issue || issue.node.kind !== "issue" || !issue.lane) continue;
    const next = anchors
      .filter((anchor) => anchor.lane === issue.lane && anchor.startSeq > issue.endSeq)
      .sort((left, right) =>
        left.startSeq === right.startSeq
          ? compareNodeId(left, right)
          : left.startSeq < right.startSeq
            ? -1
            : 1,
      )[0];
    if (!next) continue;
    addDesiredEdge(desired, {
      kind: "blocks",
      sourceNodeId: issue.node.logicalNodeId,
      targetNodeId: next.node.logicalNodeId,
      evidenceEventIds: [failure.eventId],
      provenance: failure.topologyProvenance === "inferred" ? "inferred" : "stated",
    });
  }

  const desiredEdges = [...desired.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.sourceNodeId.localeCompare(right.sourceNodeId) ||
      left.targetNodeId.localeCompare(right.targetNodeId),
  );
  const currentByLogicalId = new Map(current.edges.map((edge) => [edge.logicalEdgeId, edge]));
  const desiredLogicalIds = new Set<string>();
  const edges: ReducerEdge[] = [];
  const changedEdgeIds = new Set<string>();

  for (const edge of desiredEdges) {
    const logicalEdgeId = deterministicUuid(
      "semantic-edge-logical",
      `${context.traceId}\0${edge.kind}\0${edge.sourceNodeId}\0${edge.targetNodeId}`,
    );
    desiredLogicalIds.add(logicalEdgeId);
    const previous = currentByLogicalId.get(logicalEdgeId);
    const versionValue = canonicalJson({
      logicalEdgeId,
      retired: false,
      provenance: edge.provenance,
      evidenceEventIds: edge.evidenceEventIds,
    });
    const versionId = deterministicUuid("semantic-edge-derived-version", versionValue);
    if (previous && !previous.retired && previous.versionId === versionId) {
      edges.push({ ...previous, evidenceEventIds: [...previous.evidenceEventIds] });
    } else {
      edges.push({ ...edge, logicalEdgeId, versionId, retired: false });
      changedEdgeIds.add(logicalEdgeId);
    }
  }
  for (const previous of current.edges) {
    if (desiredLogicalIds.has(previous.logicalEdgeId)) continue;
    if (previous.retired) {
      edges.push({ ...previous, evidenceEventIds: [...previous.evidenceEventIds] });
      continue;
    }
    const retired = {
      ...previous,
      retired: true,
      evidenceEventIds: [...previous.evidenceEventIds].sort(),
    };
    retired.versionId = deterministicUuid(
      "semantic-edge-derived-version",
      canonicalJson({
        logicalEdgeId: retired.logicalEdgeId,
        retired: true,
        provenance: retired.provenance,
        evidenceEventIds: retired.evidenceEventIds,
      }),
    );
    edges.push(retired);
    changedEdgeIds.add(previous.logicalEdgeId);
  }
  edges.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.sourceNodeId.localeCompare(right.sourceNodeId) ||
      left.targetNodeId.localeCompare(right.targetNodeId) ||
      left.logicalEdgeId.localeCompare(right.logicalEdgeId),
  );
  return {
    state: { nodes, edges },
    changedNodeIds: [...changedNodeIds].sort(),
    changedEdgeIds: [...changedEdgeIds].sort(),
    diagnostics: [],
  };
}

export function applyProviderPatch(
  input: unknown,
  current: ReducerGraphState,
  context: PatchValidationContext,
  topologyContext?: ReducerTopologyContext,
): PatchApplyResult {
  const validation = validateProviderPatch(input, context);
  if (!validation.ok) return validation;
  const patch = validation.patch;
  const nodes = current.nodes.map((node) => ({
    ...node,
    claims: node.claims.map((claim) => ({
      ...claim,
      evidenceEventIds: [...claim.evidenceEventIds],
    })),
    participantAgentIds: [...node.participantAgentIds],
    artifactIds: [...node.artifactIds],
    layout: node.layout ? { ...node.layout } : null,
  }));
  const edges = current.edges.map((edge) => ({
    ...edge,
    evidenceEventIds: [...edge.evidenceEventIds],
  }));
  const changedNodeIds = new Set<string>();
  const diagnostics = [...patch.diagnostics];

  for (const operation of patch.operations) {
    if (operation.op === "add_node") {
      const logicalNodeId = deterministicUuid(patch.jobNonce, `node:${operation.ref}`);
      nodes.push({
        logicalNodeId,
        versionId: deterministicUuid(patch.jobNonce, `node-version:${operation.ref}`),
        kind: operation.node.kind,
        status: "active",
        title: operation.node.title,
        claims: operation.node.claims.map(canonicalClaim),
        primaryParentId: null,
        primaryAgentId: null,
        participantAgentIds: [],
        artifactIds: [],
        pinnedByHuman: false,
        startedAt: null,
        endedAt: null,
        layout: null,
      });
      changedNodeIds.add(logicalNodeId);
      continue;
    }
    if (operation.op === "update_node") {
      const index = nodes.findIndex((node) => node.logicalNodeId === operation.ref);
      const previous = nodes[index];
      if (!previous) continue;
      nodes[index] = {
        ...previous,
        versionId: deterministicUuid(
          "semantic-node-provider-version",
          previous.versionId + canonicalJson(operation.set),
        ),
        kind: operation.set.kind ?? previous.kind,
        title: operation.set.title ?? previous.title,
        claims: operation.set.claims?.map(canonicalClaim) ?? previous.claims,
      };
      changedNodeIds.add(operation.ref);
      continue;
    }
    diagnostics.push(
      `merge suggestion retained for human review: ${operation.mergedNodeIds.join(",")}`,
    );
  }

  if (!topologyContext) {
    return {
      ok: true,
      patch,
      state: { nodes, edges },
      changedNodeIds: [...changedNodeIds].sort(),
      changedEdgeIds: [],
      diagnostics,
    };
  }
  const derived = deriveTopology({ nodes, edges }, topologyContext);
  return {
    ok: true,
    patch,
    state: derived.state,
    changedNodeIds: [...new Set([...changedNodeIds, ...derived.changedNodeIds])].sort(),
    changedEdgeIds: derived.changedEdgeIds,
    diagnostics: [...diagnostics, ...derived.diagnostics],
  };
}
