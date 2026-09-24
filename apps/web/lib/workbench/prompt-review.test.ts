import { describe, expect, it } from "vitest";

import { accountSpawns } from "./spawn-accounting";
import { reviewPrompt, reviewTurns } from "./prompt-review";
import { StoryEvents } from "./story-test-events";

function review(s: StoryEvents) {
  return reviewPrompt({ events: s.events, spawns: accountSpawns(s.events) });
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
    expect(finding.title).toBe("Agents tried 2 tools that don't exist here: eval and bash");
    expect(finding.detail).toContain("3 calls failed");
    expect(finding.detail).toContain("A and B");
    expect(finding.eventIds).toHaveLength(3);
    expect(finding.eventIds).not.toContain(a1.id);
  });

  it("flags a prompt the main agent had to expand into much larger task assignments", () => {
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
      /^Your prompt was ~\d+ tokens; the main agent then wrote ~\d+ tokens of instructions/u,
    );
    expect(finding.detail).toContain("2 steps and 1 tool call");
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
    expect(finding.title).toMatch(/the main agent spent 3 steps and 1 tool call/u);
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
    const prompt = s.user(
      "Preview of a long prompt that the adapter cut at the name cap ".repeat(4),
    );
    prompt.name = prompt.name.slice(0, 240);
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

  it("reports subagent batches that did not pay off and, when all did, confirms them", () => {
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
    expect(finding.title).toBe("1 batch of subagents did too little to be worth starting");
    expect(finding.detail).toContain('"Overkill"');
    expect(ids(flagged)).not.toContain("dispatch-paid-off");
  });

  it("notices one batch taking most of the subagent work", () => {
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
    expect(finding.title).toMatch(/^\d+% of the subagent work went to "Repo scouting"/u);
    expect(finding.severity).toBe("info");
  });

  it("flags the same action repeated by several agents", () => {
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
    expect(finding.title).toBe("1 action was repeated by more than one agent");
    expect(finding.detail).toBe('"read · Reading the TDD skill" by A and B');
    expect(finding.eventIds).toHaveLength(2);
  });

  it("notes a long run the main agent made alone when it was not mostly lookups", () => {
    const s = new StoryEvents();
    s.push("user_message", "User · # AGENTS.md instructions for ~ <INSTRUCTIONS>", "codex");
    s.push("user_message", "User · Build a trace viewer from these two repos", "codex");
    for (let index = 0; index < 22; index += 1) {
      s.push("tool_call", `Tool call: exec · cmd:"ls ${index}"`, "codex", {
        attributes: { toolName: "exec" },
      });
      s.push("tool_result", "Tool result: exec · Script completed", "codex", {
        attributes: { toolName: "exec" },
      });
    }
    s.push("assistant_message", "Assistant · Done.", "codex");
    const result = review(s);
    expect(result.promptPreview).toBe("Build a trace viewer from these two repos");
    const finding = result.findings.find((item) => item.id === "long-solo-run");
    if (!finding) throw new Error("expected long-solo-run finding");
    expect(finding.severity).toBe("info");
    expect(finding.title).toBe(
      "The main agent made 22 tool calls on its own for this prompt (22 exec)",
    );
    expect(finding.eventIds).toHaveLength(22);
    expect(ids(result.findings)).not.toContain("lookups-in-main-agent");
  });

  it("suggests subagents when the main agent did a pile of lookups itself", () => {
    const s = new StoryEvents();
    s.user("Compare the most used multi-agent coding frameworks");
    for (let index = 0; index < 6; index += 1) {
      s.call("Orchestrator", "WebFetch", `https://example.com/${index}`);
      s.result("Orchestrator", "WebFetch", "page");
    }
    for (let index = 0; index < 4; index += 1) {
      s.call("Orchestrator", "WebSearch", `framework ${index}`);
      s.result("Orchestrator", "WebSearch", "results");
    }
    s.call("Orchestrator", "Bash", "Listing the notes");
    const result = review(s);
    const finding = result.findings.find((item) => item.id === "lookups-in-main-agent");
    if (!finding) throw new Error("expected lookups-in-main-agent finding");
    expect(finding.severity).toBe("medium");
    expect(finding.title).toBe("The main agent did 10 lookups itself (6 WebFetch, 4 WebSearch)");
    expect(finding.detail).toContain("11 tool calls for this prompt");
    expect(finding.suggestion).toContain("one subagent per question");
    expect(finding.eventIds).toHaveLength(10);
    expect(ids(result.findings)).not.toContain("long-solo-run");
  });

  it("names the tools that failed and shows what they returned", () => {
    const s = new StoryEvents();
    s.user("Summarize these two pages");
    s.call("Orchestrator", "WebFetch", "https://example.com/a");
    s.result("Orchestrator", "WebFetch", "403 Forbidden", true);
    const finding = review(s).findings.find((item) => item.id === "tool-failures");
    if (!finding) throw new Error("expected tool-failures finding");
    expect(finding.severity).toBe("info");
    expect(finding.title).toBe("1 tool call failed (1 WebFetch)");
    expect(finding.detail).toBe("WebFetch: 403 Forbidden");
  });

  it("flags heavy assembly in the main agent after the subagents finished", () => {
    const s = new StoryEvents();
    s.user("Parallel then assemble");
    s.spawn("Orchestrator", "Work", ["A"]);
    s.start("A", "a");
    s.end("A");
    for (let index = 0; index < 9; index += 1) s.modelCall("Orchestrator", 1);
    const finding = review(s).findings.find((item) => item.id === "post-join-assembly");
    if (!finding) throw new Error("expected post-join-assembly finding");
    expect(finding.title).toBe("The main agent took 9 more steps after its subagents finished");
    expect(finding.eventIds).toHaveLength(9);
  });
});

describe("reviewTurns", () => {
  it("reviews each prompt on the events it set off", () => {
    const s = new StoryEvents();
    s.user("Solve this and verify with python");
    s.call("Orchestrator", "eval", "Attempting python verifier");
    s.result("Orchestrator", "eval", "Tool eval not found", true);
    const followUp = s.user("There is no python here; reason it out by hand");
    s.modelCall("Orchestrator", 1);
    s.modelCall("Orchestrator", 1);
    s.modelCall("Orchestrator", 1);
    const [first, second] = reviewTurns(s.events);
    expect(first?.turnIndex).toBe(0);
    expect(ids(first?.findings ?? [])).toContain("missing-tools");
    expect(second?.promptEvent?.id).toBe(followUp.id);
    expect(ids(second?.findings ?? [])).not.toContain("missing-tools");
  });

  it("does not call a short follow-up underspecified for leaning on earlier context", () => {
    const s = new StoryEvents();
    s.user("Fix the one failing unit test in packages/schema and report the diff");
    s.user("continue");
    for (let index = 0; index < 4; index += 1) s.modelCall("Orchestrator", 1);
    const second = reviewTurns(s.events)[1];
    expect(ids(second?.findings ?? [])).not.toContain("short-prompt");
  });

  it("credits a spawn wave to the turn that dispatched it", () => {
    const s = new StoryEvents();
    s.user("Plan the migration");
    s.user("Now do it in parallel, one agent per package");
    s.spawn("Orchestrator", "Migrate", ["A", "B"]);
    s.start("A", "a");
    s.start("B", "b");
    for (const lane of ["A", "B"])
      for (let index = 0; index < 4; index += 1) {
        s.read(lane, `file ${index}`);
        s.result(lane, "read", "body");
      }
    const [first, second] = reviewTurns(s.events);
    expect(ids(first?.findings ?? [])).not.toContain("dispatch-paid-off");
    expect(ids(second?.findings ?? [])).toContain("dispatch-paid-off");
  });
});
