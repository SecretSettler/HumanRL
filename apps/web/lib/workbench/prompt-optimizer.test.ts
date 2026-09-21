import { describe, expect, it } from "vitest";

import { accountSpawns, evaluatePromptOptimization, rootAgentOf } from "./prompt-optimizer";
import { StoryEvents } from "./story-test-events";

function quietRun(): StoryEvents {
  const s = new StoryEvents();
  s.user("Fix the one failing unit test in packages/schema and report the diff");
  s.modelCall("Orchestrator", 1);
  s.read("Orchestrator", "Reading the failing test");
  s.result("Orchestrator", "read", "test body");
  return s;
}

describe("evaluatePromptOptimization", () => {
  it("holds when the root lane shows no failure, repeat or context pressure", () => {
    const result = evaluatePromptOptimization({ events: quietRun().events });
    expect(rootAgentOf(quietRun().events)).toBe("Orchestrator");
    expect(result.decision).toBe("hold");
    expect(result.independentTasks).toBe(0);
    expect(result.expectedSavedTokens).toBe(0);
    expect(result.reasons).toEqual([
      "根 Agent 没有失败、重复或上下文压力信号，继续由当前 Agent 完成",
    ]);
  });

  it("recommends a spawn once failures and repeats outweigh a child's fixed cost", () => {
    const s = quietRun();
    for (let index = 0; index < 3; index += 1) {
      s.call("Orchestrator", "eval", "Attempting python verifier");
      s.result("Orchestrator", "eval", "Tool eval not found", true);
    }
    const result = evaluatePromptOptimization({ events: s.events });
    expect(result.toolFailures).toBe(3);
    expect(result.repeatedToolCalls).toBe(2);
    expect(result.expectedSavedTokens).toBeGreaterThanOrEqual(result.spawnCostTokens);
    expect(result.decision).toBe("spawn");
    expect(result.reasons).toContain("根 Agent 有 3 次工具失败，适合隔离到子 Agent 排查");
  });

  it("recommends a spawn when the root lane keeps accumulating model turns", () => {
    const s = quietRun();
    for (let index = 0; index < 10; index += 1) s.modelCall("Orchestrator", 1);
    const result = evaluatePromptOptimization({ events: s.events });
    expect(result.contextPressure).toBe(11);
    expect(result.decision).toBe("spawn");
  });

  it("holds once the trace is complete, however loud the signals were", () => {
    const s = quietRun();
    for (let index = 0; index < 10; index += 1) s.modelCall("Orchestrator", 1);
    s.complete();
    const result = evaluatePromptOptimization({ events: s.events });
    expect(result.traceComplete).toBe(true);
    expect(result.decision).toBe("hold");
    expect(result.reasons[0]).toMatch(/^trace 已结束/u);
  });

  it("counts CJK prompts near one token per character", () => {
    const s = new StoryEvents();
    s.user("帮我使用 subagent 解决一个 IMO bench 中的数学题");
    const result = evaluatePromptOptimization({ events: s.events });
    // 14 Han characters plus ~20 Latin characters: well above the 4-chars-per-token floor of 11.
    expect(result.promptTokens).toBeGreaterThanOrEqual(18);
  });

  it("never recommends a second spawn while children are still running", () => {
    const s = quietRun();
    for (let index = 0; index < 10; index += 1) s.modelCall("Orchestrator", 1);
    s.spawn("Orchestrator", "Scouting", ["Scout"]);
    s.start("Scout", "scout");
    const result = evaluatePromptOptimization({ events: s.events });
    expect(result.activeChildren).toBe(1);
    expect(result.decision).toBe("hold");
    expect(result.reasons[0]).toBe("已有 1 个子 Agent 在跑，先等 join，不要重复 spawn");
  });
});

describe("accountSpawns", () => {
  it("charges each child's fresh context and credits what the child lanes absorbed", () => {
    const s = new StoryEvents();
    s.user("Solve the problem with parallel subagents");
    s.modelCall("Orchestrator", 2);
    s.modelCall("Orchestrator", 1);
    s.spawn("Orchestrator", "Running real parallel IMO solve", ["A", "B"]);
    s.start("A", "brute force");
    s.start("B", "constructions");
    s.assignment("A", "Deliverable: brute force");
    s.assignment("B", "Deliverable: constructions");
    for (let index = 0; index < 6; index += 1) {
      s.read("A", `Reading file ${index}`);
      s.result("A", "read", `contents ${index}`);
      s.modelCall("A", 1);
    }
    s.call("B", "eval", "Attempting python verifier");
    s.result("B", "eval", "Tool eval not found", true);
    s.end("A");

    const [spawn] = accountSpawns(s.events);
    if (!spawn) throw new Error("expected one spawn");
    expect(spawn.parentAgentId).toBe("Orchestrator");
    expect(spawn.label).toBe("Running real parallel IMO solve");
    expect(spawn.childAgentIds).toEqual(["A", "B"]);
    expect(spawn.childrenStarted).toBe(2);
    expect(spawn.childrenJoined).toBe(1);
    expect(spawn.childToolCalls).toBe(7);
    expect(spawn.childToolResults).toBe(7);
    expect(spawn.childModelCalls).toBe(6);
    expect(spawn.childFailures).toBe(1);
    expect(spawn.parentModelCallsBefore).toBe(2);
    expect(spawn.absorbedTokens).toBe(7 * 180 + 6 * 90);
    expect(spawn.spawnCostTokens).toBeGreaterThan(2 * 240);
    expect(spawn.netTokens).toBe(spawn.absorbedTokens - spawn.spawnCostTokens);
    expect(spawn.verdict).toBe("worth");
  });

  it("marks a spawn wasteful when the children barely did anything", () => {
    const s = new StoryEvents();
    s.user("Do a small thing");
    s.spawn("Orchestrator", "Overkill", ["A"]);
    s.start("A", "helper");
    s.assignment("A", "Say hello");
    s.modelCall("A", 0);
    s.end("A");
    const [spawn] = accountSpawns(s.events);
    expect(spawn?.verdict).toBe("wasteful");
    expect(spawn?.netTokens).toBeLessThan(0);
  });

  it("keeps a spawn pending until a child has actually started", () => {
    const s = new StoryEvents();
    s.user("Plan");
    s.spawn("Orchestrator", "Not yet", ["A"]);
    const [spawn] = accountSpawns(s.events);
    expect(spawn?.verdict).toBe("pending");
  });
});
