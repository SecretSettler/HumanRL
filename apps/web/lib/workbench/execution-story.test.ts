import { describe, expect, it } from "vitest";

import {
  buildExecutionStory,
  describeToolCall,
  firstUserPrompt,
  isHarnessMessage,
  pairToolResults,
  splitName,
  storyTotals,
  summarizeAction,
  traceStartMs,
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
    expect(describeToolCall(call)).toEqual({ tool: "read", action: "Read a file" });
  });
});

describe("harness messages and Codex exec scripts", () => {
  it("recognises injected instructions and picks the author's prompt after them", () => {
    expect(isHarnessMessage("# AGENTS.md instructions for ~ <INSTRUCTIONS> …")).toBe(true);
    expect(isHarnessMessage("<environment_context> <cwd>~</cwd>")).toBe(true);
    expect(isHarnessMessage("<multi_agent_role>You are `/root`")).toBe(true);
    expect(isHarnessMessage("给你一个空Repo，你能不能搭一个 trace 可视化")).toBe(false);
    expect(isHarnessMessage("Fix the failing test")).toBe(false);

    const s = new StoryEvents();
    s.push("user_message", "User · # AGENTS.md instructions for ~ <INSTRUCTIONS>", "codex");
    const real = s.push("user_message", "User · 给你一个空Repo，搭一个 trace 可视化", "codex");
    expect(firstUserPrompt(s.events)?.id).toBe(real.id);
  });

  it("shows the commands inside a Codex exec script instead of the script", () => {
    const script =
      'const r = await Promise.allSettled([ tools.exec_command({cmd:"git clone https://x/y.git ~/y",workdir:"~"}), tools.exec_command({cmd:"cat ~/y/README.md",workdir:"~"}) ]);';
    expect(summarizeAction(script)).toBe("git clone https://x/y.git ~/y  (+1 more)");
    expect(summarizeAction("Reading plan-writing skill")).toBe("Reading plan-writing skill");
    expect(
      summarizeAction(
        'const r = await tools.exec_command({cmd:"rsync -a --exclude .git ~/a/ ~/b/ && cp ~/a/LIC',
      ),
    ).toBe("rsync -a --exclude .git ~/a/ ~/b/ && cp ~/a/LIC");
    const s = new StoryEvents();
    const call = s.push("tool_call", `Tool call: exec · ${script}`, "codex", {
      attributes: { toolName: "exec" },
    });
    expect(describeToolCall(call)).toEqual({
      tool: "exec",
      action: "git clone https://x/y.git ~/y  (+1 more)",
    });
  });

  it("keeps narrated assistant messages as steps and drops injected ones", () => {
    const s = new StoryEvents();
    s.push("assistant_message", "Assistant · <skills_instructions> ## Skills", "codex");
    s.push("user_message", "User · Build the thing", "codex");
    s.push("tool_call", "Tool call: exec · cmd one", "codex", { attributes: { toolName: "exec" } });
    s.push("assistant_message", "Assistant · Repos look fine, wiring the panel now.", "codex");
    s.push("tool_call", "Tool call: exec · cmd two", "codex", { attributes: { toolName: "exec" } });
    const steps = buildExecutionStory(s.events);
    expect(
      steps.map((step) => (step.kind === "message" ? `${step.role}` : `${step.kind}`)),
    ).toEqual(["user", "tools", "assistant", "tools"]);
  });
});

describe("Claude Code shapes", () => {
  it("pairs unnamed results with the oldest open call in the lane", () => {
    const s = new StoryEvents();
    const bash = s.push(
      "tool_call",
      'Tool call: Bash · {"command":"ls","description":"List files"}',
      "claude",
      {
        attributes: { toolName: "Bash" },
      },
    );
    const search = s.push(
      "tool_call",
      'Tool call: ToolSearch · {"query":"select:WebSearch"}',
      "claude",
      {
        attributes: { toolName: "ToolSearch" },
      },
    );
    const r1 = s.push("tool_result", "Tool result · file list", "claude");
    const r2 = s.push("tool_result", "Tool result · tool reference", "claude");
    const paired = pairToolResults(s.events);
    expect(paired.get(bash.id)?.id).toBe(r1.id);
    expect(paired.get(search.id)?.id).toBe(r2.id);
  });

  it("shows the description or target of a JSON tool input", () => {
    expect(summarizeAction('{"command":"cat a.md b.md","description":"Read both notes"}')).toBe(
      "Read both notes",
    );
    expect(summarizeAction('{"command":"git status"}')).toBe("git status");
    expect(summarizeAction('{"file_path":"/x/y.ts","limit":40}')).toBe("/x/y.ts");
    expect(summarizeAction('{"query":"select:WebSearch,WebFetch","max_results":2}')).toBe(
      "select:WebSearch,WebFetch",
    );
    // truncated at the name cap: the fragment is marked, a surviving complete value wins
    expect(summarizeAction('{"command":"cat ~/notes/a-very-long-directory-name/infra')).toBe(
      "cat ~/notes/a-very-long-directory-name/infra…",
    );
    expect(
      summarizeAction('{"command":"cat a-very-long-path/that/goes/on","description":"Rea'),
    ).toBe("cat a-very-long-path/that/goes/on");
  });

  it("ignores epoch-stamped metadata when computing the trace start", () => {
    const s = new StoryEvents();
    const meta = s.push("log", "Summary", "claude");
    meta.occurredAt = "1970-01-01T00:00:00.000Z";
    const first = s.push("user_message", "User · Hello", "claude");
    expect(traceStartMs(s.events)).toBe(Date.parse(first.occurredAt));
    expect(traceStartMs([meta])).toBeNull();
  });

  it("drops assistant records that carry no text (tool-use-only turns)", () => {
    const s = new StoryEvents();
    s.push("user_message", "User · Do it", "claude");
    s.push("assistant_message", "Assistant", "claude");
    s.push("tool_call", 'Tool call: Bash · {"command":"ls"}', "claude", {
      attributes: { toolName: "Bash" },
    });
    const steps = buildExecutionStory(s.events);
    expect(steps.map((step) => step.kind)).toEqual(["message", "tools"]);
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
