---
status: current
owner: maintainers
last_reviewed: 2026-08-12
normative: false
milestone: Gate 5
---

> 附录：Claude Code 的 spawn 记录实测原始报告。汇总与跨 harness 对比见 [六个 Agent Harness 的 spawn 记录格式](../agent-spawn-formats.md)。

# Claude Code

## Version and enablement

- Installed: **`2.1.228 (Claude Code)`** — `claude --version`.
- Binary `~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.228` (native build, not npm).
- **Subagents are on by default. There is no feature flag, no config key, no opt-in.** `~/.claude/settings.json` on this machine contains only `env`/`model`/`enabledPlugins`/`tui`/`skipDangerousModePermissionPrompt`/`theme`/`editorMode` — nothing agent-related — and both probes spawned on the first attempt with no retry and no flag naming the tool.
- The spawn tool ships in the default tool set and needs no permission grant beyond the normal tool-permission prompt. Probe used `--dangerously-skip-permissions` only to avoid an interactive prompt in a non-TTY; it is not required for the feature to exist.
- 13 agent _types_ were registered at probe time (`system/init.agents`): `academic-researcher, changelog-generator, claude, code-reviewer, docusaurus-expert, Explore, general-purpose, Plan, python-test-runner, research-brief-generator, semantic-git-committer, statusline-setup, technical-writer`. `general-purpose`, `Explore` and `Plan` are built in; the rest are user files in `~/.claude/agents/` (8 files present). A consumer must not assume a closed set.
- Relevant CLI switches (`claude --help`): `-p/--print`, `--output-format text|json|stream-json`, `--forward-subagent-text`, `--include-partial-messages`, `--agents <json>` (define ad-hoc agent types), `--tools` (restrict the built-in tool set), `--bg/--background`, and the `claude agents` subcommand for background agents.

## Where the trace lives

```
~/.claude/projects/
  <cwd-slug>/                                  # cwd with / and . replaced by -, e.g. -tmp-claude-spawn-probe
    sessions-index.json                        # optional cache, NOT always present (5 of 174 sessions)
    <rootSessionId>.jsonl                      # the parent/root transcript, one JSON object per line
    <rootSessionId>/
      subagents/
        agent-<agentId>.jsonl                  # one child transcript per subagent
        agent-<agentId>.meta.json              # sidecar: the only place the parent link is stored
        workflows/wf_<id>/
          agent-<agentId>.jsonl                # third class: workflow steps
          agent-<agentId>.meta.json
```

- Format: **JSONL, append-only, heterogeneous** — records are _not_ all chat messages. Observed `type` values in a root file include `queue-operation`, `user`, `assistant`, `attachment`, `ai-title`, `last-prompt`, `mode`, `permission-mode`, `system`, `pr-link`, `file-history-snapshot`.
- Note the collision: `<rootSessionId>` is both a **file** (`.jsonl`) and a **sibling directory** holding that session's children.
- Runtime mirror: `/tmp/claude-<uid>/<cwd-slug>/<rootSessionId>/tasks/<agentId>.output` is a **symlink** to the child's `.jsonl`, verified with `ls -l`. It is a `/tmp` artifact, not durable, and must not be treated as a second source.
- Newest session, one line:
  ```sh
  find ~/.claude/projects -maxdepth 2 -name '*.jsonl' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-
  ```
  (`-maxdepth 2` is what keeps child transcripts out; without it you get subagent files too.)
- Scale on this machine: 174 root sessions, 10 sessions with a `subagents/` dir, 157 `.meta.json` sidecars, 10 803 child records. 52 root files were unreadable (`Permission denied` on `~/.claude/projects/-workspace`, a root-owned directory) — an ingester must tolerate this rather than abort.

## Spawn: parent side

The parent writes an ordinary assistant `tool_use` block. **The tool is named `Agent`.** Verbatim from the probe (`232430eb…jsonl` record 8 of 11, `usage` object elided):

```json
{"parentUuid":"e49bcd8c-1fda-4520-a64a-307015a1919a","isSidechain":false,
 "message":{"model":"claude-opus-5","id":"msg_011Cdybng2cufqNp9qp8k5F2","type":"message","role":"assistant",
   "content":[{"type":"tool_use","id":"toolu_01DAjDwYd9kHwNGKp777RZCt","name":"Agent",
     "input":{"description":"Reply with one word",
              "prompt":"Reply with the single word BANANA. Nothing else.",
              "subagent_type":"general-purpose",
              "run_in_background":false},
     "caller":{"type":"direct"}}],
   "stop_reason":"tool_use","usage":{…}},
 "uuid":"467ecbd1-4e1f-41bd-bdcd-e5f47b37208c","timestamp":"2026-08-12T21:56:00.689Z",
 "sessionId":"232430eb-3cdc-44ab-933e-a50e0efecd0a","version":"2.1.228","cwd":"/tmp/claude-spawn-probe","gitBranch":"main"}
```

Measured, and important: **this record does not contain the child's `agentId`.** The only spawn-time handle is `message.content[].id` (`toolu_…`). `input.run_in_background` selects the sync or async join shape.

The full parent sequence for the probe was 11 records:

| #   | type              | content                                       | uuid→       | ts           |
| --- | ----------------- | --------------------------------------------- | ----------- | ------------ |
| 1   | `queue-operation` | `operation:"enqueue"`, raw prompt text        | _(no uuid)_ | 21:55:57.504 |
| 2   | `queue-operation` | `operation:"dequeue"`                         | _(no uuid)_ | 21:55:57.504 |
| 3   | `user`            | string content, `promptSource:"sdk"`          | 09ca9644    | 21:55:57.528 |
| 4   | `attachment`      | `agent_listing_delta` (lists spawnable types) | 5e37007f    | 21:55:57.528 |
| 5   | `attachment`      | `skill_listing`                               | ffd7c1cc    | 21:55:57.528 |
| 6   | `ai-title`        | `"Spawn subagent to return BANANA"`           | _(no uuid)_ | _(none)_     |
| 7   | `assistant`       | text `"I'll spawn one subagent for this."`    | e49bcd8c    | 21:56:00.074 |
| 8   | `assistant`       | **`tool_use` name=`Agent`**                   | 467ecbd1    | 21:56:00.689 |
| 9   | `user`            | **`tool_result` (join)**                      | 0a7f8ebf    | 21:56:02.423 |
| 10  | `assistant`       | final text                                    | 1d4fcd56    | 21:56:04.485 |
| 11  | `last-prompt`     | leaf pointer                                  | _(no uuid)_ | _(none)_     |

Records 1, 2, 6, 11 carry **no `uuid` and no `parentUuid`**; 6 and 11 carry **no `timestamp`**. Any ingester that assumes every line is a uuid-chained, timestamped message breaks on line 1.

## Spawn: child side

A new directory and two files appear. Sidecar **verbatim, complete** (`agent-aa2df15cf06a92b22.meta.json`, 127 bytes):

```json
{
  "agentType": "general-purpose",
  "description": "Reply with one word",
  "toolUseId": "toolu_01DAjDwYd9kHwNGKp777RZCt",
  "spawnDepth": 1
}
```

Child transcript first record, **verbatim**:

```json
{
  "parentUuid": null,
  "isSidechain": true,
  "promptId": "4a3f9ca5-95ec-4520-b209-df8086a265b1",
  "agentId": "aa2df15cf06a92b22",
  "type": "user",
  "message": { "role": "user", "content": "Reply with the single word BANANA. Nothing else." },
  "uuid": "7af85ed3-151c-483c-9ca4-cd6ce5f1a987",
  "timestamp": "2026-08-12T21:56:00.699Z",
  "userType": "external",
  "entrypoint": "sdk-cli",
  "cwd": "/tmp/claude-spawn-probe",
  "sessionId": "232430eb-3cdc-44ab-933e-a50e0efecd0a",
  "version": "2.1.228",
  "gitBranch": "main"
}
```

Measured facts:

- **`parentUuid` of the child's first record is `null`.** Confirmed. It starts a fresh uuid chain; it does _not_ point at the parent's `tool_use` record.
- **`isSidechain:true` on every child record**, and it never appears in a root file — a reliable file-class discriminator.
- **`agentId` is present on the child record itself**, not merely in the path. Census over the whole store: **10 803 / 10 803 child records (100 %) carry `agentId`**; zero exceptions of any `type`.
- **`sessionId` is the _root_ session id, not a child-specific id.** 10 592 / 10 592 child records carrying `sessionId` equal the root session directory name. There is no separate child session id.
- `promptId` (`4a3f9ca5-…`) is **shared with the parent's user turn** that triggered the spawn — verified equal in the probe.

Child sequence was 3 records: `user` (prompt) → `attachment` (`skill_listing`) → `assistant` (text `"BANANA"`). Note the child gets its own `attachment` records; those are not messages.

## The link

Three independent links, of decreasing reliability:

| Link                                        | From                                                | To                   | Strength                                                                                                                        |
| ------------------------------------------- | --------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **`meta.toolUseId` → parent `tool_use.id`** | `agent-<id>.meta.json`                              | parent record 8      | **This is the spawn edge.** Exact, and the only thing that binds a child to _one specific parent turn_.                         |
| **filesystem path**                         | `…/<rootSessionId>/subagents/agent-<agentId>.jsonl` | root session         | Binds child→session, not child→turn.                                                                                            |
| **`meta.parentAgentId`**                    | sidecar                                             | the _spawning agent_ | Present **only when `spawnDepth > 1`** (2 of 157 sidecars). Absent at depth 1, where the parent is implicitly the root session. |

`meta.toolUseId` is the answer to "which exact parent turn". Probe: sidecar `toolUseId` `toolu_01DAjDwYd9kHwNGKp777RZCt` === parent record 8's `message.content[0].id`. Exact string equality.

**Trap:** 109 of 157 sidecars have key-set `('agentType','spawnDepth')` only — **no `toolUseId`, no `description`**. All 109 are `agentType:"workflow-subagent"` under `subagents/workflows/wf_*/`. For those, _no spawn edge to a parent turn exists in the store at all_; the only parent link is the enclosing `wf_<id>` directory. Sidecar key-set census:

```
109  ('agentType','spawnDepth')                                          # workflow steps, unlinkable to a turn
 46  ('agentType','description','spawnDepth','toolUseId')                # normal depth-1 spawn
  2  ('agentType','description','parentAgentId','spawnDepth','toolUseId')# nested spawn
```

## Join: how results come back

Two shapes, chosen by `input.run_in_background`.

**Sync join** — an ordinary `tool_result` keyed by `tool_use_id`, plus a structured `toolUseResult`. Verbatim from the probe (record 9):

```json
{"parentUuid":"467ecbd1-4e1f-41bd-bdcd-e5f47b37208c","isSidechain":false,
 "promptId":"4a3f9ca5-95ec-4520-b209-df8086a265b1","type":"user",
 "message":{"role":"user","content":[{"tool_use_id":"toolu_01DAjDwYd9kHwNGKp777RZCt","type":"tool_result",
   "content":[{"type":"text","text":"BANANA"},
              {"type":"text","text":"agentId: aa2df15cf06a92b22 (use SendMessage with to: 'aa2df15cf06a92b22', summary: '<5-10 word recap>' to continue this agent)\n<usage>subagent_tokens: 26678\ntool_uses: 0\nduration_ms: 1725</usage>"}]}]},
 "uuid":"0a7f8ebf-6186-42b6-8f03-bfd34a77b2ad","timestamp":"2026-08-12T21:56:02.423Z",
 "toolUseResult":{"status":"completed","prompt":"Reply with the single word BANANA. Nothing else.",
   "agentId":"aa2df15cf06a92b22","agentType":"general-purpose",
   "content":[{"type":"text","text":"BANANA"}],
   "resolvedModel":"claude-opus-5[1m]","totalDurationMs":1725,"totalTokens":26678,"totalToolUseCount":0,
   "usage":{…}}}
```

`toolUseResult` is the good path: `agentId`, `agentType`, `status`, `totalDurationMs`, `totalTokens`, `totalToolUseCount` as real fields. **Do not parse the prose in `content[1].text`** — the same numbers are structured one level up.

**Async join** — a plain `user` message whose `message.content` is a **string of XML-ish prose**, with **no `toolUseResult` at all**. Verbatim (from `-home-<user>-Projects-polyweather/c500eb0b-….jsonl` record 97, `<result>` body truncated by me):

```json
{
  "parentUuid": "e818a3d6-3a25-4524-824e-be18e4d285d3",
  "isSidechain": false,
  "promptId": "09b70501-6c0a-41e0-b4d2-f55ca99c11b8",
  "type": "user",
  "message": {
    "role": "user",
    "content": "<task-notification>\n<task-id>a283c2bd3f4b7aab5</task-id>\n<tool-use-id>toolu_01GvFCXnBHBPHxiZEQKU222s</tool-use-id>\n<output-file>/tmp/claude-1001/-home-<user>-Projects-polyweather/c500eb0b-…/tasks/a283c2bd3f4b7aab5.output</output-file>\n<status>completed</status>\n<summary>Agent \"Map L2 valuation + contracts\" finished</summary>\n<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>\n<result>…</result>\n</task-notification>"
  },
  "origin": { "kind": "task-notification" },
  "promptSource": "system",
  "uuid": "…",
  "timestamp": "…",
  "sessionId": "c500eb0b-…"
}
```

Two saving graces measured here:

1. `origin:{"kind":"task-notification"}` and `promptSource:"system"` are **structured discriminators** — you can classify the record without regexing the body. Corpus census of `origin.kind`: `human` 98, `task-notification` 80, `coordinator` 1. `origin` only ever has the single key `kind` (179/179).
2. The async **launch ack** (the immediate `tool_result` for the spawn) _does_ carry structure:
   ```json
   "toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"a283c2bd3f4b7aab5",
                    "description":"Map L2 valuation + contracts","resolvedModel":"claude-opus-4-8[1m]","prompt":"…"}
   ```
   So even async, `agentId` is available in a real field ~immediately after the spawn.

`<task-notification>` is **not subagent-specific** — background `Bash` commands emit the identical envelope (`task_type: local_bash`). Distinguish by `<summary>` starting `Agent "` versus `Background command "`, or better, by whether `<task-id>` matches an `agent-<id>` file. The same envelope is additionally echoed into `queue-operation` (`enqueue` **and** `remove`) records and an `attachment{type:"queued_command"}` record, so a naive text scan counts one async join up to **four** times.

## Agent-to-agent messages

**Partially expressed, and weakly.** A `SendMessage` tool exists (present in `init.tools`) and is used in practice. Sender side, verbatim (`-home-<user>-Projects-polymarket-general/919e8fcc-….jsonl:977`, body truncated):

```json
{
  "type": "tool_use",
  "id": "toolu_01KaHcE68BBmAZm9LzPq2wcA",
  "name": "SendMessage",
  "input": {
    "to": "aee224a993c393c94",
    "summary": "Resume P2-1/P2-2 retrieval implementation",
    "message": "…"
  }
}
```

Recipient side lands in the child's own file, verbatim (`…/subagents/agent-aee224a993c393c94.jsonl` record 74, body truncated):

```json
{
  "parentUuid": "b16ca6a5-…",
  "isSidechain": true,
  "promptId": "c8793919-…",
  "agentId": "aee224a993c393c94",
  "type": "user",
  "message": {
    "role": "user",
    "content": "The coordinator sent a message while you were working:\n…"
  },
  "origin": { "kind": "coordinator" },
  "isMeta": true,
  "slug": "plan-md-purrfect-sundae",
  "uuid": "…",
  "timestamp": "…"
}
```

Assessment against "sender + recipient":

- **Recipient: yes, structurally.** `input.to` on the sender side is the recipient `agentId`.
- **Sender: no.** The recipient record carries `origin:{"kind":"coordinator"}` — a _role_, not an id. `origin` has only the key `kind` in all 179 occurrences. To learn who sent it you must find the matching `SendMessage` `tool_use` in the other file and pair it by content/time; there is no id on the received record.
- **No sibling channel observed.** `origin.kind` was `coordinator` in 1 of 179 records and never anything peer-like. Every `SendMessage` found was parent→child. `[INFERENCE]` The mechanism is addressed by `agentId` so sibling sends are probably representable, but this store contains no instance, so an ingester should not build on it.

## Nesting and identity

- **Depth is supported and real, up to 3 observed.** `spawnDepth` census over 157 sidecars: `1` → 155, `2` → 1, `3` → 1.
- **The layout stays flat.** A depth-2 and a depth-3 child both live directly in the _root_ session's `subagents/` directory, as siblings of their own parent's file — verified: for both nested sidecars, `agent-<parentAgentId>.jsonl` exists in the same directory. **Directory nesting does not mirror agent nesting**; only `parentAgentId` does. Reconstruct the tree from sidecars, never from paths.
- Id schemes:
  | id                  | shape                  | example                                | notes                                 |
  | ------------------- | ---------------------- | -------------------------------------- | ------------------------------------- |
  | `agentId`           | `a` + 16 lowercase hex | `aa2df15cf06a92b22`                    | 17 chars total; **not** time-sortable |
  | root `sessionId`    | UUIDv4                 | `232430eb-3cdc-44ab-933e-a50e0efecd0a` | not time-sortable                     |
  | `uuid` (per record) | UUIDv4                 | `7af85ed3-…`                           | not time-sortable                     |
  | `tool_use.id`       | `toolu_` + base62      | `toolu_01DAjDwYd9kHwNGKp777RZCt`       | not time-sortable                     |
  | background task id  | `b` + 9 chars          | `bcqr4je1b`                            | _bash_ tasks; distinct from `agentId` |
- **Lane key: `agentId`.** It is on 100 % of child records, it is in the filename, it is in `toolUseResult`, and it is the `<task-id>` in async joins. Use `agentId`, falling back to the literal string `root`/the session id for the parent lane (root records have no `agentId` field at all).
- **Do not use `sessionId` as a lane key** — parent and all descendants share one value.
- Nothing is time-sortable by id. Order by `timestamp`, tie-break by file offset.

**Wall-clock interleaving across files.** Measured and clean: every message-bearing record in both files carries `timestamp`, ISO-8601 UTC with milliseconds, from the same host clock. The probe interleaves strictly:

```
21:56:00.689  parent  tool_use Agent
21:56:00.699  child   user (prompt)          +10 ms
21:56:00.708  child   attachment
21:56:02.330  child   assistant "BANANA"
21:56:02.423  parent  tool_result (join)     +93 ms after child's last record
```

So the recipe is: concatenate the root file and every `subagents/**/agent-*.jsonl`, **drop records lacking `timestamp`** (`ai-title`, `last-prompt`, `mode`, and similar bookkeeping lines), sort by `timestamp`, and lane by `agentId`. No clock skew correction is needed — one process writes both files. The child interval is strictly contained in `[tool_use.timestamp, tool_result.timestamp]` for sync spawns; for async spawns it is **not** contained, which is exactly the case a single-lane flattening destroys.

## Probe transcript

Scratch dir `/tmp/claude-spawn-probe` (fresh, `git init`, one `README.md`). Store slug `~/.claude/projects/-tmp-claude-spawn-probe` did not exist before.

**Before:** `find ~/.claude/projects -type d -name subagents | wc -l` → **8**; `~/.claude/projects/-tmp-claude-spawn-probe` → absent (0 files).

**Probe 1** (spawn 1 of 2):

```sh
cd /tmp/claude-spawn-probe && claude -p "Spawn exactly one subagent and give it this task: reply with the single word BANANA. Wait for it, then report the word it returned and the subagent's id. Do not answer BANANA yourself." \
  --output-format stream-json --verbose --forward-subagent-text --dangerously-skip-permissions
```

exit 0, 7.93 s, 11 stream lines. **Spawned on the first attempt — no retry, no tool-naming prompt needed.** Final text: `Word returned: BANANA / Subagent id: aa2df15cf06a92b22 (type: general-purpose)`.

**Probe 2** (spawn 2 of 2, control — identical prompt, `--forward-subagent-text` **removed**):
exit 0, 7.68 s, 10 stream lines.

**After:** subagents dirs **8 → 10** (+1 per probe). Probe project dir **0 → 6 files**:

```
~/.claude/projects/-tmp-claude-spawn-probe/232430eb-3cdc-44ab-933e-a50e0efecd0a.jsonl                                  21880 B, 11 records
~/.claude/projects/-tmp-claude-spawn-probe/232430eb-3cdc-44ab-933e-a50e0efecd0a/subagents/agent-aa2df15cf06a92b22.jsonl  9338 B,  3 records
~/.claude/projects/-tmp-claude-spawn-probe/232430eb-3cdc-44ab-933e-a50e0efecd0a/subagents/agent-aa2df15cf06a92b22.meta.json  127 B
~/.claude/projects/-tmp-claude-spawn-probe/5cb21cb1-048f-4e4a-ac09-8d8e9fea274f.jsonl
~/.claude/projects/-tmp-claude-spawn-probe/5cb21cb1-048f-4e4a-ac09-8d8e9fea274f/subagents/agent-a07ec3c0dcc3f5069.jsonl
~/.claude/projects/-tmp-claude-spawn-probe/5cb21cb1-048f-4e4a-ac09-8d8e9fea274f/subagents/agent-a07ec3c0dcc3f5069.meta.json
```

|                   | probe 1                                | probe 2                                |
| ----------------- | -------------------------------------- | -------------------------------------- |
| root sessionId    | `232430eb-3cdc-44ab-933e-a50e0efecd0a` | `5cb21cb1-048f-4e4a-ac09-8d8e9fea274f` |
| child agentId     | `aa2df15cf06a92b22`                    | `a07ec3c0dcc3f5069`                    |
| spawn tool_use id | `toolu_01DAjDwYd9kHwNGKp777RZCt`       | `toolu_01LBQvY9BzKm5wArH79j39Kb`       |

Global `find ~/.claude/projects -type f | wc -l` is **not** a usable before/after metric here: `~/.claude/projects/-workspace` is root-owned and aborts traversal non-deterministically (52 root files unreadable). The subagents-dir count and the probe-dir listing above are the reliable deltas.

**`--output-format stream-json` is strictly richer than the on-disk JSONL.** It emits three `system` records that have **no on-disk counterpart**. Verbatim, probe 1:

```json
{"type":"system","subtype":"task_started","task_id":"aa2df15cf06a92b22","tool_use_id":"toolu_01DAjDwYd9kHwNGKp777RZCt","description":"Reply with one word","subagent_type":"general-purpose","task_type":"local_agent","prompt":"Reply with the single word BANANA. Nothing else.","uuid":"a570b373-5d47-4abf-b4b2-060392806435","session_id":"232430eb-3cdc-44ab-933e-a50e0efecd0a"}
{"type":"system","subtype":"task_updated","task_id":"aa2df15cf06a92b22","patch":{"status":"completed","end_time":1786571762421},"uuid":"6335504f-…","session_id":"232430eb-…"}
{"type":"system","subtype":"task_notification","task_id":"aa2df15cf06a92b22","tool_use_id":"toolu_01DAjDwYd9kHwNGKp777RZCt","status":"completed","output_file":"/tmp/claude-1001/-tmp-claude-spawn-probe/232430eb-…/tasks/aa2df15cf06a92b22.output","summary":"BANANA","usage":{"total_tokens":26673,"tool_uses":0,"duration_ms":1724},"uuid":"bcdf78ee-…","session_id":"232430eb-…"}
```

What the stream adds over disk:

1. **`task_started` names `task_id` (= child `agentId`) _at spawn time_, alongside `tool_use_id`** — the exact structured spawn edge the on-disk parent file lacks. Also `task_type:"local_agent"`, which cleanly separates subagents from `local_bash` background tasks.
2. `task_updated.patch.end_time` — an **epoch-ms** timestamp (`1786571762421`), the only numeric time in the whole surface.
3. `task_notification` gives `output_file`, `summary`, `usage` as fields even for the sync case, where on disk this event does not exist at all.
4. Forwarded child records carry envelope keys absent from disk: `parent_tool_use_id`, `subagent_type`, `task_description`, `session_id`.
5. `system/init` (first line) enumerates `tools`, `agents`, `skills`, `model`, `permissionMode`, `cwd`, `claude_code_version`.

Stream and disk are **joinable**: the forwarded child record's `uuid` `7af85ed3-151c-483c-9ca4-cd6ce5f1a987` is byte-identical to the child file's first record `uuid`.

`--forward-subagent-text` was isolated by the control probe: it adds the child's **assistant** records (text/thinking) to the stream. Probe 1 had 2 records with `parent_tool_use_id` (child `user` + child `assistant`); probe 2 had 1 (child `user` only). The three `task_*` system records appear **unconditionally**. So the flag is required to see child _output_ live, but not to see the spawn/join edges.

## Gaps and traps

1. **The tool is named `Agent` on disk, but `Task` in the handshake.** `system/init.tools` advertises `Task`; every recorded `tool_use.name` is `Agent`. Corpus census of `tool_use.name ∈ {Agent, Task}` by `version`: `Agent` at 2.1.193 (2), 2.1.199 (4), 2.1.215 (2), 2.1.220 (30), 2.1.221 (3), 2.1.222 (4), 2.1.228 (1) — **`Task` never occurs, 0 of 46**. Matching on `name === "Task"` finds nothing; matching on `init.tools` finds the wrong string. Match `Agent`, and treat `Task` as a legacy alias `[INFERENCE]`.
2. **The child's `sessionId` is the parent's.** Keying lanes, traces or sessions off `sessionId` silently merges all six agents of a run into one. This is precisely the flattening bug. Key off `agentId`.
3. **`parentUuid: null` on the child's first record.** The uuid chain does not cross the file boundary. A consumer that reconstructs a tree purely from `parentUuid` produces N disconnected forests and no spawn edges. The edge lives _only_ in `meta.json`.
4. **`meta.json` is the load-bearing file and it is easy to miss.** It is not `.jsonl`, so glob patterns like `**/*.jsonl` skip it. Lose it and 46 of 48 non-workflow spawn edges become unrecoverable.
5. **109 of 157 sidecars have no `toolUseId`** — the `workflows/wf_*/` class. Those children are **permanently unlinkable to a parent turn**; the best available parent is the `wf_<id>` group. Report them as a group, do not invent an edge.
6. **Async joins are prose.** No `toolUseResult`, content is a string of pseudo-XML. Use `origin.kind === "task-notification"` to detect, then parse `<task-id>`/`<tool-use-id>`. Do not regex the whole file for `<task-notification>`: the same envelope also appears in `queue-operation` (`enqueue` and `remove`) and `attachment{type:"queued_command"}` records, giving up to **4 hits per real join**. Dedupe on `<task-id>` + `<tool-use-id>`.
7. **`<task-notification>` covers background _bash_ too.** `task_type` is `local_bash` for those, and their `<task-id>` is a `b`-prefixed 10-char id, not an `agentId`. Filter, or you will invent phantom agents. (Historic corpus: the large majority of `<task-notification>` records are bash, not subagents.)
8. **The same `<task-id>` may notify more than once** — the harness says so itself in the `<note>` element: an agent that is resumed via `SendMessage` re-notifies. Joins are therefore **not** 1:1 with spawns. Treat the agent lane as resumable, not as a single closed interval.
9. **`origin` is new and sparse** — only 179 records in the entire 174-session store have it. Older sessions have no `origin`, so detection must fall back to a string prefix check on `message.content`. Version drift is real: `origin`, `promptSource`, `slug`, `caller` all appear only in recent versions (store spans 2.1.193 → 2.1.228).
10. **Root files are not message streams.** `queue-operation`, `ai-title`, `last-prompt`, `mode`, `permission-mode`, `pr-link`, `file-history-snapshot` records have **no `uuid`, and sometimes no `timestamp`**. Line 1 of the probe's parent file is a `queue-operation`. Naive `JSON.parse(line).message.content` throws on the first line.
11. **`message.content` is `string | Array<block>`**, inconsistently, in both parent and child files. Both shapes appear in the probe alone.
12. **Reasoning is stored.** `thinking` blocks with `signature` (and empty `thinking` strings whose content is in the signature blob) are present throughout. An ingester must drop these explicitly; they are not redacted at rest.
13. **`/tmp/claude-<uid>/…/tasks/<id>.output` is a symlink into the store**, so a crawler following both paths double-counts every child. It is also volatile — after a reboot the async join's `<output-file>` points at nothing.
14. **Sender identity in peer messages is unrecoverable from the recipient record** (`origin.kind:"coordinator"` only). Pair with the sender's `SendMessage` `tool_use` or accept an anonymous inbound edge.
15. **Permission errors are normal.** 52 of 174 root files were unreadable here. Skip and count; do not abort the import.
