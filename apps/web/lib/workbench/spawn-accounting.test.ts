import { describe, expect, it } from "vitest";

import { accountSpawns, estimateTokens, promptTokensOf, rootAgentOf } from "./spawn-accounting";
import { StoryEvents } from "./story-test-events";

describe("prompt helpers", () => {
  it("takes the root lane from the author's first prompt", () => {
    const s = new StoryEvents();
    s.push("user_message", "User · <environment_context>cwd</environment_context>", "harness");
    s.user("Fix the one failing unit test in packages/schema");
    expect(rootAgentOf(s.events)).toBe("Orchestrator");
  });

  it("counts CJK prompts near one token per character", () => {
    const s = new StoryEvents();
    const prompt = s.user("帮我使用 subagent 解决一个 IMO bench 中的数学题");
    // 14 Han characters plus ~20 Latin characters: well above the 4-chars-per-token floor of 11.
    expect(promptTokensOf(prompt)).toBeGreaterThanOrEqual(18);
    expect(estimateTokens("abcd")).toBe(1);
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
