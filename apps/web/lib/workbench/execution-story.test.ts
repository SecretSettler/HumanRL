import { describe, expect, it } from "vitest";

import {
  buildExecutionStory,
  describeToolCall,
  pairToolResults,
  splitName,
  storyTotals,
} from "./execution-story";
import { StoryEvents } from "./story-test-events";

describe("splitName / describeToolCall", () => {
  it("reads the tool and the human description out of the adapter name", () => {
    const s = new StoryEvents();
    const call = s.read("Orchestrator", "Reading parallel dispatch skill");
    expect(splitName(call.name)).toEqual({
      head: "Tool call: read",
      detail: "Reading parallel dispatch skill",
    });
    expect(describeToolCall(call)).toEqual({
      tool: "read",
      action: "Reading parallel dispatch skill",
    });
  });

  it("falls back to the kind when the name carries no description", () => {
    const s = new StoryEvents();
    const call = s.push("file_read", "read", "Orchestrator");
    expect(describeToolCall(call)).toEqual({ tool: "read", action: "读取文件" });
  });
});

describe("pairToolResults", () => {
  it("matches results FIFO inside the same lane and tool, like the canonical demo", () => {
    const s = new StoryEvents();
    const a = s.read("Orchestrator", "Reading skill A");
    const b = s.read("Orchestrator", "Reading skill B");
    const other = s.read("Scout", "Reading something else");
    const ra = s.result("Orchestrator", "read", "contents of A");
    const rb = s.result("Orchestrator", "read", "contents of B");
    const paired = pairToolResults(s.events);
    expect(paired.get(a.id)?.id).toBe(ra.id);
    expect(paired.get(b.id)?.id).toBe(rb.id);
    expect(paired.get(other.id)).toBeNull();
  });

  it("prefers an explicit causation link when the adapter provides one", () => {
    const s = new StoryEvents();
    const first = s.call("Orchestrator", "eval", "first");
    const second = s.call("Orchestrator", "eval", "second");
    const resultForSecond = s.result("Orchestrator", "eval", "done", false);
    resultForSecond.causationEventId = second.id;
    const paired = pairToolResults(s.events);
    expect(paired.get(second.id)?.id).toBe(resultForSecond.id);
    expect(paired.get(first.id)).toBeNull();
  });
});

describe("buildExecutionStory", () => {
  it("collapses consecutive same-tool calls per lane and keeps spawns and joins as steps", () => {
    const s = new StoryEvents();
    s.user("帮我用 subagent 并发解一道 IMO 题");
    s.modelCall("Orchestrator", 3);
    s.read("Orchestrator", "Reading dispatch skill");
    s.read("Orchestrator", "Reading plan skill");
    s.result("Orchestrator", "read", "skill A");
    s.result("Orchestrator", "read", "skill B");
    s.spawn("Orchestrator", "Running parallel solve", ["ImoBruteForce", "ImoConstructions"]);
    s.start("ImoBruteForce", "brute force");
    s.start("ImoConstructions", "constructions");
    s.assignment("ImoBruteForce", "Deliverable: brute force");
    s.read("ImoBruteForce", "Reading problem");
    s.call("ImoConstructions", "eval", "Attempting python verifier");
    s.result("ImoConstructions", "eval", "Tool eval not found", true);
    s.result("ImoBruteForce", "read", "problem text");
    s.end("ImoConstructions");

    const steps = buildExecutionStory(s.events);
    expect(steps.map((step) => step.kind)).toEqual([
      "message",
      "tools",
      "spawn",
      "tools",
      "tools",
      "join",
    ]);

    const orchestratorReads = steps[1];
    if (orchestratorReads?.kind !== "tools") throw new Error("expected tools step");
    expect(orchestratorReads.tool).toBe("read");
    expect(orchestratorReads.calls.map((call) => call.action)).toEqual([
      "Reading dispatch skill",
      "Reading plan skill",
    ]);
    expect(orchestratorReads.calls.every((call) => call.status === "completed")).toBe(true);

    const spawn = steps[2];
    if (spawn?.kind !== "spawn") throw new Error("expected spawn step");
    expect(spawn.childAgentIds).toEqual(["ImoBruteForce", "ImoConstructions"]);
    expect(spawn.label).toBe("Running parallel solve");

    const evalStep = steps[4];
    if (evalStep?.kind !== "tools") throw new Error("expected tools step");
    expect(evalStep.agentId).toBe("ImoConstructions");
    expect(evalStep.calls[0]?.status).toBe("failed");

    expect(storyTotals(steps)).toEqual({
      toolCalls: 4,
      failed: 1,
      running: 0,
      spawns: 1,
      spawnedAgents: 2,
    });
  });

  it("does not merge a lane's tool run across a different tool", () => {
    const s = new StoryEvents();
    s.read("Scout", "a");
    s.call("Scout", "grep", "b");
    s.read("Scout", "c");
    const steps = buildExecutionStory(s.events);
    expect(steps.map((step) => (step.kind === "tools" ? step.tool : step.kind))).toEqual([
      "read",
      "grep",
      "read",
    ]);
  });
});
