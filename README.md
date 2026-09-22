# HumanRL

**Was my prompt any good?** HumanRL answers that from the trace an agent left behind. Point it at a Codex or Claude session (or the bundled demo) and it shows, in plain English, what every tool call did, where the agent spawned subagents, whether each spawn was worth its tokens, and what in your prompt caused the waste.

It is built on [IntentTrace](https://github.com/chivier/IntentTrace), a local-first agent-observability workbench, and keeps everything IntentTrace has (append-only raw events, Intent Graph, Agent Gantt, replay slider, Evidence Inspector). Nothing leaves your machine.

![HumanRL on the recorded nine-lane IMO demo: Execution story on the left, Prompt review with evidence on the right](docs/assets/humanrl-demo.png)

## One line

```bash
curl -fsSL https://raw.githubusercontent.com/SecretSettler/HumanRL/main/install.sh | bash
```

That clones into `~/HumanRL`, installs, puts a `humanrl` command on your PATH, starts everything (PostgreSQL, API, worker, web), loads the demo trace and opens it in your browser. You need `git` and Node.js (24 recommended, 22 works); the script says what to install if either is missing.

## Then

```bash
humanrl codex        # import your latest Codex session and open it
humanrl claude       # same for your latest Claude Code session
humanrl claude 3     # the latest three
humanrl              # open the demo (starts the stack if it is down)
humanrl status       # running or not, and every trace you have
humanrl stop
```

`humanrl import <file-or-directory>` takes any session bundle (source guessed from the path; add `--source codex|claude|opencode|omp|grok` if it cannot be). Codex sessions are read from `~/.codex/sessions`, Claude Code sessions from `~/.claude/projects`; `HUMANRL_CODEX_DIR` / `HUMANRL_CLAUDE_DIR` override that. Sessions over 64 MiB are skipped with a note. Imports strip hidden reasoning, encrypted content and host paths before anything is stored (see [Importing traces](UPSTREAM-README.md#importing-traces) in the upstream README).

Inside the repository the same commands are `pnpm humanrl codex`, `pnpm humanrl stop`, and so on. PostgreSQL comes from Docker Compose when you have it, otherwise from `docker run`, Homebrew `postgresql@17` or an existing `DATABASE_URL`, in that order. Logs are under `.intenttrace/logs/`. `HUMANRL_DIR` changes where the installer clones, `HUMANRL_NO_OPEN=1` keeps the browser closed.

## How to read the page

**Execution story** (left) is the run as a list you can read top to bottom:

- `▸ User request` is your prompt. `… Agent said` is what the agent told you between actions.
- `✓ read ×4 · Reading parallel dispatch skill +3` is one agent running one tool four times in a row. Click it to see the four calls; click a call to open its raw event and sanitized payload in the Evidence Inspector on the right. `!` means a call failed.
- `⑂ spawn · Orchestrator → 3 child agents · Paid off` is a handoff to subagents, with its verdict.
- `⇤ ImoBruteForce finished, joined by Orchestrator` is a child coming back.
- The left border colour is the agent's lane, the same colour as in the Gantt below.

**Prompt review** (right, top) shows the prompt you sent and one finding per thing it caused. `Fix` is money left on the table, `Improve` is a habit, `Note` is context. Each finding has **Show evidence**, which opens the raw event behind it.

**Prompt optimizer** says whether the root agent should spawn a subagent _now_ at the current replay position, and the **spawn ledger** rates every spawn that already happened. Drag the watermark slider under the panel and everything replays: before the first spawn the verdict is Hold with no signals, mid-run it is Hold because children are still out, at the end it is a post-mortem.

## Two real runs

**The bundled demo** is a recorded run where an orchestrator solved IMO 2025 P1 with eight parallel subagents (691 events, 9 lanes). The prompt was one Chinese sentence: _"use subagents to solve an IMO problem, make sure to use skills + subagents concurrently, make the trace real and complex."_ The review says:

|         | Finding                                                                                                    | What it means for the prompt                                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fix     | Agents reached for 3 tools that do not exist: `eval`, `write` and `bash` (5 failed calls in 2 lanes)       | The prompt implied machine verification; the environment had no code runner. Say which tools exist.                                                                       |
| Improve | Prompt is ~69 tokens; the orchestrator wrote ~2,400 tokens of task assignments to fill in what it left out | Show evidence opens assignment #29: deliverable path, slice, constraints, stop rule, all written by the orchestrator. That text is the prompt that should have been sent. |
| Note    | 78% of the delegated work went to "Scouting UI, ingest, docs conventions"                                  | The prompt's first sentence about screenshots pulled three of eight agents onto the repo instead of the maths. A side quest deserves its own prompt.                      |
| Improve | 4 actions repeated in more than one lane                                                                   | Two scouts both read the screenshot script; the slices overlapped.                                                                                                        |
| Note    | The orchestrator took 14 turns after the last child joined                                                 | Assembly happened in its heaviest context.                                                                                                                                |
| Note    | Delegation paid off: 3 waves, 8 agents, net ≥41k tokens kept out of the orchestrator                       | The parallel structure itself was right.                                                                                                                                  |

**A single-agent Codex session** (the one that built this repository, imported with `humanrl codex`) is the other kind of run: one agent, no subagents, 45 `exec` calls. The story collapses to "user asked → agent said what it would do → 8 commands → agent reported → 14 commands → …", each `exec` shown as the shell command it ran rather than the JavaScript wrapper Codex records. The review has one note: _Everything ran in one context: 45 tool calls, 48 turns, no subagent_, with the observation that the two repository reads were independent and a scout per repo would have kept their output out of the main context.

## What the prompt review checks

[`apps/web/lib/workbench/prompt-review.ts`](apps/web/lib/workbench/prompt-review.ts) produces one finding per pattern, each with the events as evidence:

| Finding                     | Trigger                                                                                 | What to change in the prompt                                    |
| --------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Missing tools (Fix)         | tool results that say "not found"                                                       | name the tools that exist, or drop that expectation             |
| Prompt too thin (Improve)   | the orchestrator's task assignments are ≥3× the size of the prompt                      | write the deliverable, slices, constraints and stop rule        |
| Poor spawn (Improve)        | a wave rated Marginal or Wasted                                                         | delegate only independent, heavy work                           |
| Dominant wave (Note)        | one wave ≥60% of all delegated work                                                     | split side quests into their own prompt                         |
| Overlapping lanes (Improve) | the same read/grep action in more than one lane (control tools such as `yield` ignored) | partition the work or share the context in each assignment      |
| Post-join assembly (Note)   | more than eight orchestrator turns after the last child joined                          | ask for a writeup or verifier agent                             |
| No delegation (Note)        | twenty or more tool calls in one context and no subagent                                | say which parts are independent and ask for a subagent per part |
| Delegation paid off (Note)  | every wave rated Paid off                                                               | keep the structure                                              |

Everything is derived from event metadata (kind, name, status, agent, attributes). The only prompt body ever loaded is your own, fetched from the sanitized payload so the page can show it. Harness-injected messages (AGENTS.md, environment context, skill catalogues) are recognised by shape and skipped.

## How the optimizer decides

Both rules live in [`apps/web/lib/workbench/prompt-optimizer.ts`](apps/web/lib/workbench/prompt-optimizer.ts) and are unit-tested against fixture-shaped events.

**Spawn now or hold (prospective).** A child lane is only worth its fresh context when the root lane shows an evidence gap or context pressure: tool failures (isolate the investigation), repeated identical tool calls (the root is looping), or more than six model turns already accumulated. The expected saving from those signals is compared with the cost of one child (fixed overhead plus a restated task). The verdict is always `Hold` while children are still running (wait for the join, do not double-spawn) and once the trace is complete.

**Was that spawn worth it (retrospective).** For each `agent_handoff`, the child lanes' tool results and model turns are what stayed out of the parent's context; that volume is the saving. The children's fixed context plus their task assignments is the cost. Net ≥ cost is Paid off, net ≥ 0 is Marginal, negative is Wasted, and a handoff with no child started yet is Pending.

All token figures are floors estimated from event counts, name lengths and payload sizes (CJK counted at one token per character); they are for comparison, not billing. Adapters that do not record `model_call` events (Codex) get their turn count from narrated assistant messages plus tool calls.

The story derivation (name parsing, FIFO result pairing inside a lane, step grouping, Codex `exec` command extraction) is in [`apps/web/lib/workbench/execution-story.ts`](apps/web/lib/workbench/execution-story.ts); the UI is [`apps/web/components/workbench/ExecutionStoryPanel.tsx`](apps/web/components/workbench/ExecutionStoryPanel.tsx).

## Running it by hand

`pnpm humanrl:up` is the whole of the above in one command. The IntentTrace Docker path (`pnpm docker:up`, `pnpm demo:load`) is unchanged, and the host-run steps are what the script does:

```bash
corepack pnpm --filter './packages/*' build
set -a; source .env.example; set +a          # DATABASE_URL points at 127.0.0.1:15432
corepack pnpm --filter @intenttrace/db migrate
corepack pnpm --filter @intenttrace/api dev &
corepack pnpm --filter @intenttrace/worker dev &
corepack pnpm --filter @intenttrace/web dev --hostname 127.0.0.1 --port 3000 &
INTENTTRACE_WEB_ORIGIN=http://127.0.0.1:3000 corepack pnpm demo:load
```

## Acknowledgements

HumanRL exists because of **[IntentTrace](https://github.com/chivier/IntentTrace)** by **[Chivier Humber](https://github.com/chivier)**. The append-only event model, the Codex/Claude/OpenCode/OMP/Grok adapters, the deterministic reducer behind the Intent Graph, the Agent Gantt, the replay watermark and the Evidence Inspector are all IntentTrace's work, vendored here unchanged from commit [`5de3e42`](https://github.com/chivier/IntentTrace/commit/5de3e428e36c3b1286bd069edd32ac75742aed7a). HumanRL adds the Execution story, the prompt review and the spawn accounting on top, and nothing in this repository would render without the foundation underneath it.

IntentTrace is © 2026 Chivier Humber, released under the GNU Affero General Public License v3.0 only; HumanRL is a derivative work under the same licence (see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE)). IntentTrace's own README is kept verbatim as [`UPSTREAM-README.md`](UPSTREAM-README.md) ([中文](UPSTREAM-README.zh-CN.md)); its quick start, architecture, import, security and contribution sections all apply here. If you find the trace model useful, star and cite the upstream project; bugs in the panel described above belong here, bugs in the adapters, reducer or API belong upstream.
