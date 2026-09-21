import { describe, expect, it } from "vitest";

import { evaluatePromptOptimization } from "./prompt-optimizer";
import { reviewPrompt } from "./prompt-review";
import { StoryEvents } from "./story-test-events";

function review(s: StoryEvents) {
  const optimization = evaluatePromptOptimization({ events: s.events });
  return reviewPrompt({ events: s.events, optimization });
}

function ids(findings: { id: string }[]): string[] {
  return findings.map((finding) => finding.id);
}

describe("reviewPrompt", () => {
  it("returns no findings without a user prompt", () => {
    const s = new StoryEvents();
    s.read("Orchestrator", "Reading something");
    const result = review(s);
    expect(result.promptEvent).toBeNull();
    expect(result.findings).toEqual([]);
  });

  it("flags tools that were reached for but do not exist, with the lanes and calls as evidence", () => {
    const s = new StoryEvents();
    s.user("Solve this and verify with python, use subagents for the parts that are independent");
    s.spawn("Orchestrator", "Solve in parallel", ["A", "B"]);
    s.start("A", "constructions");
    s.start("B", "impossibility");
    const a1 = s.call("A", "eval", "Attempting python verifier");
    s.result("A", "eval", "Tool eval not found", true);
    s.call("B", "bash", "Probing bash tool availability");
    s.result("B", "bash", "Tool bash not found", true);
    s.call("A", "eval", "Retrying python verifier");
    s.result("A", "eval", "Tool eval not found", true);
    const result = review(s);
    const finding = result.findings.find((item) => item.id === "missing-tools");
    if (!finding) throw new Error("expected missing-tools finding");
    expect(finding.severity).toBe("high");
    expect(finding.title).toBe("Agents reached for 2 tools that do not exist: eval and bash");
    expect(finding.detail).toContain("3 calls failed");
    expect(finding.detail).toContain("A and B");
    expect(finding.eventIds).toHaveLength(3);
    expect(finding.eventIds).not.toContain(a1.id);
  });

  it("flags a prompt the orchestrator had to expand into much larger task assignments", () => {
    const s = new StoryEvents();
    s.user("Solve an IMO problem with subagents");
    s.modelCall("Orchestrator", 2);
    s.read("Orchestrator", "Reading dispatch skill");
    s.result("Orchestrator", "read", "skill");
    s.modelCall("Orchestrator", 1);
    s.spawn("Orchestrator", "Solve", ["A", "B"]);
    s.start("A", "solver");
    s.start("B", "checker");
    const a = s.assignment(
      "A",
      "Deliverable: local://a.md. Slice: settle the answer set for small n by exhaustive search; report the cover count per n; stop when n=6 is done.",
    );
    s.assignment(
      "B",
      "Deliverable: local://b.md. Slice: prove impossibility for k outside the claimed set; cite each lemma; stop when the proof is checked.",
    );
    const result = review(s);
    const finding = result.findings.find((item) => item.id === "short-prompt");
    if (!finding) throw new Error("expected short-prompt finding");
    expect(finding.title).toMatch(
      /^Prompt is ~\d+ tokens; the orchestrator wrote ~\d+ tokens of task assignments/u,
    );
    expect(finding.detail).toContain("2 turns and 1 read");
    expect(finding.eventIds[0]).toBe(a.id);
  });

  it("falls back to planning turns when there are no assignments to compare against", () => {
    const s = new StoryEvents();
    s.user("Solve an IMO problem");
    s.modelCall("Orchestrator", 1);
    s.modelCall("Orchestrator", 1);
    s.modelCall("Orchestrator", 1);
    s.read("Orchestrator", "Reading the problem");
    const finding = review(s).findings.find((item) => item.id === "short-prompt");
    if (!finding) throw new Error("expected short-prompt finding");
    expect(finding.title).toMatch(/the orchestrator spent 3 turns and 1 read/u);
  });

  it("does not flag planning when the prompt already carries the task", () => {
    const s = new StoryEvents();
    s.user(
      "Deliverable: a markdown proof at local://proof.md. Constraints: no external tools, pure reasoning, cite each lemma. Stop when the verifier lane agrees. Split into constructions, impossibility and brute force lanes, then a writeup lane that joins them into one document.",
    );
    s.modelCall("Orchestrator", 2);
    s.modelCall("Orchestrator", 1);
    s.modelCall("Orchestrator", 1);
    s.spawn("Orchestrator", "Solve", ["A"]);
    s.start("A", "solver");
    expect(ids(review(s).findings)).not.toContain("short-prompt");
  });

  it("uses the payload size when the name preview is truncated", () => {
    const s = new StoryEvents();
    const prompt = s.user("Short preview of a long prompt");
    prompt.payloadRef = {
      artifactId: "00000000-0000-4000-8000-0000000000ff",
      sha256: "0".repeat(64),
      byteLength: 2_011,
    };
    s.modelCall("Orchestrator", 1);
    s.modelCall("Orchestrator", 1);
    s.modelCall("Orchestrator", 1);
    s.spawn("Orchestrator", "Solve", ["A"]);
    const result = review(s);
    expect(result.promptTokens).toBe(500);
    expect(ids(result.findings)).not.toContain("short-prompt");
  });

  it("reports spawn waves that did not pay off and, when all did, confirms the delegation", () => {
    const good = new StoryEvents();
    good.user("Do it in parallel");
    good.spawn("Orchestrator", "Heavy research", ["A", "B"]);
    good.start("A", "a");
    good.start("B", "b");
    for (let index = 0; index < 8; index += 1) {
      good.read("A", `Reading ${index}`);
      good.result("A", "read", "…");
      good.read("B", `Scanning ${index}`);
      good.result("B", "read", "…");
    }
    good.end("A");
    good.end("B");
    const confirmed = review(good).findings;
    expect(ids(confirmed)).toContain("dispatch-paid-off");
    expect(ids(confirmed)).not.toContain("poor-spawns");

    const bad = new StoryEvents();
    bad.user("Do it in parallel");
    bad.spawn("Orchestrator", "Overkill", ["A"]);
    bad.start("A", "a");
    bad.modelCall("A", 0);
    bad.end("A");
    const flagged = review(bad).findings;
    const finding = flagged.find((item) => item.id === "poor-spawns");
    if (!finding) throw new Error("expected poor-spawns finding");
    expect(finding.title).toBe("1 spawn wave did not pay for the fresh context");
    expect(finding.detail).toContain('"Overkill"');
    expect(ids(flagged)).not.toContain("dispatch-paid-off");
  });

  it("notices one wave taking most of the delegated work", () => {
    const s = new StoryEvents();
    s.user("Solve the math problem; also check the repo");
    s.spawn("Orchestrator", "Math", ["M"]);
    s.spawn("Orchestrator", "Repo scouting", ["R"]);
    s.start("M", "math");
    s.start("R", "scout");
    s.read("M", "Reading problem");
    s.result("M", "read", "…");
    for (let index = 0; index < 20; index += 1) {
      s.read("R", `Reading file ${index}`);
      s.result("R", "read", "…");
    }
    const finding = review(s).findings.find((item) => item.id === "dominant-wave");
    if (!finding) throw new Error("expected dominant-wave finding");
    expect(finding.title).toMatch(/^\d+% of the delegated work went to "Repo scouting"/u);
    expect(finding.severity).toBe("info");
  });

  it("flags the same action repeated across lanes", () => {
    const s = new StoryEvents();
    s.user("Two scouts");
    s.spawn("Orchestrator", "Scouts", ["A", "B"]);
    s.start("A", "a");
    s.start("B", "b");
    s.read("A", "Reading the TDD skill");
    s.read("B", "Reading the TDD skill");
    s.read("B", "Reading something only B reads");
    s.call("A", "yield", "{}");
    s.call("B", "yield", "{}");
    const finding = review(s).findings.find((item) => item.id === "overlapping-lanes");
    if (!finding) throw new Error("expected overlapping-lanes finding");
    expect(finding.title).toBe("1 action repeated in more than one lane");
    expect(finding.detail).toBe('"read · Reading the TDD skill" in A and B');
    expect(finding.eventIds).toHaveLength(2);
  });

  it("flags heavy assembly on the orchestrator after the last join", () => {
    const s = new StoryEvents();
    s.user("Parallel then assemble");
    s.spawn("Orchestrator", "Work", ["A"]);
    s.start("A", "a");
    s.end("A");
    for (let index = 0; index < 9; index += 1) s.modelCall("Orchestrator", 1);
    const finding = review(s).findings.find((item) => item.id === "post-join-assembly");
    if (!finding) throw new Error("expected post-join-assembly finding");
    expect(finding.title).toBe("The orchestrator took 9 turns after the last child joined");
    expect(finding.eventIds).toHaveLength(9);
  });
});
