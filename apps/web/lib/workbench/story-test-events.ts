import type { RawTraceEvent } from "./types";

/**
 * Test-only builder that produces events shaped like the canonical JSONL demo
 * (`Tool call: read · …`, `Tool result: read · …`, spawns via agent_handoff
 * with spawnedAgentIds, children via agent_start with parentAgentId).
 */
export class StoryEvents {
  private seq = 0;
  readonly events: RawTraceEvent[] = [];

  push(
    kind: RawTraceEvent["kind"],
    name: string,
    agentId: string,
    overrides: Partial<RawTraceEvent> = {},
  ): RawTraceEvent {
    this.seq += 1;
    const event = {
      id: `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`,
      traceId: "00000000-0000-4000-8000-00000000aaaa",
      workspaceId: "00000000-0000-4000-8000-00000000bbbb",
      projectId: "00000000-0000-4000-8000-00000000cccc",
      schemaVersion: "1.0.0",
      source: {
        kind: "jsonl",
        formatVersion: "1.0.0",
        adapterVersion: "1.0.0",
        sourceInstanceId: "story-test",
        sourceEventId: `${agentId}-${this.seq}`,
      },
      ingestSeq: String(this.seq),
      occurredAt: new Date(Date.UTC(2026, 8, 21, 0, 0, this.seq)).toISOString(),
      ingestedAt: new Date(Date.UTC(2026, 8, 21, 0, 0, this.seq)).toISOString(),
      kind,
      name,
      status: "ok",
      agentId,
      artifactRefs: [],
      attributes: {},
      ...overrides,
    } as RawTraceEvent;
    this.events.push(event);
    return event;
  }

  user(text: string, agentId = "Orchestrator"): RawTraceEvent {
    return this.push("user_message", `User request · ${text}`, agentId);
  }

  assignment(agentId: string, text: string, assignedBy = "Orchestrator"): RawTraceEvent {
    return this.push("user_message", `Task assignment · ${text}`, agentId, {
      attributes: { assignedBy },
    });
  }

  modelCall(agentId: string, toolCalls = 1): RawTraceEvent {
    return this.push("model_call", `Model call · model · ${toolCalls} tool call(s)`, agentId, {
      attributes: { model: "model", toolCalls },
    });
  }

  read(agentId: string, what: string): RawTraceEvent {
    return this.push("file_read", `Tool call: read · ${what}`, agentId, {
      attributes: { tool: "read" },
    });
  }

  call(agentId: string, tool: string, what: string): RawTraceEvent {
    return this.push("tool_call", `Tool call: ${tool} · ${what}`, agentId, {
      attributes: { tool },
    });
  }

  result(agentId: string, tool: string, preview: string, failed = false): RawTraceEvent {
    return this.push("tool_result", `Tool result: ${tool} · ${preview}`, agentId, {
      status: failed ? "error" : "ok",
      attributes: failed ? { tool, failed: true } : { tool },
    });
  }

  spawn(parent: string, label: string, children: string[]): RawTraceEvent {
    return this.push("agent_handoff", `Handoff: dispatch subagents · ${label}`, parent, {
      attributes: { tool: "task", spawnedAgentIds: children },
    });
  }

  start(agentId: string, role: string, parent = "Orchestrator"): RawTraceEvent {
    return this.push("agent_start", `Agent start · ${agentId} — ${role}`, agentId, {
      attributes: { parentAgentId: parent, role, assignedBy: parent },
    });
  }

  complete(agentId = "Orchestrator"): RawTraceEvent {
    return this.push("trace_complete", "Trace complete · done", agentId);
  }

  end(agentId: string, joinedBy = "Orchestrator"): RawTraceEvent {
    return this.push("agent_end", `Agent end · ${agentId} joined by ${joinedBy}`, agentId, {
      attributes: { joinedBy },
    });
  }
}
