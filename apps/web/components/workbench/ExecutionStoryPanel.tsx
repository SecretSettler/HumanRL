"use client";

import { useEffect, useMemo, useState } from "react";

import { agentColor, laneOrderFor } from "@/lib/workbench/agent-colors";
import {
  buildExecutionStory,
  storyTotals,
  traceStartMs,
  type StoryCall,
  type StoryStep,
  type ToolStep,
} from "@/lib/workbench/execution-story";
import { formatDurationMs } from "@/lib/workbench/format";
import {
  accountSpawns,
  type SpawnAccounting,
  type SpawnVerdict,
} from "@/lib/workbench/spawn-accounting";
import { reviewTurns, type PromptFinding } from "@/lib/workbench/prompt-review";
import { splitTurns } from "@/lib/workbench/prompt-turns";
import { useWorkbenchStore } from "@/lib/workbench/store";
import { artifactUrl } from "@/lib/workbench/trace-api";
import type { RawTraceEvent } from "@/lib/workbench/types";

const VERDICT_LABEL: Record<SpawnVerdict, string> = {
  worth: "Worth it",
  marginal: "Barely worth it",
  wasteful: "Not worth it",
  pending: "Not started",
};

const STATUS_GLYPH = { completed: "✓", failed: "!", running: "•" } as const;

function stepStatus(step: ToolStep): keyof typeof STATUS_GLYPH {
  if (step.calls.some((call) => call.status === "failed")) return "failed";
  if (step.calls.some((call) => call.status === "running")) return "running";
  return "completed";
}

function offsetLabel(startMs: number | null, iso: string): string {
  const ms = Date.parse(iso);
  if (startMs === null || !Number.isFinite(ms) || ms < startMs) return "";
  return `+${formatDurationMs(ms - startMs)}`;
}

function LaneDot({ color, name }: { color: string; name: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-micro text-muted">
      <span className="h-2 w-2 flex-none rounded-full" style={{ background: color }} aria-hidden />
      <span className="truncate">{name}</span>
    </span>
  );
}

function CallRow({ call, onSelect }: { call: StoryCall; onSelect: (eventId: string) => void }) {
  return (
    <li className="execution-call">
      <button
        type="button"
        className="execution-call__button"
        onClick={() => onSelect(call.event.id)}
      >
        <span className={`execution-icon execution-icon--${call.status}`} aria-hidden>
          {STATUS_GLYPH[call.status]}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-meta text-ink">{call.action}</span>
          <span className="block truncate text-micro text-muted-2">
            #{call.event.ingestSeq}
            {call.result ? ` → result #${call.result.ingestSeq}` : " → no result yet"}
            {call.status === "failed" && call.result
              ? ` · ${call.result.name.replace(/^Tool result: [^·]+·\s*/u, "")}`
              : ""}
          </span>
        </span>
      </button>
    </li>
  );
}

function StepRow({
  step,
  color,
  startMs,
  expanded,
  spawnAccount,
  onToggle,
  onSelect,
}: {
  step: StoryStep;
  color: string;
  startMs: number | null;
  expanded: boolean;
  spawnAccount: SpawnAccounting | undefined;
  onToggle: () => void;
  onSelect: (eventId: string) => void;
}) {
  const time = offsetLabel(startMs, step.occurredAt);

  if (step.kind === "tools") {
    const status = stepStatus(step);
    const first = step.calls[0];
    const extra = step.calls.length - 1;
    const failed = step.calls.filter((call) => call.status === "failed").length;
    return (
      <li className="execution-step" style={{ borderLeftColor: color }}>
        <button
          type="button"
          className="execution-step__button"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span className={`execution-icon execution-icon--${status}`} aria-hidden>
            {STATUS_GLYPH[status]}
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="execution-tool">{step.tool}</span>
              {step.calls.length > 1 ? (
                <span className="text-micro text-muted-2">×{step.calls.length}</span>
              ) : null}
              <span className="truncate text-body text-ink">{first?.action}</span>
              {extra > 0 ? (
                <span className="flex-none text-micro text-muted-2">+{extra}</span>
              ) : null}
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-2 text-micro text-muted-2">
              <LaneDot color={color} name={step.agentId} />
              <span>#{step.seq}</span>
              {failed > 0 ? <span className="text-red">{failed} failed</span> : null}
            </span>
          </span>
          <time className="execution-time">{time}</time>
        </button>
        {expanded ? (
          <ul className="execution-calls">
            {step.calls.map((call) => (
              <CallRow key={call.event.id} call={call} onSelect={onSelect} />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  if (step.kind === "spawn") {
    const verdict = spawnAccount?.verdict ?? "pending";
    return (
      <li className="execution-step execution-step--spawn" style={{ borderLeftColor: color }}>
        <button type="button" className="execution-step__button" onClick={() => onSelect(step.id)}>
          <span className="execution-icon execution-icon--spawn" aria-hidden>
            ⑂
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="execution-tool">spawn</span>
              <span className="truncate text-body text-ink">
                {step.agentId} → {step.childAgentIds.length} child agent
                {step.childAgentIds.length === 1 ? "" : "s"}
              </span>
              <span className={`spawn-verdict spawn-verdict--${verdict}`}>
                {VERDICT_LABEL[verdict]}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-micro text-muted-2">
              {step.label} · {step.childAgentIds.join(", ")}
              {spawnAccount && spawnAccount.childrenStarted > 0
                ? ` · subagents made ${spawnAccount.childToolCalls} tool calls`
                : ""}
            </span>
          </span>
          <time className="execution-time">{time}</time>
        </button>
      </li>
    );
  }

  if (step.kind === "join") {
    return (
      <li className="execution-step execution-step--quiet" style={{ borderLeftColor: color }}>
        <button type="button" className="execution-step__button" onClick={() => onSelect(step.id)}>
          <span className="execution-icon execution-icon--join" aria-hidden>
            ⇤
          </span>
          <span className="min-w-0">
            <span className="block truncate text-meta text-muted">
              {step.agentId} finished{step.joinedBy ? `, joined by ${step.joinedBy}` : ""}
            </span>
          </span>
          <time className="execution-time">{time}</time>
        </button>
      </li>
    );
  }

  const assistant = step.role === "assistant";
  return (
    <li
      className={`execution-step ${assistant ? "execution-step--assistant" : "execution-step--message"}`}
      style={{ borderLeftColor: color }}
    >
      <button type="button" className="execution-step__button" onClick={() => onSelect(step.id)}>
        <span
          className={`execution-icon ${assistant ? "execution-icon--join" : "execution-icon--message"}`}
          aria-hidden
        >
          {assistant ? "…" : "▸"}
        </span>
        <span className="min-w-0">
          <span className="block text-micro font-bold uppercase tracking-[0.12em] text-muted-2">
            {assistant ? "Agent said" : step.label} · {step.agentId}
          </span>
          <span
            className={
              assistant ? "execution-message execution-message--quiet" : "execution-message"
            }
          >
            {step.text}
          </span>
        </span>
        <time className="execution-time">{time}</time>
      </button>
    </li>
  );
}

function SpawnCard({
  spawn,
  color,
  onSelect,
}: {
  spawn: SpawnAccounting;
  color: string;
  onSelect: (eventId: string) => void;
}) {
  const count = spawn.childAgentIds.length;
  return (
    <button type="button" className="spawn-card" onClick={() => onSelect(spawn.handoffEventId)}>
      <span className="flex items-center justify-between gap-2">
        <LaneDot color={color} name={`${spawn.parentAgentId} · #${spawn.seq}`} />
        <span className={`spawn-verdict spawn-verdict--${spawn.verdict}`}>
          {VERDICT_LABEL[spawn.verdict]}
        </span>
      </span>
      <span className="mt-1 block truncate text-meta text-ink">{spawn.label}</span>
      <span className="mt-1 block text-micro text-muted-2">
        {count} subagent{count === 1 ? "" : "s"} · {spawn.childrenJoined}/{spawn.childrenStarted}{" "}
        finished
        {spawn.childFailures > 0 ? ` · ${spawn.childFailures} failed` : ""}
      </span>
      <span className="mt-1.5 grid grid-cols-3 gap-1 text-micro">
        <span className="spawn-figure">
          <span>their tool calls</span>
          <strong>{spawn.childToolCalls}</strong>
        </span>
        <span className="spawn-figure">
          <span>kept out of main</span>
          <strong>≥{spawn.absorbedTokens} tok</strong>
        </span>
        <span className="spawn-figure">
          <span>cost to start</span>
          <strong>≥{spawn.spawnCostTokens} tok</strong>
        </span>
      </span>
    </button>
  );
}

/**
 * Pull the human-readable text out of a sanitized message payload. Canonical
 * JSONL stores `{"text": …}`; Codex stores the response item with
 * `payload.content[].text`; anything else is shown as is.
 */
export function extractMessageText(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.text === "string") return parsed.text;
    const payload = (parsed.payload ?? parsed.message ?? parsed) as Record<string, unknown>;
    const content = payload.content;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      const parts = content
        .map((part) =>
          part && typeof part === "object" ? (part as { text?: unknown }).text : null,
        )
        .filter((text): text is string => typeof text === "string" && text.trim().length > 0);
      if (parts.length > 0) return parts.join("\n\n");
    }
    return body;
  } catch {
    return body;
  }
}

/** The full prompt lives in the sanitized payload; the event name only carries a 240-character preview. */
function usePromptText(traceId: string | null, event: RawTraceEvent | null): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    if (!traceId || !event?.payloadRef) return;
    const controller = new AbortController();
    void fetch(artifactUrl(traceId, event.payloadRef.artifactId, event.payloadRef.byteLength), {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => (response.ok ? response.text() : null))
      .then((body) => {
        if (body === null || controller.signal.aborted) return;
        setText(extractMessageText(body));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [event, traceId]);
  return text;
}

const SEVERITY_LABEL = { high: "Fix", medium: "Improve", info: "Note" } as const;

function FindingRow({
  finding,
  onSelect,
}: {
  finding: PromptFinding;
  onSelect: (eventId: string) => void;
}) {
  const [open, setOpen] = useState(finding.severity !== "info");
  const first = finding.eventIds[0];
  return (
    <li className={`finding finding--${finding.severity}`}>
      <button
        type="button"
        className="finding__button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`finding__badge finding__badge--${finding.severity}`}>
          {SEVERITY_LABEL[finding.severity]}
        </span>
        <span className="min-w-0 text-meta text-ink">{finding.title}</span>
      </button>
      {open ? (
        <div className="finding__body">
          <p className="m-0 text-meta text-muted">{finding.detail}</p>
          <p className="m-0 mt-1.5 text-meta text-ink">
            <span className="text-muted-2">Next time: </span>
            {finding.suggestion}
          </p>
          {first ? (
            <button type="button" className="finding__evidence" onClick={() => onSelect(first)}>
              Show evidence ({finding.eventIds.length} event
              {finding.eventIds.length === 1 ? "" : "s"})
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function ExecutionStoryPanel() {
  const snapshot = useWorkbenchStore((state) => state.snapshot);
  const playhead = useWorkbenchStore((state) => state.playhead);
  const store = useWorkbenchStore;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState(false);

  const events = useMemo(
    () => (snapshot?.raw.events ?? []).filter((event) => Number(event.ingestSeq) <= playhead),
    [playhead, snapshot],
  );
  const steps = useMemo(() => buildExecutionStory(events), [events]);
  const totals = useMemo(() => storyTotals(steps), [steps]);
  const spawns = useMemo(() => accountSpawns(events), [events]);
  const reviews = useMemo(() => reviewTurns(events), [events]);
  // null follows the latest prompt as the playhead moves; a number pins a turn.
  const [pinnedTurn, setPinnedTurn] = useState<number | null>(null);
  const traceId = snapshot?.trace.id ?? null;
  useEffect(() => setPinnedTurn(null), [traceId]);
  const latestTurn = Math.max(0, reviews.length - 1);
  const turnIndex = pinnedTurn !== null && pinnedTurn < reviews.length ? pinnedTurn : latestTurn;
  const review = reviews[turnIndex] ?? {
    turnIndex: 0,
    promptEvent: null,
    promptPreview: "",
    promptTokens: 0,
    findings: [],
  };
  const showTurn = (index: number) => setPinnedTurn(index >= latestTurn ? null : index);
  const turnOfEvent = useMemo(() => {
    const map = new Map<string, number>();
    for (const turn of splitTurns(events))
      for (const event of turn.events) map.set(event.id, turn.index);
    return map;
  }, [events]);
  const promptText = usePromptText(traceId, review.promptEvent);
  const [promptOpen, setPromptOpen] = useState(false);
  const spawnByEvent = useMemo(
    () => new Map(spawns.map((spawn) => [spawn.handoffEventId, spawn] as const)),
    [spawns],
  );
  // The ledger follows the prompt picked in the review, like its findings.
  const turnSpawns =
    reviews.length > 1
      ? spawns.filter((spawn) => turnOfEvent.get(spawn.handoffEventId) === turnIndex)
      : spawns;
  const laneOrder = useMemo(
    () =>
      laneOrderFor(
        (snapshot?.agents ?? []).map((lane) => lane.agentId),
        [],
      ),
    [snapshot],
  );
  const startMs = useMemo(() => traceStartMs(snapshot?.raw.events ?? []), [snapshot]);

  const select = (eventId: string) => store.getState().selectEvent(eventId);
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section
      className="execution-story m-2 mt-0 rounded-panel border border-line bg-panel/95"
      aria-label="Execution story"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 px-3 pt-3 pb-2">
        <div className="min-w-0">
          <p className="m-0 text-micro font-bold uppercase tracking-[0.14em] text-muted-2">
            Execution story
          </p>
          <h2 className="m-0 mt-0.5 text-title font-semibold">
            What every tool call did, and where subagents were spawned
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-line bg-panel-3 px-2.5 py-1 text-micro text-muted">
            {totals.toolCalls} tool calls · {totals.spawns} spawns → {totals.spawnedAgents} agents
            {totals.failed > 0 ? ` · ${totals.failed} failed` : ""}
          </span>
          <button
            type="button"
            className="px-2.5 py-1 text-micro"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? "Expand" : "Collapse"}
          </button>
        </div>
      </header>

      {collapsed ? null : (
        <div className="execution-body grid gap-3 px-3 pb-3 lg:grid-cols-[minmax(0,1fr)_320px]">
          <ol className="execution-steps" aria-label="Tool call timeline">
            {steps.length === 0 ? (
              <li className="rounded-lg border border-dashed border-line px-3 py-3 text-meta text-muted-2">
                No tool activity at this watermark yet.
              </li>
            ) : (
              steps.map((step) => (
                <StepRow
                  key={step.id}
                  step={step}
                  color={agentColor(laneOrder, step.agentId)}
                  startMs={startMs}
                  expanded={expanded.has(step.id)}
                  spawnAccount={spawnByEvent.get(step.id)}
                  onToggle={() => toggle(step.id)}
                  onSelect={select}
                />
              ))
            )}
          </ol>

          <aside className="execution-aside grid content-start gap-3 pr-1">
            <div className="rounded-lg border border-line bg-[#0d1118] p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="m-0 text-micro font-bold uppercase tracking-[0.14em] text-muted-2">
                    Prompt review
                  </p>
                  <h3 className="m-0 mt-0.5 text-meta font-semibold text-ink">
                    {reviews.length > 1
                      ? turnIndex === 0
                        ? "What your opening prompt caused"
                        : "What this follow-up caused"
                      : "What your prompt caused in this run"}
                  </h3>
                </div>
                {review.promptEvent ? (
                  <span className="rounded-full border border-line bg-panel-3 px-2 py-0.5 text-micro text-muted">
                    ~{review.promptTokens} tok
                  </span>
                ) : null}
              </div>
              {reviews.length > 1 ? (
                <nav className="turn-nav" aria-label="Prompt turns">
                  <button
                    type="button"
                    aria-label="Previous prompt"
                    disabled={turnIndex === 0}
                    onClick={() => showTurn(turnIndex - 1)}
                  >
                    ‹
                  </button>
                  <span>
                    Prompt {turnIndex + 1} of {reviews.length}
                  </span>
                  <button
                    type="button"
                    aria-label="Next prompt"
                    disabled={turnIndex === latestTurn}
                    onClick={() => showTurn(turnIndex + 1)}
                  >
                    ›
                  </button>
                  {pinnedTurn !== null ? (
                    <button
                      type="button"
                      className="turn-nav__latest"
                      onClick={() => showTurn(latestTurn)}
                    >
                      Latest
                    </button>
                  ) : null}
                </nav>
              ) : null}
              {review.promptEvent ? (
                <button
                  type="button"
                  className="prompt-text"
                  aria-expanded={promptOpen}
                  onClick={() => setPromptOpen((value) => !value)}
                >
                  <span className={promptOpen ? "" : "prompt-text__clamp"}>
                    {promptText ?? review.promptPreview}
                  </span>
                  <span className="mt-1 block text-micro text-muted-2">
                    {promptOpen ? "Collapse" : "Show full prompt"} · #{review.promptEvent.ingestSeq}{" "}
                    · {review.promptEvent.agentId}
                  </span>
                </button>
              ) : (
                <p className="m-0 mt-2 text-meta text-muted-2">No user prompt at this watermark.</p>
              )}
              {review.findings.length > 0 ? (
                <ul className="findings">
                  {review.findings.map((finding) => (
                    <FindingRow key={finding.id} finding={finding} onSelect={select} />
                  ))}
                </ul>
              ) : review.promptEvent ? (
                <p className="m-0 mt-2 text-meta text-muted-2">Nothing to flag for this prompt.</p>
              ) : null}
            </div>

            {turnSpawns.length > 0 ? (
              <div className="grid gap-1.5">
                <p className="m-0 text-micro font-bold uppercase tracking-[0.14em] text-muted-2">
                  {reviews.length > 1 ? "Subagents started for this prompt" : "Subagents started"}
                </p>
                <p className="m-0 text-micro text-muted-2">
                  Worth it when the subagents kept more out of the main agent&apos;s context than
                  they cost to start. Token figures are rough lower bounds.
                </p>
                {turnSpawns.map((spawn) => (
                  <SpawnCard
                    key={spawn.handoffEventId}
                    spawn={spawn}
                    color={agentColor(laneOrder, spawn.parentAgentId)}
                    onSelect={select}
                  />
                ))}
              </div>
            ) : null}
          </aside>
        </div>
      )}
    </section>
  );
}
