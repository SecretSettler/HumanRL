"use client";

import { useMemo, useState } from "react";

import { agentColor, laneOrderFor } from "@/lib/workbench/agent-colors";
import {
  buildExecutionStory,
  storyTotals,
  type StoryCall,
  type StoryStep,
  type ToolStep,
} from "@/lib/workbench/execution-story";
import { formatDurationMs } from "@/lib/workbench/format";
import {
  evaluatePromptOptimization,
  type SpawnAccounting,
  type SpawnVerdict,
} from "@/lib/workbench/prompt-optimizer";
import { useWorkbenchStore } from "@/lib/workbench/store";

const VERDICT_LABEL: Record<SpawnVerdict, string> = {
  worth: "值得",
  marginal: "勉强",
  wasteful: "浪费",
  pending: "等待中",
};

const STATUS_GLYPH = { completed: "✓", failed: "!", running: "•" } as const;

function stepStatus(step: ToolStep): keyof typeof STATUS_GLYPH {
  if (step.calls.some((call) => call.status === "failed")) return "failed";
  if (step.calls.some((call) => call.status === "running")) return "running";
  return "completed";
}

function offsetLabel(startMs: number, iso: string): string {
  return `+${formatDurationMs(Date.parse(iso) - startMs)}`;
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
            {call.result ? ` → result #${call.result.ingestSeq}` : " → 还没有结果"}
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
  startMs: number;
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
              {failed > 0 ? <span className="text-red">{failed} 次失败</span> : null}
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
                {step.agentId} → {step.childAgentIds.length} 个子 Agent
              </span>
              <span className={`spawn-verdict spawn-verdict--${verdict}`}>
                {VERDICT_LABEL[verdict]}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-micro text-muted-2">
              {step.label} · {step.childAgentIds.join(", ")}
              {spawnAccount && spawnAccount.childrenStarted > 0
                ? ` · 子 lane 吸收 ${spawnAccount.childToolResults} 次结果 / ${spawnAccount.childModelCalls} 轮`
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
              {step.agentId} 完成{step.joinedBy ? `，由 ${step.joinedBy} join` : ""}
            </span>
          </span>
          <time className="execution-time">{time}</time>
        </button>
      </li>
    );
  }

  return (
    <li className="execution-step execution-step--message" style={{ borderLeftColor: color }}>
      <button type="button" className="execution-step__button" onClick={() => onSelect(step.id)}>
        <span className="execution-icon execution-icon--message" aria-hidden>
          ▸
        </span>
        <span className="min-w-0">
          <span className="block text-micro font-bold uppercase tracking-[0.12em] text-muted-2">
            {step.label} · {step.agentId}
          </span>
          <span className="execution-message">{step.text}</span>
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
  const sign = spawn.netTokens >= 0 ? "+" : "−";
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
        {spawn.childAgentIds.length} 个子 Agent，{spawn.childrenJoined}/{spawn.childrenStarted} 已
        join
        {spawn.childFailures > 0 ? ` · ${spawn.childFailures} 次失败` : ""}
      </span>
      <span className="mt-1.5 grid grid-cols-3 gap-1 text-micro">
        <span className="spawn-figure">
          <span>吸收</span>
          <strong>≥{spawn.absorbedTokens}</strong>
        </span>
        <span className="spawn-figure">
          <span>成本</span>
          <strong>≥{spawn.spawnCostTokens}</strong>
        </span>
        <span className="spawn-figure">
          <span>净</span>
          <strong className={spawn.netTokens >= 0 ? "text-green" : "text-red"}>
            {sign}
            {Math.abs(spawn.netTokens)}
          </strong>
        </span>
      </span>
    </button>
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
  const decision = useMemo(() => evaluatePromptOptimization({ events }), [events]);
  const spawnByEvent = useMemo(
    () => new Map(decision.spawns.map((spawn) => [spawn.handoffEventId, spawn] as const)),
    [decision.spawns],
  );
  const laneOrder = useMemo(
    () =>
      laneOrderFor(
        (snapshot?.agents ?? []).map((lane) => lane.agentId),
        [],
      ),
    [snapshot],
  );
  const startMs = useMemo(() => {
    const first = snapshot?.raw.events[0];
    return first ? Date.parse(first.occurredAt) : Date.now();
  }, [snapshot]);

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
            每个 tool call 做了什么，什么时候 spawn 了子 Agent
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
            {collapsed ? "展开" : "收起"}
          </button>
        </div>
      </header>

      {collapsed ? null : (
        <div className="execution-body grid gap-3 px-3 pb-3 lg:grid-cols-[minmax(0,1fr)_320px]">
          <ol className="execution-steps" aria-label="Tool call timeline">
            {steps.length === 0 ? (
              <li className="rounded-lg border border-dashed border-line px-3 py-3 text-meta text-muted-2">
                当前 watermark 还没有工具动作。
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
                    Prompt optimizer
                  </p>
                  <h3 className="m-0 mt-0.5 text-meta font-semibold text-ink">
                    现在该不该再 spawn？
                  </h3>
                </div>
                <span className={`prompt-decision prompt-decision--${decision.decision}`}>
                  {decision.decision === "spawn" ? "Spawn now" : "Hold"}
                </span>
              </div>
              <div className="mt-2.5 grid grid-cols-2 gap-1.5">
                <div className="metric-card">
                  <span>根 lane 轮数</span>
                  <strong>{decision.contextPressure}</strong>
                </div>
                <div className="metric-card">
                  <span>失败 / 重复</span>
                  <strong>
                    {decision.toolFailures} / {decision.repeatedToolCalls}
                  </strong>
                </div>
                <div className="metric-card">
                  <span>预计节省</span>
                  <strong>≥{decision.expectedSavedTokens} tok</strong>
                </div>
                <div className="metric-card">
                  <span>一次 spawn 成本</span>
                  <strong>≥{decision.spawnCostTokens} tok</strong>
                </div>
              </div>
              <ul className="m-0 mt-2.5 grid gap-1 pl-4 text-meta text-muted">
                {decision.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              <p className="m-0 mt-2.5 text-micro text-muted-2">
                只看事件元数据，不读 prompt 正文。token
                数是按名字长度和事件数估的下限，用来比大小，不是账单。
              </p>
            </div>

            {decision.spawns.length > 0 ? (
              <div className="grid gap-1.5">
                <p className="m-0 text-micro font-bold uppercase tracking-[0.14em] text-muted-2">
                  已发生的 spawn · 值不值
                </p>
                {decision.spawns.map((spawn) => (
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
