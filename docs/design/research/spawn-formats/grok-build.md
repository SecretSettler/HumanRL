---
status: current
owner: maintainers
last_reviewed: 2026-08-12
normative: false
milestone: Gate 5
---

> 附录：Grok Build 的 spawn 记录实测原始报告。汇总与跨 harness 对比见 [六个 Agent Harness 的 spawn 记录格式](../agent-spawn-formats.md)。

# Grok Build (xAI `grok` CLI)

## Version and enablement

**Product identity (measured).** `~/.local/bin/grok` is a symlink chain to a **native ELF x86_64 binary**, not a Node shim:

```
~/.local/bin/grok -> ~/.grok/bin/grok -> ~/.grok/downloads/grok-1.0.3-linux-x86_64   (158.1 MB)
```

- `grok --version` → `grok 1.0.3 (1a29d5bc12) [stable]`
- `grok --help` header → `Grok Build TUI`
- Rust internals, from crate names in the debug log: `xai_grok_shell`, `xai_acp_lib`, `xai_grok_telemetry`.
- Vendor: xAI. Auth issuer `https://auth.x.ai`; API base `https://api.x.ai/v1`; marketplace `https://github.com/xai-org/plugin-marketplace.git` (from `~/.grok/config.toml`).

**"grok build" is the product name, not a subcommand or a mode.** There is no `grok build` verb: the 22 top-level subcommands are `agent`, `completions`, `dashboard`, `doctor`, `du`, `export`, `help`, `inspect`, `leader`, `login`, `logout`, `mcp`, `memory`, `models`, `plugin`, `sessions`, `setup`, `trace`, `update`, `version`, `worktree`, `wrap`. The name surfaces in three places: the `--help` title `Grok Build TUI`, the default model id `grok-build` (`[models] default = "grok-build"` → `Grok Build 4.6` → `grok-4.6`), and the tool namespace `grok_build` stamped on every tool call record.

**Upstream documentation.** The authoritative reference is shipped _inside_ the install: `~/.grok/README.md` (106.7 KB, 2689 lines) plus `~/.grok/docs/user-guide/`. Everything cited below comes from that file or from measurement, not from the web. No public source repository is bundled; the binary is distributed pre-compiled via `grok update` into `~/.grok/downloads/`.

**Subagents are ENABLED BY DEFAULT.** Measured from `grok --help`: the only flag is the negative `--no-subagents` ("Disable subagent spawning"). There is no `--subagents` flag. `~/.grok/README.md:1687` states plainly: _"Subagents spawn independent child sessions that handle tasks in parallel. Each child has its own context window and can optionally inherit the parent's conversation history. **Enabled by default.**"_

Ways to turn them off or shape them:

| Control                                                    | Effect                                                                                                                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--no-subagents` (CLI)                                     | disable spawning for the session                                                                                                                                                   |
| `GROK_SUBAGENTS=0` (env)                                   | disable spawning                                                                                                                                                                   |
| `[subagents] enabled = false` in `~/.grok/config.toml`     | disable spawning                                                                                                                                                                   |
| `[subagents.toggle] <name> = false`                        | disable one subagent type, keep the system on                                                                                                                                      |
| `[subagents.models] <name> = "<model>"`                    | pin one subagent type to a model (highest priority)                                                                                                                                |
| `[subagents.roles.<name>]` / `[subagents.personas.<name>]` | reusable capability/model defaults; persona prompt layering. Also discovered from `.grok/roles/*.toml` and `.grok/personas/*.toml`. Missing persona = **fail-closed**, spawn fails |
| `--disallowed-tools "Agent"` / `"Agent(explore)"`          | remove the spawn tool, or block one subagent type                                                                                                                                  |
| `--agent <NAME>` / `--agents <JSON>`                       | select an agent profile, or inject inline subagent definitions                                                                                                                     |

Bundled agent definitions live in `~/.grok/bundled/agents/`: `general-purpose.md`, `explore.md`, `plan.md`. The live config in this install (`grok inspect`) reports `Agents (8)`.

Current install's `~/.grok/config.toml` has **no `[subagents]` section at all** — i.e. the default (enabled) is in force, unmodified.

## Where the trace lives

Root: `~/.grok/` (overridable; child records echo it as `grok_home`).

```
~/.grok/
  sessions/
    <percent-encoded-absolute-cwd>/          e.g. %2Fhome%2F<user>%2FProjects%2Fcot-patcher
      <session-id>/                          UUIDv7
        summary.json            index entry: title, model, timestamps, session_kind, agent_name
        updates.jsonl           ** authoritative record: ACP JSON-RPC notifications, compact JSON, one per line
        chat_history.jsonl      raw messages sent to the model
        events.jsonl            lifecycle/telemetry stream (phase_changed, tool_started, turn_started, …)
        system_prompt.txt        prompt_context.json      signals.json
        plan.json  plan.md      rewind_points.jsonl      hunk_records.jsonl
        terminal/call-<uuid>-<n>.log         per-shell-call captured output
        compaction/  compaction_checkpoints/  compaction_requests/  recap_requests/
        goal/                   goal classifier / planner / verifier artifacts
        subagents/<child-session-id>/meta.json      ** parent-side child manifest
        subagents/<child-session-id>/output.json    ** child's returned result
    session_search.sqlite       FTS index (see below)
  logs/unified.jsonl            global cross-session log, keyed by "sid"
  memtrace/*.jsonl              cross-session memory traces (14 files, rotated with .1 suffix)
  bundled/agents|skills|personas|roles/        auth.json   config.toml   worktrees.db
```

**Formats.** `updates.jsonl`, `chat_history.jsonl`, `events.jsonl`, `logs/unified.jsonl`, `memtrace/*.jsonl` are JSONL, **compact serialization with no spaces** (verified: the raw bytes are `…-14","title":"spawn_subagent","rawInput":{…`). `summary.json`, `meta.json`, `output.json` are single JSON objects. Nothing is compressed at rest.

**Measured store census (this install).**

| Quantity                              | Count                |
| ------------------------------------- | -------------------- |
| cwd buckets                           | 10 (9 with sessions) |
| session directories                   | 214                  |
| directories with `summary.json`       | 214 (all)            |
| `updates.jsonl` files                 | 184                  |
| root sessions (`session_kind` absent) | **46**               |
| `session_kind: "subagent"`            | **56**               |
| `session_kind: "subagent_resume"`     | **104**              |
| `session_kind: "subagent_fork"`       | **8**                |
| subtotal, child sessions              | **168**              |
| `subagents/*/meta.json` files         | **168**              |
| parents that ever spawned             | **4**                |

Date range by UUIDv7 timestamp: **2026-07-15T07:26:26.008Z → 2026-08-10T18:46:44.558Z**.

**SQLite.** `~/.grok/sessions/session_search.sqlite` (3.7 MB) is an FTS5 search index only — no parent/child graph:

| table                      | rows |
| -------------------------- | ---- |
| `meta`                     | 2    |
| `session_docs`             | 51   |
| `session_docs_fts`         | 51   |
| `session_docs_fts_config`  | 1    |
| `session_docs_fts_data`    | 275  |
| `session_docs_fts_docsize` | 51   |
| `session_docs_fts_idx`     | 272  |

It indexes only 51 of 214 sessions, so it is unusable as an enumeration source. `~/.grok/worktrees.db` (40 KB) tracks git worktrees, not traces.

**How to find the newest session:** session ids are UUIDv7, so lexical order is chronological — `ls -d ~/.grok/sessions/*/*/ | sort -t/ -k7 | tail -1`, or authoritatively `grok sessions list` (but see the trap: it hides children).

## Spawn: parent side

A spawn writes **four** parent-side artifacts. The first two land in `updates.jsonl`; the fourth is a separate file.

**(1) The tool call** — standard ACP `session/update`, `sessionUpdate: "tool_call"`. Note the vendor tool metadata block, `kind: "task"`, `namespace: "grok_build"`, and `background: true`:

```json
{
  "timestamp": 1784967203,
  "method": "session/update",
  "params": {
    "sessionId": "019f97e1-509d-7e71-8ee4-3eb2302d1871",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "call-c603c315-9273-48a7-bcaa-044b64137c60-14",
      "title": "spawn_subagent",
      "rawInput": {
        "description": "GitHub CoT decrypt search",
        "prompt": "Research GitHub (repos, issues, PRs, gists, discussions) for the last ~6 months …",
        "subagent_type": "general-purpose",
        "capability_mode": "read-only",
        "background": true
      },
      "_meta": {
        "x.ai/tool": {
          "version": 1,
          "name": "spawn_subagent",
          "kind": "task",
          "namespace": "grok_build",
          "label": "Task",
          "read_only": false
        }
      }
    }
  }
}
```

**(2) The structured spawn event — the record that actually matters.** It is carried on the **vendor-extension method `_x.ai/session/update`**, _not_ on `session/update`:

```json
{
  "timestamp": 1784967203,
  "method": "_x.ai/session/update",
  "params": {
    "sessionId": "019f97e1-509d-7e71-8ee4-3eb2302d1871",
    "update": {
      "sessionUpdate": "subagent_spawned",
      "subagent_id": "019f9856-0c63-7800-b675-fc25e5d571f2",
      "parent_session_id": "019f97e1-509d-7e71-8ee4-3eb2302d1871",
      "parent_prompt_id": "961b7f0f-5728-482d-bd70-249576a20010",
      "child_session_id": "019f9856-0c63-7800-b675-fc25e5d571f2",
      "subagent_type": "general-purpose",
      "description": "GitHub CoT decrypt search",
      "effective_context_source": "new",
      "capability_mode": "read-only",
      "model": "grok-4.5"
    },
    "_meta": {
      "eventId": "019f97e1-509d-7e71-8ee4-3eb2302d1871-328",
      "agentTimestampMs": 1784967203942
    }
  }
}
```

The `resumed`/`forked` variant adds `resumed_from`, naming the _previous_ child session whose context was inherited:

```json
{
  "timestamp": 1784207352,
  "method": "_x.ai/session/update",
  "params": {
    "sessionId": "019f69ab-57f6-71f2-97c8-4094976dfe1b",
    "update": {
      "sessionUpdate": "subagent_spawned",
      "subagent_id": "019f6b0b-a164-76d1-be64-58b846584334",
      "parent_session_id": "019f69ab-57f6-71f2-97c8-4094976dfe1b",
      "parent_prompt_id": "09b608b3-3afb-491b-bcee-35530f8472af",
      "child_session_id": "019f6b0b-a164-76d1-be64-58b846584334",
      "subagent_type": "general-purpose",
      "description": "goal achievement skeptic",
      "effective_context_source": "resumed",
      "model": "grok-4.5",
      "resumed_from": "019f6b09-01dd-7500-9b9d-f3baaef06802"
    },
    "_meta": {
      "eventId": "019f69ab-57f6-71f2-97c8-4094976dfe1b-42760",
      "agentTimestampMs": 1784207352206
    }
  }
}
```

Field census over all **168** `subagent_spawned` records: key union `capability_mode, child_session_id, context_normalized, description, effective_context_source, model, parent_prompt_id, parent_session_id, resumed_from, sessionUpdate, subagent_id, subagent_type`. `capability_mode` is present on only 16 (`read-only` 13, `all` 3) and `null` on 152. `model`: `grok-4.5` 163, `grok-composer-2.5-fast` 5. `subagent_type`: `general-purpose` 167, `technical-writer` 1.

**(3) The tool-call completion, which leaks the child id only as prose.** This is the record a naive ingester sees, and the id is _inside a text blob_:

```json
{
  "sessionUpdate": "tool_call_update",
  "toolCallId": "call-c603c315-…-14",
  "status": "completed",
  "content": [
    {
      "type": "content",
      "content": {
        "type": "text",
        "text": "Subagent started in background.\nsubagent_id: 019f9856-0c63-7800-b675-fc25e5d571f2\ntype: general-purpose\ndescription: GitHub CoT decrypt search\n\nUse get_command_or_subagent_output with task_ids=[\"019f9856-0c63-7800-b675-fc25e5d571f2\"] and timeout_ms to wait for results."
      }
    }
  ],
  "rawOutput": {
    "type": "Text",
    "text": "Subagent started in background.\nsubagent_id: 019f9856-…"
  }
}
```

An intermediate `tool_call_update` also rewrites the display title from `spawn_subagent` to the human `description` and sets `rawInput.variant: "Task"` — so the same `toolCallId` appears under two different titles.

**(4) `subagents/<child-session-id>/meta.json`** — the durable parent-side manifest, written under the parent's directory:

```json
{
  "subagent_id": "019fa28a-c252-7392-ae4c-a072566b464c",
  "parent_session_id": "019f97e1-509d-7e71-8ee4-3eb2302d1871",
  "child_session_id": "019fa28a-c252-7392-ae4c-a072566b464c",
  "subagent_type": "general-purpose",
  "description": "Grok sim S-Ctrl-1 short seal",
  "prompt": "Simulate … for ONE turn only. …",
  "status": "completed",
  "started_at": "2026-07-27T07:47:10.553286639Z",
  "completed_at": "2026-07-27T07:47:24.830893221Z",
  "duration_ms": 14278,
  "tool_calls": 0,
  "turns": 1,
  "effective_context_source": "new",
  "child_cwd": "~/Projects/cot-patcher",
  "effective_model_id": "grok-4.5"
}
```

Key union over 168 files: `child_cwd, child_session_id, completed_at, context_normalized, description, duration_ms, effective_context_source, effective_model_id, error, parent_session_id, prompt, resumed_from, started_at, status, subagent_id, subagent_type, tool_calls, turns`. `status`: `completed` 167, `cancelled` 1. `effective_context_source`: `resumed` 104, `new` 56, `forked` 8.

**Measured negative on the tool call.** Across all 184 `updates.jsonl`, `"spawn_subagent"` appears in only **2** files (32 occurrences) while `subagent_spawned` appears **168** times in **4** files. So **most spawns have no visible `spawn_subagent` tool call at all** — they are issued by internal subsystems (the `goal`/planner/verifier roles; `subagent_coordinator` appears in the binary's symbol strings). An ingester that keys on the tool call will miss the majority. `subagent_spawned` is the only complete source.

## Spawn: child side

**The child gets a full, ordinary session directory — as a sibling of its parent, in the same cwd bucket.** It is not nested under the parent:

```
~/.grok/sessions/%2Fhome%2F<user>%2FProjects%2Fcot-patcher/
  019f97e1-509d-7e71-8ee4-3eb2302d1871/     <- parent
  019f9856-0c63-7800-b675-fc25e5d571f2/     <- child, same directory level
```

The child directory holds `summary.json`, `updates.jsonl` (620,666 B), `chat_history.jsonl`, `events.jsonl`, `system_prompt.txt`, `prompt_context.json`, `signals.json`, `rewind_points.jsonl`, `resources_state.json`, `announcement_state.json` — the same shape as a root session, minus `plan.md`/`terminal/`/`compaction*` in this instance.

**Child `summary.json`** — self-identifies as a subagent, and names the agent profile:

```json
{
  "info": { "id": "019f9856-0c63-7800-b675-fc25e5d571f2", "cwd": "~/Projects/cot-patcher" },
  "session_summary": "Claude CoT Decrypt GitHub Research Inventory",
  "created_at": "2026-07-25T08:13:23.942998053Z",
  "updated_at": "2026-07-25T08:15:25.215591636Z",
  "num_messages": 84,
  "num_chat_messages": 65,
  "current_model_id": "grok-4.5",
  "next_trace_turn": 0,
  "chat_format_version": 1,
  "session_kind": "subagent",
  "grok_home": "~/.grok",
  "last_active_at": "2026-07-25T08:15:25.215591636Z",
  "generated_title": "Claude CoT Decrypt GitHub Research Inventory",
  "agent_name": "general-purpose",
  "sandbox_profile": "off",
  "reasoning_effort": "high"
}
```

`session_kind` takes exactly three child values — `subagent` (56), `subagent_resume` (104), `subagent_fork` (8) — mirroring `effective_context_source`. On root sessions the key is **absent** (46 sessions); the parent's `summary.json` instead carries `agent_name` of its own profile (e.g. `grok-build-plan`) and a `request_id`.

**Child `prompt_context.json`** — the second self-identification:

```json
{
  "version": 1,
  "prompt_mode": "extend",
  "audience": "subagent",
  "prompt_body": "Complete the assigned task directly. Do what was asked; nothing more, nothing less. Respond with a detailed writeup when done.\n\nStrengths:\n- Searching across large codebases …"
}
```

**Child's first `updates.jsonl` record** is an ordinary `user_message_chunk` carrying the spawn prompt verbatim — there is no child-side "I was spawned" event, and `sessionId` is the child's own:

```json
{"timestamp":…,"method":"session/update","params":{
 "sessionId":"019f9856-0c63-7800-b675-fc25e5d571f2",
 "update":{"sessionUpdate":"user_message_chunk",
  "content":{"type":"text","text":"Research GitHub (repos, issues, PRs, gists, discussions) for the last ~6 months …"},
  "_meta":{…}}}}
```

**Hard measured negative: the child never names its parent.** For child `019f9856-…` against parent id `019f97e1-509d-7e71-8ee4-3eb2302d1871`:

| child artifact             | occurrences of the parent id                 |
| -------------------------- | -------------------------------------------- |
| `updates.jsonl` (84 lines) | **0**                                        |
| `events.jsonl` (528,366 B) | **0**                                        |
| `system_prompt.txt`        | **0** (`False`)                              |
| `summary.json`             | **0** — no parent field exists in the schema |

The parent→child edge exists **only on the parent side**.

## The link

**Child→parent identity:** `parent_session_id` inside the parent's `subagent_spawned` update, and independently `parent_session_id` inside `subagents/<child>/meta.json`. Both are present on 168/168 records. Recovering the edge from the child alone is impossible; you must read parents. Since children live as siblings in the same cwd bucket, the practical algorithm is: enumerate every session, treat `session_kind ∈ {subagent, subagent_resume, subagent_fork}` as a child, and resolve its parent by scanning all `subagents/*/meta.json` (or all `subagent_spawned` records).

**The child id itself:** `subagent_id == child_session_id` on **168/168** records — the two field names are redundant, and the value is the child's real session id, which is also its directory name. That is the join key everywhere: `meta.json` filename, `subagents/` dir name, `task_ids[]` in the join tool, and `task_id` in the result.

**Spawn→exact parent turn:** `parent_prompt_id` is the intended tie, matching the `promptId` stamped in `_meta` on the parent's own `session/update` records. **But it is unreliable** — present on only **53 of 168** spawns:

| `effective_context_source` | has `parent_prompt_id` | missing |
| -------------------------- | ---------------------- | ------- |
| `forked`                   | 8                      | 0       |
| `new`                      | 44                     | 12      |
| `resumed`                  | 1                      | **103** |

So for resumed subagents — the majority (104/168) — there is no prompt-level anchor at all.

Two weaker fallbacks exist, both measured:

- **`_meta.eventId`**, formatted `<parent-session-id>-<monotonic-seq>` (e.g. `019f97e1-509d-7e71-8ee4-3eb2302d1871-328`). It both re-states the parent id and gives a total order within the parent stream, so it can position a spawn between turns even when `parent_prompt_id` is null.
- **`~/.grok/logs/unified.jsonl`**, where the parent is re-woken by a _synthetic_ prompt id embedding the child id:
  ```json
  {
    "ts": "2026-07-24T10:40:16.454Z",
    "src": "shell",
    "pid": 398966,
    "lvl": "info",
    "sid": "019f9031-96fa-7331-a288-95defb38f768",
    "msg": "shell.handle_prompt.start",
    "ctx": {
      "prompt_id": "subagent-completed-019f93b1-e000-7230-9107-01da9f91a529",
      "block_count": 1
    }
  }
  ```
  `sid` is the parent, `prompt_id` is `subagent-completed-<child_session_id>`. This ties the _join_ to a parent turn even where `parent_prompt_id` is absent.

**Do not use `toolCallId` as the link.** It is present only for the ~19% of spawns that came from a visible `spawn_subagent` call, and the same `toolCallId` is reused by the later `get_command_or_subagent_output` join for a _batch_ of children.

## Join: how results come back

Results come back **structurally, in three redundant places** — this format is unusually generous here.

**(1) `subagent_finished`, again on `_x.ai/session/update`:**

```json
{
  "timestamp": 1784967325,
  "method": "_x.ai/session/update",
  "params": {
    "sessionId": "019f97e1-509d-7e71-8ee4-3eb2302d1871",
    "update": {
      "sessionUpdate": "subagent_finished",
      "subagent_id": "019f9856-0c63-7800-b675-fc25e5d571f2",
      "child_session_id": "019f9856-0c63-7800-b675-fc25e5d571f2",
      "status": "completed",
      "tool_calls": 31,
      "turns": 1,
      "duration_ms": 121273,
      "tokens_used": 108400,
      "output": "# GitHub / Public Inventory: Claude/Anthropic CoT, Encrypted Thinking, Signatures (≈2026-01 → 2026-07)\n\n## Executive summary\n\n**No public GitHub repo, issue, PR, gist, or discussion in this window documents a successful cryptographic decrypt …"
    }
  }
}
```

Key union over 168 records: `child_session_id, duration_ms, error, output, sessionUpdate, status, subagent_id, tokens_used, tool_calls, turns, will_wake`. `tokens_used` present on 168/168. `status`: `completed` 167, `cancelled` 1. Counts are exactly balanced: **168 `subagent_spawned` ↔ 168 `subagent_finished`** — every spawn has a terminator, so no reconciliation heuristics are needed. Note `subagent_finished` carries **no** `parent_session_id`; you must correlate on `child_session_id`.

**(2) The explicit join tool.** The parent waits with `get_command_or_subagent_output` (`kind: "background_task_action"`), passing a **batch** of child ids:

```json
{
  "sessionUpdate": "tool_call",
  "toolCallId": "call-f283ecc6-365b-4763-859d-09abdaec90ba-35",
  "title": "get_command_or_subagent_output",
  "rawInput": {
    "task_ids": [
      "019f9856-0c63-7800-b675-fc25e5d571f2",
      "019f9856-0c64-75c1-867f-0ef9d0f8878b",
      "019f9856-0c64-75c1-867f-0f0b8a2fd612"
    ],
    "timeout_ms": 300000
  },
  "_meta": {
    "x.ai/tool": {
      "version": 1,
      "name": "get_command_or_subagent_output",
      "kind": "background_task_action",
      "namespace": "grok_build",
      "label": "Background Task",
      "read_only": true
    }
  }
}
```

and the completion is a fully typed multi-result — **not** a text envelope:

```json
{
  "sessionUpdate": "tool_call_update",
  "toolCallId": "call-f283ecc6-…-35",
  "status": "completed",
  "title": "multi-wait (wait_all)",
  "rawOutput": {
    "type": "TaskOutput",
    "MultiResult": {
      "mode": "wait_all",
      "results": [
        {
          "task_id": "019f9856-0c63-7800-b675-fc25e5d571f2",
          "command": "[subagent:general-purpose] GitHub CoT decrypt search",
          "status": "completed",
          "exit_code": 0,
          "started": "2026-07-25T08:13:23Z",
          "ended": "2026-07-25T08:15:25Z",
          "duration_secs": 121.273,
          "output": "# GitHub / Public Inventory: Claude/Anthropic CoT, Encrypted Thinking, Signatures …"
        }
      ]
    }
  }
}
```

`task_id` is the child session id; `command` is the synthesised label `[subagent:<type>] <description>`; `mode` records the wait strategy (`wait_all` seen). Subagents and background shell commands share this one channel, so `results[]` can mix both — `command` is what distinguishes them.

**(3) `subagents/<child>/output.json`** — the durable copy, versioned:

```json
{
  "schema_version": 1,
  "output": "1) **Visible text:** `OK`\n\n2) **Private thinking:** Unlikely to stay as only that one line …"
}
```

Cancellation is explicit rather than silent: the single non-completed record carries `status:"cancelled"` with `error:"Subagent was cancelled"`.

## Agent-to-agent messages

**Not applicable — the format has no representation of sibling or peer messages.** Evidence, all measured:

- The complete tool inventory observed in a real 509-tool-call parent session is: `run_terminal_command` (126), `get_command_or_subagent_output` (84), `write` (82), `read_file` (75), `search_replace` (41), `todo_write` (32), `web_fetch` (25), `grep` (16), `spawn_subagent` (13), `list_dir` (11), `scheduler_create`/`scheduler_list`/`scheduler_delete` (1 each), `exit_plan_mode` (1). **No message/send/notify tool exists.**
- `~/.grok/README.md:2344-2366` documents the built-in tool set; no peer-messaging tool is listed.
- Searching the binary for `send_message|message_agent|agent_message|list_subagents|cancel_subagent` as standalone symbols returned **nothing**. `agent_message_chunk` exists but is the assistant's _own_ text stream (`README.md:1103`, `:1227`), not inter-agent traffic.
- No session update record carries a sender/recipient pair. Every observed edge is strictly vertical: parent → child via `subagent_spawned.description`/`prompt`, child → parent via `subagent_finished.output`.

Communication is therefore **spawn-prompt down, single result up**. A sibling can only influence another sibling through the parent, or out-of-band through the shared filesystem (both children run in the same `child_cwd`). The one adjacent primitive is the `scheduler_*` tool family and the `subagent_stop` hook (below), neither of which addresses a peer.

## Nesting and identity

**Depth: exactly 1, measured; deeper nesting is not evidenced.**

- 0 of the 168 child sessions contains a `subagents/` directory.
- `subagent_spawned` occurs in exactly **4** `updates.jsonl` files, and all 4 are **root** sessions (`session_kind` absent).
- 15 child sessions _mention_ the string `spawn_subagent` in their `updates.jsonl` (it appears in their advertised tool inventory) yet **issued 0 spawn tool calls and produced 0 `subagent_spawned` records**. So children are handed the capability but never used it in this corpus.
- No `parent_session_id` in the 168 records is itself a recorded child (set intersection empty).

[INFERENCE] The schema imposes no depth limit — `parent_session_id`/`child_session_id` compose recursively, children are full sessions holding the spawn tool, and the binary contains a `subagent_coordinator` symbol — so depth ≥ 2 is likely reachable. An ingester should build a general tree, not assume two levels. This is unproven here: with the probe blocked I could not force it.

**Id scheme.** Every session id is **UUIDv7** — all 214 match `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-…$`. The embedded millisecond timestamp decodes to the recorded `created_at` (`019f97e1-509d-7e71-…` → `2026-07-25T06:05:53.693Z`, vs `created_at 2026-07-25T06:05:53.696Z`). Time-sortability is **verified**: sorting the 214 ids lexically yields a non-decreasing timestamp sequence. 198 distinct milliseconds across 214 ids, with up to **4 ids sharing a single millisecond** — that tie is itself the parallel-fan-out signature, so lexical order must not be relied on to disambiguate siblings.

Other ids: `toolCallId` = `call-<uuid4>-<seq>` (and `ws_<uuid>_call-<uuid4>-<seq>` for backend-side calls); `_meta.eventId` = `<session-id>-<seq>`; `promptId` = uuid4.

**Which id is stable enough for a lane key — the single most important finding.** _Not_ `child_session_id.* Every `resumed`/`forked`re-invocation of a subagent mints a **brand-new session id and a brand-new directory**, chained backwards by`resumed_from`(verified:`resumed_from != child_session_id` on 104/104). Following that chain:

- 168 child session ids collapse to **64 logical agent threads**.
- Chain-length distribution: 51 threads of length 1, one of 2, one of 6, one of 9, and **10 threads of length 10**.
- Along the longest chain all 10 links carry the _same_ `description` (`"loop: …"`) and `effective_context_source: "resumed"` — one persistent agent, ten session ids.

**So the lane key must be the root of the `resumed_from` chain** (equivalently: the oldest ancestor reachable by following `resumed_from`), optionally validated against the stable `description` + `subagent_type`. Keying on `child_session_id` renders 168 lanes where a human sees 64, and shatters one long-running agent into 10 unrelated lanes.

## Probe transcript

**The live spawn probe could not run: the stored credential is expired and the CLI refuses to run any model turn.** Exact commands and output.

_Snapshot before:_

```
session dirs before: 232          (counting all <bucket>/<id> pairs, incl. non-dir entries)
probe cwd buckets matching "grok-spawn-probe": []
```

_Attempt 1:_

```
$ mkdir -p /tmp/grok-spawn-probe && cd /tmp/grok-spawn-probe
$ grok -p "Spawn exactly one subagent and give it this task: reply with the single word BANANA. \
    Wait for it, then report the word it returned and the subagent's id. Do not answer BANANA yourself." \
    --output-format json --always-approve
{"type":"error","message":"Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\nAlternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser."}
Error: Not signed in. …
```

_Attempt 2_ (same prompt, subagents forced on explicitly, with debug):

```
$ GROK_SUBAGENTS=1 grok -p "<same BANANA prompt>" --output-format json --always-approve \
    --debug-file /tmp/grok-spawn-probe/debug.txt
{"type":"error","message":"Not signed in. …"}
```

Debug log, decisive lines (token values never present in the log):

```
DEBUG xai_grok_shell::agent::config: resolved credentials model=grok-4.6 auth_type=ApiKey
WARN  xai_grok_shell::agent::models::fetch: Failed to fetch models: Auth("No auth credentials for cli-chat-proxy")
WARN  xai_grok_shell::agent::models: model refresh failed, leaving existing models unchanged
INFO  xai_grok_shell::agent::mvp_agent::acp_agent: auth: advertising grok.com auth method label=None has_auth_provider=false
```

Root cause, from `~/.grok/auth.json` (all secret values redacted to lengths only — `key` `<str len=870>`, `refresh_token` `<str len=86>`):

```
auth_mode: oidc     oidc_issuer: https://auth.x.ai
create_time: 2026-08-01T04:12:56.826563Z
expires_at:  2026-08-01T10:12:56.826563Z
now:         2026-08-12T21:57:57Z        ->  EXPIRED by 12 days 12:14:59
XAI_API_KEY set: False
```

The remedy is `grok login --device-code` (browser/interactive, needs the user) or an `XAI_API_KEY`; neither is available to me, and I did not attempt to manipulate the refresh token. **No new session directory was created by either attempt** — the count stayed at 232 and no `grok-spawn-probe` cwd bucket appeared, because the CLI exits before creating a session. A trivial one-turn fallback probe is equally blocked: the failure is at credential resolution, before any prompt is sent.

**Live probes that DID succeed (no auth required)** — these are measurements, not inferences:

1. `grok --version` → `grok 1.0.3 (1a29d5bc12) [stable]`; `grok --help` → full flag/subcommand inventory quoted above.
2. `grok inspect` → resolved config, `Agents (8)`.
3. `grok sessions list` in `~/Projects/cot-patcher` → 12 rows, **all root sessions**; the 100+ child sessions in that same bucket are filtered out.
4. **`grok trace <session-id> --local --json` works unauthenticated** and is the harness's own export path:
   ```
   $ grok trace 019f97e1-509d-7e71-8ee4-3eb2302d1871 --local --json -o /tmp/grok-spawn-probe/trace.tar.gz
   {"session_id":"019f97e1-509d-7e71-8ee4-3eb2302d1871","status":"exported","local_path":"/tmp/grok-spawn-probe/trace.tar.gz"}
   ```
   → 13,044,852 B, 340 entries, including `export_metadata.json`, `updates.jsonl`, `events.jsonl`, `chat_history.jsonl`, `compaction*`, `goal/`, 6 `memtrace/*.jsonl`, 154 terminal logs, and **all 77 `subagents/<child>/meta.json` + 77 `output.json`**. Manifest:
   ```json
   {
     "session_id": "019f97e1-509d-7e71-8ee4-3eb2302d1871",
     "grok_version": "1.0.3 (1a29d5bc12)",
     "os": "linux",
     "arch": "x86_64",
     "exported_at": "2026-08-12T21:58:28.783718021+00:00",
     "memtrace_files": 6
   }
   ```
   Critically, it **does not include the children's own session directories** — no child `updates.jsonl`. The bundle gives you child summaries and final outputs, never child internals. Without `--local` this command _uploads_ to xAI; always pass `--local`.
5. **Live ACP handshake over stdio**, unauthenticated — `grok agent stdio` fed a JSON-RPC `initialize`:
   ```json
   {"loadSession":true,"promptCapabilities":{"image":false,"audio":false,"embeddedContext":true},
    "mcpCapabilities":{"http":true,"sse":true},
    "sessionCapabilities":{"list":{},"resume":{},"close":{}},"auth":{},
    "_meta":{"x.ai/fs_notify":true,
             "x.ai/hooks":{"blockingEvents":["pre_tool_use","stop","subagent_stop"],
                           "decisions":["deny","block"],
                           "stopSignals":["continue","stopReason","additionalContext"]},
             "x.ai/capabilities":{"toolOverrides":{…}}}}
   ```
   This **live-confirms a first-class `subagent_stop` lifecycle hook**. A subsequent `session/new` produced no response (auth-gated).

**Session ids used as evidence** (all pre-existing, none created by me): parents `019f97e1-509d-7e71-8ee4-3eb2302d1871` (77 spawns), `019f9031-96fa-7331-a288-95defb38f768` (62), `019f69ab-57f6-71f2-97c8-4094976dfe1b` (24), `019f64ab-74d8-7c63-975a-7efb6b3149e9` (5); children `019f9856-0c63-7800-b675-fc25e5d571f2`, `019fa28a-c252-7392-ae4c-a072566b464c`, `019f6b0b-a164-76d1-be64-58b846584334` (resumed from `019f6b09-01dd-7500-9b9d-f3baaef06802`).

Because the probe was blocked, **every capability claim above is grounded in the on-disk store, the binary's own `--help`, the shipped README, or a live unauthenticated command** — not in the absence of data. The relevant caution from the Codex lesson is satisfied differently here: the corpus _does_ contain the feature (168 spawns), so no negative rests on "the format cannot express it" except the agent-to-agent case, which is corroborated by the tool inventory and binary symbols.

## Gaps and traps

1. **The vendor method is the whole story, and a spec-compliant ACP reader drops it.** `subagent_spawned`/`subagent_finished` ride on `method: "_x.ai/session/update"`, not `"session/update"`. Any ingester filtering on the standard method — the obvious thing to write — silently loses **100% of agent structure** while still parsing 100% of the conversation. Measured: 2,540 `_x.ai/session/update` records across all 184 sessions.
2. **The `spawn_subagent` tool call is not the spawn.** Only 32 occurrences in 2 files vs 168 spawns in 4 files: ~81% of spawns are issued by internal subsystems with no visible tool call. Key on `subagent_spawned`.
3. **Children masquerade as root sessions.** Child directories are siblings of parents inside the same cwd bucket, with identical file layout. The _only_ on-disk discriminator is `summary.json.session_kind` (or `prompt_context.json.audience`). Ignore it and this install yields **214 unrelated traces instead of 46 traces containing 168 nested agents**. `grok sessions list` reinforces the error by showing only roots.
4. **A logical agent spans many session ids.** `resumed`/`forked` re-invocation mints a new id each time. 168 ids = **64** logical threads; one thread spans 10 ids. Lane keys must follow `resumed_from` to its root. This is the single highest-impact trap.
5. **`parent_prompt_id` is null exactly where you need it** — absent on 103 of 104 `resumed` spawns (53/168 present overall). Turn-level attribution must fall back to `_meta.eventId` ordering or to `unified.jsonl`'s `subagent-completed-<child_id>` synthetic prompt id.
6. **`subagent_finished` omits `parent_session_id`.** Correlate on `child_session_id`; do not assume the enclosing file.
7. **The child id is also embedded in prose.** `tool_call_update.rawOutput.text` says `subagent_id: <uuid>`. Tempting and fragile — the structured field exists; use it. The same `toolCallId` also appears under two titles (`spawn_subagent`, then the human `description`), so title is not a stable tool identity.
8. **Documentation drifts from the wire in three measured ways.** (a) `README.md:2358-2360` names the tools `task`, `kill_task`, `get_task_output`; the wire names are `spawn_subagent`, `get_command_or_subagent_output`. (b) The same line says subagents _"require `--subagents`"_, but 1.0.3 has only `--no-subagents` and defaults to enabled. (c) `README.md:742-748` documents `streaming-json` as `{"type":"text","data":"…"}` while `grok --help` in 1.0.3 defines it as "NDJSON of the agent native ACP session updates". Trust `--help` and the bytes over the bundled README; version-gate any adapter on `export_metadata.json.grok_version`.
9. **Batch joins mix subagents with shell commands.** `get_command_or_subagent_output` serves both; `MultiResult.results[]` entries are distinguished only by the `command` prefix `[subagent:<type>]`. Splitting on `task_id` alone will invent agent lanes for background `bash` calls.
10. **Sibling ordering is ambiguous by design.** Up to 4 UUIDv7 ids share one millisecond (true parallel fan-out). Use `_meta.agentTimestampMs` plus `_meta.eventId` sequence, never id order, to sequence siblings.
11. **Unrecoverable from the official export.** `grok trace --local` bundles child `meta.json`/`output.json` but **not** child session directories: a bundle alone can never reconstruct what a child actually did, only what it returned. Full fidelity requires reading `~/.grok/sessions/` directly and joining sibling directories. Conversely the export is the only artifact carrying `grok_version`, so an adapter reading raw directories has **no version stamp** — infer it from `chat_history_version`/`schema_version` or record it out of band.
12. **`session_search.sqlite` is a decoy.** It indexes 51 of 214 sessions and contains no parent/child relation; never enumerate from it.
13. **Redaction burden is real.** `updates.jsonl` contains `agent_thought_chunk` records (raw reasoning text, not encrypted), full file contents, `terminal/*.log` command output, and absolute `/home/<user>` paths in `child_cwd`, `grok_home` and tool arguments. Reasoning is plaintext here, so it must be dropped deliberately — there is no `encrypted_content` field doing it for you.
14. **Depth >1 is untested.** See Nesting: build a general tree; do not hard-code two levels.
15. **Non-UTF8 / rotation.** `memtrace/*.jsonl` rotate to `.jsonl.1`; `updates.jsonl`, `chat_history.jsonl`, `summary.json` and `rewind_points.jsonl` each have sibling `.lock` files (0 B) that must be skipped by any glob.
