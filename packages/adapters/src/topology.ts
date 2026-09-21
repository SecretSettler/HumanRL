import type { TopologyCapability, TopologyFidelity, TraceSourceKind } from "@intenttrace/schema";

interface TopologyDeclarationEntry {
  sourceKind: TraceSourceKind;
  adapterVersion: string | "*";
  capability: TopologyCapability;
}

const declarations: readonly TopologyDeclarationEntry[] = [
  {
    sourceKind: "codex",
    adapterVersion: "3.0.0",
    capability: {
      spawn: "stated",
      join: "stated",
      peerMessages: "stated",
      input: "bundle",
      laneKey: "session_meta.payload.id",
      limits: [
        "Full-history forks duplicate ancestor records and require payload-hash deduplication.",
        "Paginated history may omit persisted sub_agent_activity, so affected spawn facts are inferred or absent.",
        "Collaboration message bodies are encrypted and unavailable.",
      ],
    },
  },
  {
    sourceKind: "claude",
    adapterVersion: "3.0.0",
    capability: {
      spawn: "stated",
      join: "stated",
      peerMessages: "inferred",
      input: "bundle",
      laneKey: "agentId",
      limits: [
        "Workflow sidecars without toolUseId cannot be linked to a parent turn.",
        "Peer-message sender identity is inferred by pairing sender and recipient records.",
        "Async task notifications may repeat and require task-id/tool-use-id deduplication.",
      ],
    },
  },
  {
    sourceKind: "opencode",
    adapterVersion: "1.0.0",
    capability: {
      spawn: "stated",
      join: "stated",
      peerMessages: "unsupported",
      input: "bundle",
      laneKey: "session.id",
      limits: [
        "The SQLite WAL is required for uncheckpointed sessions.",
        "Failed task spawns may omit the child session id.",
        "Truncated task outputs require the referenced overflow part.",
      ],
    },
  },
  {
    sourceKind: "grok",
    adapterVersion: "1.0.0",
    capability: {
      spawn: "stated",
      join: "stated",
      peerMessages: "unsupported",
      input: "bundle",
      laneKey: "resumed_from chain root",
      limits: [
        "parent_prompt_id is optional; missing values leave parentSpanId empty.",
        "Logical lanes collapse resumed_from session chains.",
        "Agent structure is carried by vendor session/update records.",
      ],
    },
  },
  {
    sourceKind: "omp",
    adapterVersion: "1.0.0",
    capability: {
      spawn: "inferred",
      join: "stated",
      peerMessages: "stated",
      input: "bundle",
      laneKey: "agent name (file basename)",
      limits: [
        "Spawn parentage is inferred from bundle layout and agent-name equality.",
        "Spawn toolCallId is absent from child sessions, so parentSpanId is empty.",
        "Long outputs and blobs require explicitly supplied companion parts.",
      ],
    },
  },
  {
    sourceKind: "pi",
    adapterVersion: "*",
    capability: {
      spawn: "unsupported",
      join: "unsupported",
      peerMessages: "unsupported",
      input: "single-file",
      laneKey: "session.id",
      limits: [
        "Default Pi has no structural subagent capability; bash launches and parentSession forks are not spawn facts.",
      ],
    },
  },
  {
    sourceKind: "jsonl",
    adapterVersion: "1.0.0",
    capability: {
      spawn: "passthrough",
      join: "passthrough",
      peerMessages: "passthrough",
      input: "single-file",
      laneKey: "agentId",
      limits: [
        "Topology requires explicit canonical fields; passthrough never infers a missing relationship.",
      ],
    },
  },
  {
    sourceKind: "otlp",
    adapterVersion: "1.0.0",
    capability: {
      spawn: "passthrough",
      join: "passthrough",
      peerMessages: "unsupported",
      input: "single-file",
      laneKey: "service.name",
      limits: [
        "Spawn and join require explicit canonical topology attributes; peer messages are unsupported.",
      ],
    },
  },
];

const sourceShapes: Record<TraceSourceKind, Pick<TopologyCapability, "input" | "laneKey">> = {
  jsonl: { input: "single-file", laneKey: "agentId" },
  otlp: { input: "single-file", laneKey: "service.name" },
  codex: { input: "bundle", laneKey: "session_meta.payload.id" },
  claude: { input: "bundle", laneKey: "agentId" },
  opencode: { input: "bundle", laneKey: "session.id" },
  omp: { input: "bundle", laneKey: "agent name (file basename)" },
  grok: { input: "bundle", laneKey: "resumed_from chain root" },
  pi: { input: "single-file", laneKey: "session.id" },
  custom: { input: "single-file", laneKey: "custom" },
};
const copy = (value: TopologyCapability): TopologyCapability => ({
  ...value,
  limits: [...value.limits],
});

export function lookupTopologyCapability(
  sourceKind: TraceSourceKind,
  adapterVersion: string,
): TopologyCapability {
  const entry =
    declarations.find(
      (candidate) =>
        candidate.sourceKind === sourceKind && candidate.adapterVersion === adapterVersion,
    ) ??
    declarations.find(
      (candidate) => candidate.sourceKind === sourceKind && candidate.adapterVersion === "*",
    );
  if (entry) return copy(entry.capability);
  return {
    spawn: "unsupported",
    join: "unsupported",
    peerMessages: "unsupported",
    ...sourceShapes[sourceKind],
    limits: [`No topology declaration for ${sourceKind}@${adapterVersion}`],
  };
}

function aggregate(values: readonly TopologyFidelity[]): TopologyFidelity {
  if (values.some((value) => value === "unsupported")) return "unsupported";
  const first = values[0];
  return first !== undefined &&
    values.every((value) => value === first) &&
    (first === "stated" || first === "passthrough")
    ? first
    : "inferred";
}

export function aggregateTopologyCapabilities(
  sources: readonly { sourceKind: TraceSourceKind; adapterVersion: string }[],
): TopologyCapability {
  const distinct = sources.filter(
    (source, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.sourceKind === source.sourceKind &&
          candidate.adapterVersion === source.adapterVersion,
      ) === index,
  );
  if (distinct.length === 0)
    return {
      spawn: "unsupported",
      join: "unsupported",
      peerMessages: "unsupported",
      input: "single-file",
      laneKey: "mixed",
      limits: [],
    };
  if (distinct.length === 1)
    return lookupTopologyCapability(distinct[0]!.sourceKind, distinct[0]!.adapterVersion);
  const values = distinct.map((source) => ({
    ...source,
    capability: lookupTopologyCapability(source.sourceKind, source.adapterVersion),
  }));
  return {
    spawn: aggregate(values.map(({ capability }) => capability.spawn)),
    join: aggregate(values.map(({ capability }) => capability.join)),
    peerMessages: aggregate(values.map(({ capability }) => capability.peerMessages)),
    input: values.some(({ capability }) => capability.input === "bundle")
      ? "bundle"
      : "single-file",
    laneKey: "mixed",
    limits: values
      .flatMap(({ sourceKind, adapterVersion, capability }) =>
        capability.limits.map((limit) => `${sourceKind}@${adapterVersion}: ${limit}`),
      )
      .filter((limit, index, all) => all.indexOf(limit) === index)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  };
}
