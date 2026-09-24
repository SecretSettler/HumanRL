import { describe, expect, it } from "vitest";

import { splitTurns } from "./prompt-turns";
import { StoryEvents } from "./story-test-events";

describe("splitTurns", () => {
  it("returns no turns before the author has typed anything", () => {
    const s = new StoryEvents();
    s.read("Orchestrator", "Reading something");
    expect(splitTurns(s.events)).toEqual([]);
  });

  it("splits the root lane at each prompt and keeps pre-prompt events in the first turn", () => {
    const s = new StoryEvents();
    const boot = s.push("agent_start", "Agent started", "Orchestrator");
    const first = s.user("Find the flaky test");
    const read = s.read("Orchestrator", "Reading the test");
    const second = s.user("Now fix it");
    const edit = s.call("Orchestrator", "edit", "Editing the test");
    const turns = splitTurns(s.events);
    expect(turns.map((turn) => turn.promptEvent.id)).toEqual([first.id, second.id]);
    expect(turns[0]?.events.map((event) => event.id)).toEqual([boot.id, first.id, read.id]);
    expect(turns[1]?.events.map((event) => event.id)).toEqual([second.id, edit.id]);
  });

  it("keeps a child lane with the turn that spawned it, even after the next prompt", () => {
    const s = new StoryEvents();
    s.user("Survey both repos");
    const spawn = s.spawn("Orchestrator", "Survey", ["A"]);
    s.start("A", "scout");
    s.user("Also check the docs");
    const late = s.read("A", "Reading repo A");
    s.end("A");
    const [first, second] = splitTurns(s.events);
    expect(first?.events.map((event) => event.id)).toContain(spawn.id);
    expect(first?.events.map((event) => event.id)).toContain(late.id);
    expect(second?.events.every((event) => event.agentId === "Orchestrator")).toBe(true);
  });

  it("does not start a turn at task assignments or harness messages", () => {
    const s = new StoryEvents();
    s.user("<environment_context>cwd</environment_context>");
    s.user("Solve it");
    s.spawn("Orchestrator", "Solve", ["A"]);
    s.start("A", "solver");
    s.assignment("A", "Deliverable: a.md");
    expect(splitTurns(s.events)).toHaveLength(1);
  });
});
