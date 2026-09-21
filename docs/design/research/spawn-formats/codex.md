---
status: current
owner: maintainers
last_reviewed: 2026-08-12
normative: false
milestone: Gate 5
---

> 附录：OpenAI Codex CLI 的 spawn 记录实测原始报告。汇总与跨 harness 对比见 [六个 Agent Harness 的 spawn 记录格式](../agent-spawn-formats.md)。

# OpenAI Codex CLI

Scope note: everything under "measured" was read from this machine's own session store on 2026-08-12. Upstream claims are cited `path::symbol` from `openai/codex` at tag `rust-v0.147.0` and are marked `[UPSTREAM]`. Inferences are marked `[INFERENCE]`.

## Version and enablement

Installed: `codex-cli 0.147.0` (`codex --version`), binary `~/.local/bin/codex`, npm package `@openai/codex`.

Subagents are **off by default** and gated by a feature flag in `~/.codex/config.toml`:

```toml
[features]
multi_agent = true

[agents]
max_threads = 8
max_depth = 1
```

Measured effects:

- With `multi_agent = true`, the model receives an extra `developer` message (parent probe line 4) that names the whole tool surface, and `turn_context.payload.multi_agent_version` is `"v2"`.
- `max_threads = 8` surfaces to the model as prose: `There are 9 available concurrency slots, meaning that up to 9 agents can be active at once, including you.` — i.e. `max_threads + 1` counting the root. When the cap is hit the tool returns a bare string, not JSON: `collab spawn failed: agent thread limit reached` (397 occurrences corpus-wide) and `collab tool failed: agent thread limit reached` (132).
- `max_depth = 1` is _not_ retroactive and is not a store-wide invariant: `session_meta.payload.source.subagent.thread_spawn.depth` reaches 5 in this store (depth 1: 478 rollouts, 2: 254, 3: 45, 4: 9, 5: 1).
- Three states of `multi_agent_version` are observed: `"v1"`, `"v2"`, and `"disabled"` (0.142.0 / 0.142.2). `[INFERENCE]` `"disabled"` is what the field reads when `features.multi_agent` is false.

A second, independent switch decides the **record format**: `session_meta.payload.history_mode`, `"legacy"` (the Rust `#[default]`) or `"paginated"`. This is described under "Gaps and traps"; it is the single most dangerous variable for an ingester.

## Where the trace lives

```
~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<YYYY-MM-DDTHH-MM-SS>-<thread-uuid>.jsonl
```

Measured: 997 rollout files, 3,455,710 records, 4.7 GB.

One JSON object per line. Envelope `[UPSTREAM] codex-rs/protocol/src/protocol.rs::RolloutLine` (3403-3409):

```jsonc
{ "timestamp": "<RFC3339 UTC>", "ordinal": 12, "type": "<variant>", "payload": { … } }
```

`ordinal` is `skip_serializing_if = "Option::is_none"`, so legacy-mode files omit it entirely (measured: 0 of 24 parent probe lines carry it; 207 of 207 lines in a paginated file do).

Top-level `type` values `[UPSTREAM] protocol.rs::RolloutItem` (3208-3222), `#[serde(tag="type", content="payload", rename_all="snake_case")]`:
`session_meta` | `response_item` | `inter_agent_communication` | `inter_agent_communication_metadata` | `compacted` | `turn_context` | `world_state` | `event_msg`.
Measured: all but `inter_agent_communication` (the legacy sibling of the metadata record) occur locally.

Sibling state, all measured to be **useless for spawn reconstruction**:

- `~/.codex/session_index.jsonl` — 36 entries, keys exactly `{id, thread_name, updated_at}`. No parentage, and it covers 36 of 997 threads.
- `~/.codex/archived_sessions/` — 7 files.
- `~/.codex/thread_history_1.sqlite`, `state_5.sqlite`, `logs_*.sqlite` — not required; the JSONL is the system of record.

Newest session:

```bash
find ~/.codex/sessions -name 'rollout-*.jsonl' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-
```

Trap, measured: for the probe this returns the **parent** (`…17-33-40-019ff6d2-88ce…`), because the parent wrote its last record at 16:33:54.264Z and the child stopped at 16:33:52.059Z. "Newest file" is the parent, not the child; the child is the _second_ newest.

Second trap: the `YYYY/MM/DD` directory and the filename stamp are **local time**, the `timestamp` envelope is **UTC**. Probe parent: path `2026/08/12/rollout-2026-08-12T17-33-40-…` vs first envelope `2026-08-12T16:33:40.832Z` (Europe/London, BST = UTC+1). Never derive an instant from the path or filename.

## Spawn: parent side

Path `~/.codex/sessions/2026/08/12/rollout-2026-08-12T17-33-40-019ff6d2-88ce-7433-a836-697505967706.jsonl`.

The parent writes **three** records for one spawn, plus a `world_state` delta. Line 12, the tool call:

```json
{
  "timestamp": "2026-08-12T16:33:49.771Z",
  "type": "response_item",
  "payload": {
    "type": "function_call",
    "id": "fc_04312682a4b39f72016a7ca06d110881918e5bf1f0cb5850fc",
    "name": "spawn_agent",
    "namespace": "collaboration",
    "arguments": "{\"task_name\":\"banana_reply\",\"fork_turns\":\"none\",\"message\":\"gAAAAABqfKBtACB3zOTMbyAyI6mvD98BfqATttZYTEncv4euGEhqjtjMaYCUYZmGyKP6U09shpeoSqYHNo01Mlv9BUSP2HS0LDWOUFrd2OGvT8FFDgIBx1lKNXM3E35BfElDYfRHg55creYmDYIgOIYd-mMGtXrKWA==\"}",
    "call_id": "call_eQoK6VDFkXnMBOfDuteRxhAg",
    "internal_chat_message_metadata_passthrough": {
      "turn_id": "019ff6d2-8e3f-7491-aa18-17427b9e8168"
    }
  }
}
```

**The `message` is ciphertext, not prose.** Corpus-wide this is absolute: 1113/1113 `collaboration.spawn_agent`, 7525/7525 `send_message`, 622/622 `followup_task` messages begin `gAAAAA`; **zero** plaintext. `[UPSTREAM]` `codex-rs/tools/src/json_schema.rs::with_encrypted` (118-121) marks the parameter `"encrypted": true`; the model supplies ciphertext and `codex-rs` never holds a key — a whole-tree search for `fernet` returns zero matches, and the only crypto crates (`crypto_box`, `clatter`) are scoped to `agent-identity` and `exec-server/src/noise_channel.rs`. The key is server-side. `[INFERENCE]` the `gAAAAA` prefix is Fernet's `0x80` version byte; the format is never asserted in codex-rs.

Line 13 — the only record in the entire parent file that contains the child's thread UUID:

```json
{
  "timestamp": "2026-08-12T16:33:49.905Z",
  "type": "event_msg",
  "payload": {
    "type": "sub_agent_activity",
    "event_id": "call_eQoK6VDFkXnMBOfDuteRxhAg",
    "occurred_at_ms": 1786552429905,
    "agent_thread_id": "019ff6d2-acd9-7c91-89eb-2a73dd7467e9",
    "agent_path": "/root/banana_reply",
    "kind": "started"
  }
}
```

Line 14 — the tool result, which deliberately does **not** carry the UUID:

```json
{
  "timestamp": "2026-08-12T16:33:49.908Z",
  "type": "response_item",
  "payload": {
    "type": "function_call_output",
    "id": "fco_019ff6d2-ad54-7842-8bbe-165ac1a3ff9f",
    "call_id": "call_eQoK6VDFkXnMBOfDuteRxhAg",
    "output": "{\"task_name\":\"/root/banana_reply\"}",
    "internal_chat_message_metadata_passthrough": {
      "turn_id": "019ff6d2-89cb-7342-b54d-da5c50691449"
    }
  }
}
```

Line 16 — a `world_state` delta re-listing the live roster (`full: false`):

```json
{
  "timestamp": "2026-08-12T16:33:49.920Z",
  "type": "world_state",
  "payload": {
    "full": false,
    "state": { "environments": { "subagents": "- banana_reply: Einstein" } }
  }
}
```

Measured regression: in v1 this roster keyed on the child UUID (`- 019f4366-262d-7f30-8e75-5dd8caf8772c: Volta`, 24/24 entries sampled); in v2 it keys on the bare task name (`- architecture_review: Linnaeus`, 5882/5882 entries). The UUID was dropped from `world_state` at the v1→v2 switch.

### The full `collaboration` tool surface

From the parent's developer message (line 4), verbatim: ``You can use `spawn_agent` to create a new agent, `followup_task` to give an existing agent a new task and trigger a turn, and `send_message` to pass a message to a running agent without triggering a turn.`` and ``Call `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, and `list_agents` only as direct tool calls``.

Measured argument shapes across 997 rollouts (exhaustive; every observed key tuple):

| tool              | arguments                          | calls     | output shape           |
| ----------------- | ---------------------------------- | --------- | ---------------------- |
| `spawn_agent`     | `{task_name, message, fork_turns}` | 1083      | `{task_name}`          |
| `spawn_agent`     | `+ reasoning_effort`               | 29        | "                      |
| `spawn_agent`     | `+ model, reasoning_effort`        | 1         | "                      |
| `send_message`    | `{target, message}`                | 7525      | `""` (empty string)    |
| `followup_task`   | `{target, message}`                | 622       | `""`                   |
| `wait_agent`      | `{timeout_ms}`                     | 6326      | `{message, timed_out}` |
| `list_agents`     | `{}` / `{path_prefix}`             | 1660 / 63 | `{agents:[…]}`         |
| `interrupt_agent` | `{target}`                         | 68        | `{previous_status}`    |

Note `wait_agent` takes **no target** in v2 — it waits on the pool. `[UPSTREAM]` schema builder `codex-rs/core/src/tools/handlers/multi_agents_spec.rs::create_spawn_agent_tool_v2` (102-146): `required = ["task_name","message"]`, `additionalProperties: false`, `strict: false`; optional `agent_type`, `fork_turns`, `model`, `reasoning_effort`, `service_tier`, each conditionally stripped by config.

`list_agents` output is a roster snapshot — measured, `…019f690b-4d03…` line 200:

```json
{
  "agents": [
    { "agent_name": "/root", "agent_status": "running", "last_task_message": "Main thread" },
    {
      "agent_name": "/root/architecture_review",
      "agent_status": "running",
      "last_task_message": null
    },
    {
      "agent_name": "/root/product_progress",
      "agent_status": "running",
      "last_task_message": null
    },
    {
      "agent_name": "/root/verification_review",
      "agent_status": "running",
      "last_task_message": null
    }
  ]
}
```

Paths and statuses only — **no thread UUIDs**.

### `fork_turns`

`[UPSTREAM] multi_agents_v2/spawn.rs::SpawnAgentArgs::fork_mode` (210-256). It is a **string**, trimmed; absent or empty defaults to `"all"`:

- `"none"` (ASCII case-insensitive) → no history; the child starts from the prompt alone.
- `"all"` → `FullHistory`: the child inherits the parent's entire rollout.
- positive integer string → `LastNTurns(n)`, cut at the fork-turn boundaries defined in `codex-rs/core/src/thread_rollout_truncation.rs::fork_turn_positions_in_rollout` (75-105) — a real user message, or an `inter_agent_communication_metadata` with `trigger_turn: true`.
- `"0"` or non-integer → `RespondToModel("fork_turns must be \`none\`, \`all\`, or a positive integer string")`.
- `fork_context` (the v1 key) → hard error `"fork_context is not supported in MultiAgentV2; use fork_turns instead"`.

Measured values, 1113 calls: `all` 899, `3` 110, `none` 49, `4` 31, `2` 21, `5` 3.

Coupling, measured as a tool error string in the corpus (18×) and confirmed `[UPSTREAM]` at `core/src/config/mod.rs:256`: `Full-history forked agents inherit the parent agent type, mo…` — a full-history fork rejects `model`/`reasoning_effort`/`agent_type` overrides. This explains why only 30 of 1113 spawns carry an override.

## Spawn: child side

Path `~/.codex/sessions/2026/08/12/rollout-2026-08-12T17-33-49-019ff6d2-acd9-7c91-89eb-2a73dd7467e9.jsonl`, line 1 (elided: `base_instructions`, `cwd`, `git`, `context_window`):

```json
{
  "timestamp": "2026-08-12T16:33:49.908Z",
  "type": "session_meta",
  "payload": {
    "session_id": "019ff6d2-88ce-7433-a836-697505967706",
    "id": "019ff6d2-acd9-7c91-89eb-2a73dd7467e9",
    "parent_thread_id": "019ff6d2-88ce-7433-a836-697505967706",
    "timestamp": "2026-08-12T16:33:49.786Z",
    "cwd": "/tmp/codex-spawn-probe",
    "originator": "codex_exec",
    "cli_version": "0.147.0",
    "source": {
      "subagent": {
        "thread_spawn": {
          "parent_thread_id": "019ff6d2-88ce-7433-a836-697505967706",
          "depth": 1,
          "agent_path": "/root/banana_reply",
          "agent_nickname": "Einstein",
          "agent_role": null
        }
      }
    },
    "thread_source": "subagent",
    "agent_nickname": "Einstein",
    "agent_path": "/root/banana_reply",
    "history_mode": "legacy",
    "multi_agent_version": "v2",
    "model_provider": "OpenAI"
  }
}
```

**`session_id` is the parent's id, not the child's.** The child's own id is `id`. Measured on both probe files; `[UPSTREAM] protocol.rs::SessionMeta` (3081-3141) declares `session_id: SessionId` and `id: ThreadId` as separate required fields, and `SessionMetaLine`'s hand-written `Deserialize` (3181-3206) back-fills `session_id` from `id` for pre-split files. Keying a lane on `session_id` collapses every child onto its parent.

`[UPSTREAM]` the serialization is externally tagged twice: `SessionSource` is `rename_all="lowercase"` (2766-2779) → `{"subagent": …}`; `SubAgentSource` is `rename_all="snake_case"` (2846-2856) → `{"thread_spawn": {…}}`. Do **not** use the JSON schemas under `codex-rs/app-server-protocol/schema/` to model these bytes — that is a _different_ `SessionSource` (`v2/thread_data.rs:22-38`, `rename_all="camelCase"`) emitting `subAgent`/`appServer`.

The child then receives its task as line 10 — note the plaintext header and the ciphertext body as two separate content items:

```json
{
  "timestamp": "2026-08-12T16:33:50.307Z",
  "type": "response_item",
  "payload": {
    "type": "agent_message",
    "id": "amsg_019ff6d2-aee3-7113-94fe-0dfae3972886",
    "author": "/root",
    "recipient": "/root/banana_reply",
    "content": [
      {
        "type": "input_text",
        "text": "Message Type: NEW_TASK\nTask name: /root/banana_reply\nSender: /root\nPayload:\n"
      },
      {
        "type": "encrypted_content",
        "encrypted_content": "gAAAAABqfKBtACB3zOTMbyAyI6mvD98BfqATttZYTEncv4euGEhqjtjMaYCUYZmGyKP6U09shpeoSqYHNo01Mlv9BUSP2HS0LDWOUFrd2OGvT8FFDgIBx1lKNXM3E35BfElDYfRHg55creYmDYIgOIYd-mMGtXrKWA=="
      }
    ],
    "internal_chat_message_metadata_passthrough": {
      "turn_id": "019ff6d2-ad50-76a3-a701-d9b5be1d44bf"
    }
  }
}
```

Immediately preceded by line 9, `{"type": "inter_agent_communication_metadata", "payload": {"trigger_turn": true}}`. `[UPSTREAM] core/src/session/mod.rs::Session::record_inter_agent_communication` (3141-3170) persists these two as one atomic batch, so the metadata marker is always the line before the delivered `agent_message`. `trigger_turn: true` = wake the recipient and start a turn (`NEW_TASK`); `false` = queue only (`MESSAGE`).

## The link

Three distinct joins, in descending order of reliability.

**1. Child → parent (thread level).** `session_meta.payload.parent_thread_id` == parent's `session_meta.payload.id`. Measured: 789 of 997 rollouts carry it; **179 distinct parent ids, 179 of 179 resolvable to a local rollout file** — no dangling edges in this store. The same value is duplicated at `source.subagent.thread_spawn.parent_thread_id`. `[UPSTREAM]` caveat: these are independent fields and may disagree in principle; prefer the top-level one and treat the nested copy as corroboration.

**2. Spawn → the exact parent tool call.** `event_msg.sub_agent_activity.event_id` == the parent's `function_call.call_id` (`call_eQoK6VDFkXnMBOfDuteRxhAg`), and `sub_agent_activity.agent_thread_id` is the child's `session_meta.id`. This single record is the _only_ place the child UUID and the parent's `call_id` appear together.

Measured fragility: scanning 177 v2 children against their parent rollouts, the child UUID appears in the parent **only** as `('event_msg','sub_agent_activity')` — 175 hits, 2 children absent from the parent entirely. It appears in **zero** `function_call_output`s, `world_state`s or `list_agents` rosters. Delete that one line and the parent→child edge is unrecoverable from the parent side.

`[UPSTREAM] codex-rs/rollout/src/policy.rs::should_persist_event_msg` (105-119): `EventMsg::SubAgentActivity(_) => matches!(history_mode, ThreadHistoryMode::Legacy)`. The link record exists **only in legacy mode**.

**3. Spawn → child inbox (content join).** The ciphertext is byte-identical on both sides: `json.loads(parent.function_call.arguments)["message"] == child.agent_message.content[1].encrypted_content` — verified `True`, 164 chars. Because it is a Fernet-style token with an embedded timestamp and nonce, it is effectively unique per message, so it joins parent tool call ↔ child inbox **without decrypting anything**. This survives even when `sub_agent_activity` is absent.

The weaker path key — `function_call_output.output.task_name` == `/root/banana_reply` == child `session_meta.agent_path` — is human-readable but **not unique**: it is reused across sibling spawns and across time, and the tool rejects duplicates only while an agent is live (`agent path \`/root/codex_migration_audit\` already exists`, 7×).

## Join: how results come back

A **structured record with a text envelope inside it**. Parent line 20:

```json
{
  "timestamp": "2026-08-12T16:33:52.454Z",
  "type": "response_item",
  "payload": {
    "type": "agent_message",
    "id": "amsg_019ff6d2-b746-7f33-a7f6-6706fef2af43",
    "author": "/root/banana_reply",
    "recipient": "/root",
    "content": [
      {
        "type": "input_text",
        "text": "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/banana_reply\nPayload:\nBANANA"
      }
    ],
    "internal_chat_message_metadata_passthrough": {
      "turn_id": "019ff6d2-89cb-7342-b54d-da5c50691449"
    }
  }
}
```

Preceded by `{"type": "inter_agent_communication_metadata", "payload": {"trigger_turn": false}}` (line 19).

`author` and `recipient` are first-class fields — parse those, not the text. But the text envelope carries the one thing the fields do not: the **message type**. Measured across the corpus (9766 `agent_message` records):

| Message Type   | count | body                           |
| -------------- | ----- | ------------------------------ |
| `MESSAGE`      | 7459  | encrypted, envelope body empty |
| `NEW_TASK`     | 1226  | encrypted, envelope body empty |
| `FINAL_ANSWER` | 1081  | **plaintext, body present**    |

This asymmetry is the single most consequential fact for an ingester: **results are readable, instructions are not.** `[UPSTREAM] protocol.rs::InterAgentCommunication::to_model_input_item` (817-840) builds the `NEW_TASK`/`MESSAGE` header + `EncryptedContent` pair; the `FINAL_ANSWER` path returns plaintext.

There is no completion _event_. `sub_agent_activity.kind` has exactly three values — measured `started` 36352, `interacted` 207984, `interrupted` 4467 — and `[UPSTREAM] protocol.rs::SubAgentActivityKind` (4349-4355) confirms the Rust enum is genuinely `{Started, Interacted, Interrupted}`, i.e. no terminal variant exists to be suppressed. **A child's completion is observable only as the arrival of a `FINAL_ANSWER` `agent_message` in the parent**, or as the child's own `event_msg.task_complete`.

`wait_agent` returns `{"message": …, "timed_out": bool}`; a timeout is a normal, frequent outcome (`timeout_ms must be at least 10000`, 107×).

## Agent-to-agent messages

**Yes — fully expressed, with structured sender and recipient, and genuinely peer-to-peer.**

Measured direction split over 9766 `agent_message` records, classified by comparing `agent_path` depth of `author` vs `recipient`:

- child → parent: 4921
- parent → child: 3504
- **same-depth siblings: 1341**

A real sibling exchange, `…019f6aa5-3a6…` line 101 and `…019f6aa8-660…` lines 118 and 170 — two specialists talking directly, with no parent in the path:

```json
{
  "type": "response_item",
  "payload": {
    "type": "agent_message",
    "author": "/root/add_ablation_tests",
    "recipient": "/root/implement_ablation_harness",
    "content": [
      {
        "type": "input_text",
        "text": "Message Type: MESSAGE\nTask name: /root/implement_ablation_harness\nSender: /root/add_ablation_tests\nPayload:\n"
      },
      { "type": "encrypted_content", "encrypted_content": "gAAAAA…" }
    ]
  }
}
```

The record is written into **both** siblings' rollouts (sender's and recipient's), so an ingester that does not dedupe by `(author, recipient, encrypted_content)` will double-count every peer message.

`[UPSTREAM]` the payload struct also carries `other_recipients: Vec<AgentPath>` (`protocol.rs::InterAgentCommunication::new_encrypted`, 778-795), i.e. multicast is representable. Not observed locally (0 non-empty).

Because the second spawn budget was not needed to establish this — 1341 sibling messages already exist in the corpus — **no second probe was run**.

## Nesting and identity

**Depth.** Real and unbounded in practice: measured `thread_spawn.depth` of 1 (478), 2 (254), 3 (45), 4 (9), 5 (1). `[UPSTREAM] SubAgentSource::ThreadSpawn.depth: i32`. The developer prompt tells children they may spawn their own children, and `agent_path` is hierarchical (`/root/a/b`).

**Id schemes, and which to use as a lane key.**

| id                                | shape                  | scope                                       | verdict                        |
| --------------------------------- | ---------------------- | ------------------------------------------- | ------------------------------ |
| `session_meta.payload.id`         | UUIDv7                 | globally unique, one per thread             | **use this as the lane key**   |
| `session_meta.payload.session_id` | UUIDv7                 | == the _parent's_ id on children            | never use as a lane key        |
| `agent_path`                      | `/root/task_name`      | unique only among _live_ agents             | good display label, unsafe key |
| `agent_nickname`                  | `Einstein`, `Tesla`, … | 288 distinct in 997 rollouts; reused freely | display only                   |
| `turn_id`                         | UUIDv7                 | per turn                                    | turn grouping                  |
| `call_id`                         | `call_<22 alnum>`      | per tool call                               | joins spawn↔activity           |

**Time-sortability.** `id` is UUIDv7, so its first 48 bits are a millisecond timestamp: `019ff6d2-5190…` decodes to `2026-06-25T19:56:52.496Z`, matching the file's own `session_meta.timestamp` to ~80 ms. Threads are therefore sortable by id alone. Records are `timestamp`-sortable **within** a file (verified monotonic) — but see the fork warning below, which makes cross-file timestamp sorting unsafe.

`agent_role` is populated only in v1 (65 `explorer`, 1 `worker` — it is the v1 `agent_type` argument); it is `null` on all v2 children. `[UPSTREAM]` it carries `alias = "agent_type"` for backward compatibility.

## Probe transcript

The spawn probe was run on 2026-08-12 in `/tmp/codex-spawn-probe` (directory verified empty afterwards — the prompt forbade shell use). Reconstructed from the rollout: `originator: "codex_exec"`, `source: "exec"`, i.e. `codex exec` with this prompt, recorded verbatim at parent line 9/10:

> Spawn exactly one subagent using your multi-agent capability. Give it this task: reply with the single word BANANA. Wait for it, then tell me the word it returned and the subagent's thread id. Do not answer BANANA yourself and do not run any shell command.

Result: **one** spawn, exactly as constrained.

|                 | parent                                                          | child                                  |
| --------------- | --------------------------------------------------------------- | -------------------------------------- |
| thread id       | `019ff6d2-88ce-7433-a836-697505967706`                          | `019ff6d2-acd9-7c91-89eb-2a73dd7467e9` |
| file            | `…/2026/08/12/rollout-2026-08-12T17-33-40-019ff6d2-88ce….jsonl` | `…-17-33-49-019ff6d2-acd9….jsonl`      |
| records / bytes | 24 / 93,443                                                     | 15 / 88,549                            |
| `thread_source` | `user`                                                          | `subagent`                             |
| duration        | 13,445 ms                                                       | 2,151 ms                               |

Parent record sequence (24): `session_meta`, `task_started`, 4×`message` (3 developer + 1 user env), `world_state(full)`, `turn_context`, `message(user prompt)`, `user_message`, `reasoning`†, **`function_call spawn_agent`**, **`sub_agent_activity started`**, **`function_call_output`**, `token_count`, `world_state(delta)`, `reasoning`†, `token_count`, `inter_agent_communication_metadata`, **`agent_message FINAL_ANSWER`**, `agent_message`, `message(assistant)`, `token_count`, `task_complete`.

Child record sequence (15): **`session_meta(parent_thread_id, thread_spawn)`**, `task_started`, 4×`message`, `world_state(full)`, `turn_context`, `inter_agent_communication_metadata{trigger_turn:true}`, **`agent_message NEW_TASK`**, `reasoning`†, `agent_message`, `message(assistant "BANANA")`, `token_count`, `task_complete`.

† `reasoning` payloads deliberately not quoted anywhere in this document.

Verification commands actually run for this section:

```bash
codex --version                                   # codex-cli 0.147.0
ls ~/.codex/sessions/2026/08/12/                  # 4 files; the 2 above are the newest
find ~/.codex/sessions -name 'rollout-*.jsonl' | wc -l   # 997
```

Corpus counts (parsed, not string-matched — the multi-agent developer prompt mentions every tool name in prose, which inflates naive `grep` by ~2×):

| property                                   | rollouts                                      |
| ------------------------------------------ | --------------------------------------------- |
| total rollout files                        | 997                                           |
| carry `parent_thread_id` (= is a subagent) | 789                                           |
| carry `forked_from_id`                     | 684                                           |
| contain ≥1 `spawn_agent` **function_call** | 296 (294 `collaboration`, 2 `multi_agent_v1`) |
| contain ≥1 `sub_agent_activity`            | 716                                           |
| contain `<subagent_notification>` text     | 5                                             |
| contain any `collaboration`-namespace call | 673                                           |

## Gaps and traps

**1. The fork duplication bomb — the biggest single hazard.** `fork_turns: "all"` copies the parent's entire rollout into the child's file. Measured on `…019f005b-5190…` (7820 records): records 2–7684 are **100% byte-identical payloads** to the origin rollout, and every one is **re-stamped to the fork instant** — 132 records share the single millisecond `2026-06-25T19:56:52.649Z`; 98% of the file is inherited. Corpus-wide, **3,220,520 of 3,455,710 records (93%) live in the 684 forked rollouts.** A naive ingester that walks `sessions/**` will emit the ancestor's history once per descendant, at fabricated times, inflating a 24-minute run into a millisecond avalanche.

- Forked files contain **two** `session_meta` records: line 1 is the fork's own (`forked_from_id`, `parent_thread_id`, `agent_nickname`), line 2 is a verbatim copy of the _origin's_ meta (origin's `id`, origin's `source`/`thread_source`). Always take line 1; a `for line in file: if type=="session_meta"` loop that keeps the last one gets the ancestor's identity.
- There is **no in-file marker** for the fork boundary. A `turn_id`-vs-UUIDv7 heuristic fails (measured: it splits at line 4802 by one rule and 833 by another, against a true boundary at 7685; many `turn_id`s are not UUIDv7 at all).
- The reliable fix is content-addressed: hash each record's `payload`, load the `forked_from_id` file, and drop matches. Measured to be exact — 7683/7683 inherited records matched, 2/136 of the fork's own records matched (both benign).

**2. Spawn vs fork are different edges and must not be merged.** Measured cross-tab:

| `parent_thread_id` | `forked_from_id` | count | meaning                                                       |
| ------------------ | ---------------- | ----- | ------------------------------------------------------------- |
| set                | set (always ==)  | 683   | forked subagent (`fork_turns` = `all` or N)                   |
| set                | absent           | 106   | clean subagent (`fork_turns: "none"`) — the probe child       |
| absent             | set              | **1** | **user-initiated conversation fork, not a delegation at all** |
| absent             | absent           | 207   | ordinary root session                                         |

`forked_from_id != parent_thread_id` never occurs (0/683). Rule: `parent_thread_id` ⇒ a delegation edge; `forked_from_id` ⇒ history was copied. Only the former is an agent-spawn. The lone `forked_from_id`-without-parent row (`thread_source: "user"`, `source: "vscode"`) is a resumed/branched human conversation — drawing a delegation edge there is simply wrong.

**3. Legacy vs Paginated: the format can vanish under you.** `[UPSTREAM] rollout/src/policy.rs::should_persist_event_msg` puts `SubAgentActivity` in the _legacy-only_ arm. In `history_mode: "paginated"` the rollout instead carries `event_msg.item_completed` wrapping raw `TurnItem`s. Measured: 8 of 997 rollouts are already paginated (one at 0.145.0, seven at 0.147.0 — the newest are 2026-08-12, the same day as the probe); every line carries `ordinal`, and `item_completed` wraps `UserMessage`/`Reasoning`/`AgentMessage`/`CommandExecution`/`FileChange`. None of the eight contains a spawn, so `[INFERENCE]`: in paginated mode the parent-side link would appear as `item_completed` carrying `TurnItem::SubAgentActivity`/`CollabAgentToolCall` (`protocol/src/items.rs:43-53`) rather than as an `event_msg`. **An ingester must branch on `session_meta.payload.history_mode`.** This mode is already live in this store and is spreading.

**4. `collab_agent_*` events never touch disk — do not wait for them.** `[UPSTREAM] rollout/src/policy.rs` lines 121-181 place all ten of `CollabAgentSpawnBegin/End`, `CollabAgentInteractionBegin/End`, `CollabWaitingBegin/End`, `CollabCloseBegin/End`, `CollabResumeBegin/End` in the "Transient, non-durable events" arm returning `false` **unconditionally, with no `history_mode` check**. They are genuinely constructed (`protocol/src/legacy_events.rs::CollabAgentToolCallItem::as_legacy_begin_event`, 248-258) and consumed by the TUI/app-server/mcp-server, but they are stream-only. Note the asymmetry: unlike `McpToolCallEnd`/`WebSearchEnd`/`PatchApplyEnd`, the collab `*End` events are **not** in the legacy-persisted group. So `CollabAgentSpawnEndEvent.new_thread_id` — the field that would most cleanly close the spawn loop — is never written to any rollout in any mode. Measured corroboration: 0 `collab_agent_*` records in 997 files.

**5. Task content is unrecoverable.** 9260 of 9260 outbound inter-agent messages are ciphertext with no local key. An ingester can render _who asked whom to do what, when_ and the _answers_, but never the _instructions_. Do not build a UI that promises to show a subagent's prompt. `[UPSTREAM] core/src/client.rs:853-858` strips `encrypted_function_args` for non-OpenAI providers, so a non-OpenAI backend may yield plaintext instead — the field is not reliably one or the other.

**6. Version drift — the precise boundary.** Two incompatible generations, both present in this store:

|                                    | v1                                                                       | v2                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| CLI versions (measured, local)     | **0.141.0 – 0.143.0**                                                    | **0.144.1 – 0.147.0**                                                                          |
| `turn_context.multi_agent_version` | `"v1"`                                                                   | `"v2"`                                                                                         |
| namespace                          | `multi_agent_v1`                                                         | `collaboration`                                                                                |
| tools                              | `spawn_agent`, `close_agent`, `wait_agent`, `send_input`                 | `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents` |
| spawn args                         | `{agent_type, message, fork_context?, reasoning_effort?, service_tier?}` | `{task_name, message, fork_turns, model?, reasoning_effort?}`                                  |
| spawn message                      | **plaintext** (102/102)                                                  | **encrypted** (1113/1113)                                                                      |
| spawn output                       | `{"agent_id":"<uuid>","nickname":"Nash"}`                                | `{"task_name":"/root/x"}`                                                                      |
| child uuid in parent               | **yes, in the tool output**                                              | only in `sub_agent_activity`                                                                   |
| `world_state` roster keys          | child UUID                                                               | task name                                                                                      |
| join back to parent                | `<subagent_notification>` user message                                   | `agent_message` + `author`/`recipient`                                                         |
| `sub_agent_activity`               | **absent**                                                               | present                                                                                        |
| `agent_role`                       | `explorer`/`worker`                                                      | `null`                                                                                         |

Boundary, as precisely as the local files allow: the last v1 rollout is **0.143.0, 2026-07-09T00:06:36Z**; the first file declaring `multi_agent_version: "v2"` is **0.144.1, 2026-07-10T05:51:20Z**; the first actual `collaboration`-namespace call is **0.144.4, 2026-07-16T03:50:31Z**. So the switch landed in **0.144.x, between 2026-07-09 and 2026-07-10**. `[UPSTREAM]` both handler trees still ship at 0.147.0 (`core/src/tools/handlers/multi_agents/` and `multi_agents_v2/`), so old rollouts remain parseable — but `fork_context` is now a hard error on the v2 tool.

Correction to a claim worth flagging: v1 does **not** record spawns child-side only. The v1 parent `…019ef00a-d6a0…` line 5287-5288 records both the call and an output that names the child outright:

```json
{"type": "response_item", "payload": {"type": "function_call", "name": "spawn_agent",
  "namespace": "multi_agent_v1", "call_id": "call_Bq4XSoczMrjN07xvXxwJgZ5a",
  "arguments": "{\"agent_type\":\"explorer\",\"message\":\"Active task: …\\n\\nReview the current repo for phase-boundary drift…\"}"}}
{"type": "response_item", "payload": {"type": "function_call_output",
  "call_id": "call_Bq4XSoczMrjN07xvXxwJgZ5a",
  "output": "{\"agent_id\":\"019efcc4-ecfd-7d32-89e1-4b4aa930b18e\",\"nickname\":\"Nash\"}"}}
```

and the join comes back as a `role: "user"` message (line 5301) — note `agent_path` holds a **UUID** here, unlike v2 where it holds a path:

```json
{
  "type": "response_item",
  "payload": {
    "type": "message",
    "role": "user",
    "content": [
      {
        "type": "input_text",
        "text": "<subagent_notification>\n{\"agent_path\":\"019efcc4-ecfd-7d32-89e1-4b4aa930b18e\",\"status\":{\"completed\":\"**Findings**\\n\\nNo phase-boundary drift found. …\"}}"
      }
    ]
  }
}
```

`close_agent {"target":"<child uuid>"}` (63×) gives v1 an explicit teardown edge that v2 lacks. **v1 is the easier format to ingest**; v2 traded UUID visibility and plaintext for paths and encryption.

Only 5 rollouts contain `<subagent_notification>`, and 3 of those are forked children that merely _inherited_ the text from the parent — the notification is a parent-side record, not a child-side one.

**7. Smaller traps.**

- `session_index.jsonl` covers 36 of 997 threads and has no parentage; do not use it for discovery. Walk the directory tree.
- Empty-string tool outputs (8015 of them) are normal success for `send_message`/`followup_task`, not errors.
- Tool failures arrive as **bare strings**, not JSON: parse defensively.
- `sub_agent_activity.kind: "interacted"` is emitted by both `send_message` and `followup_task` `[UPSTREAM] message_tool.rs:126`, so it alone cannot distinguish queue-only from turn-triggering delivery — read the adjacent `inter_agent_communication_metadata.trigger_turn` instead.
- `thread_source` is `#[serde(try_from="String")]` with an open `Feature(String)` variant `[UPSTREAM] protocol.rs:2823-2833`; do not model it as a closed enum.
- 2 of 997 files have no parseable `session_meta` (`cli_version: null`).
