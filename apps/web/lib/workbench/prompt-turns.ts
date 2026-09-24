import { userPrompts } from "./execution-story";
import type { RawTraceEvent } from "./types";

/**
 * A turn: one message the author typed and everything it set off.
 *
 * Lanes that received an author prompt are split at each prompt. Any other
 * lane (a subagent) belongs whole to the turn in which it first appeared, so a
 * child that outlives the next prompt still counts toward the turn that
 * spawned it. Events before the first prompt (session start, harness
 * preambles) belong to the first turn.
 */
export interface PromptTurn {
  /** Zero-based position among the author's prompts. */
  index: number;
  promptEvent: RawTraceEvent;
  /** ingestSeq of the prompt; the turn's root-lane events run up to the next turn's startSeq. */
  startSeq: number;
  events: RawTraceEvent[];
}

function seqOf(event: RawTraceEvent): number {
  return Number(event.ingestSeq);
}

export function splitTurns(events: readonly RawTraceEvent[]): PromptTurn[] {
  const prompts = userPrompts(events);
  if (prompts.length === 0) return [];
  const starts = prompts.map(seqOf);
  const turnAt = (seq: number): number => {
    let index = 0;
    while (index + 1 < starts.length && (starts[index + 1] ?? Infinity) <= seq) index += 1;
    return index;
  };

  const rootLanes = new Set(prompts.map((event) => event.agentId ?? null));
  const laneTurn = new Map<string, number>();
  const turns: PromptTurn[] = prompts.map((promptEvent, index) => ({
    index,
    promptEvent,
    startSeq: starts[index] ?? 0,
    events: [],
  }));

  const ordered = [...events].sort((a, b) => seqOf(a) - seqOf(b));
  for (const event of ordered) {
    const lane = event.agentId ?? null;
    let index: number;
    if (lane === null || rootLanes.has(lane)) index = turnAt(seqOf(event));
    else {
      index = laneTurn.get(lane) ?? turnAt(seqOf(event));
      laneTurn.set(lane, index);
    }
    turns[index]?.events.push(event);
  }
  return turns;
}
