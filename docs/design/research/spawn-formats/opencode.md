---
status: current
owner: maintainers
last_reviewed: 2026-08-12
normative: false
milestone: Gate 5
---

> 附录：opencode 的 spawn 记录实测原始报告。汇总与跨 harness 对比见 [六个 Agent Harness 的 spawn 记录格式](../agent-spawn-formats.md)。

# opencode

Everything below marked as measured comes from two live probes run on this machine on 2026-08-12 against opencode **1.18.16**, plus direct reads of the installed binary and of `sst/opencode@dev`. Inferences are marked `[INFERENCE]`.

The headline result is a **format change**: the join envelope this harness writes today is _not_ the `task_id: …` header that the historical rows in this same database contain. Both shapes live side by side in one store, split cleanly by the `session.version` column. An ingester written against either alone is wrong half the time.

## Version and enablement

| item    | value                                                                                  |
| ------- | -------------------------------------------------------------------------------------- |
| binary  | `~/.opencode/bin/opencode`, ELF x86-64, bun-compiled single file, 176 MB, not stripped |
| version | `1.18.16` (`opencode --version`)                                                       |
| store   | `~/.local/share/opencode/opencode.db` (SQLite, WAL)                                    |
| config  | `~/.config/opencode/opencode.json`                                                     |

**Subagents are on by default. There is no enable flag.** `task` is a built-in tool, registered unconditionally as `Tool.define("task", …)`. The probe spawned a subagent on a stock `--pure` run with no configuration whatsoever.

What actually governs subagent availability, measured from the published config schema (`https://opencode.ai/config.json`) and the binary:

- **`agent.<name>.mode`** — enum `subagent` | `primary` | `all`. Only `subagent`/`all` agents are selectable as `subagent_type`. Also `agent.<name>.disable` (bool) and `agent.<name>.hidden` (bool, hides from `@` autocomplete only).
- **`permission.task`** — a `PermissionRuleConfig` (`ask` | `allow` | `deny`, or an object of pattern→action). The pattern is matched against the **`subagent_type`**, not against a path. This is the switch that turns spawning off.
- **`subagent_depth`** — integer, schema description verbatim: `"Maximum subagent nesting depth. Defaults to 1, which prevents subagents from launching subagents."`
- **`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`** — required for the `background: true` parameter; without it the tool fails with `Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`.

On this machine `~/.config/opencode/opencode.json` contains **no** subagent definitions, no `subagent_depth`, and no `permission` block — only `agent.build.options.store` and `agent.plan.options.store` (both `false`), providers, and one plugin (`oh-my-openagent`). There is **no `~/.config/opencode/agent/` directory** (measured: `ls` → `No such file or directory`). So every subagent on this box is either built in or contributed by that plugin.

`opencode agent list` reports 27 agents, 21 of them `mode: subagent`. Stock built-ins visible with `--pure`: `build`, `explore`, `general`, `plan` (subagent) and `compaction`, `summary`, `title` (primary). The default `subagent_type` when the model omits it is `general`.

## Where the trace lives

```
~/.local/share/opencode/
  opencode.db            <- SQLite. everything. 38 MB here
  opencode.db-wal        <- 4.3 MB uncheckpointed at probe time. MUST be read, not ignored
  opencode.db-shm
  storage/migration      <- single ASCII byte: "2"  (file-per-record layout retired)
  tool-output/tool_<id>  <- overflow bodies for truncated tool outputs
  log/ snapshot/ repos/ worktree/
```

`OPENCODE_DB` overrides the database path; `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR` override config location.

Relevant tables (measured `.schema`):

- **`session`** — `id, project_id, parent_id, slug, directory, title, version, share_url, summary_*, revert, permission, time_created, time_updated, time_compacting, time_archived, workspace_id, path, agent, model, cost, tokens_*, metadata`
- **`message`** — `id, session_id, time_created, time_updated, data` (`data` = JSON blob)
- **`part`** — `id, message_id, session_id, time_created, time_updated, data` (`data` = JSON blob)
- **`event`** — `id, aggregate_id, seq, type, data`; **`event_sequence`** — `aggregate_id, seq, owner_id`
- `project`, `todo`, `permission`, `session_share`, plus a set of currently empty tables (`workspace`, `account`, `credential`, `session_message`, `session_input`, …)

There is no `sqlite3` binary on this host; I read the store with `bun:sqlite` in read-only mode, which honours the WAL.

**Newest session, one line:**

```sql
SELECT id, title, parent_id, agent FROM session ORDER BY time_created DESC LIMIT 1;
```

Equivalently `ORDER BY id ASC LIMIT 1` — see _Nesting and identity_: `ses_` ids sort **descending**.

## Spawn: parent side

One row is written on the parent side: a **`part`** row of `data.type = "tool"`, `data.tool = "task"`, attached to the parent's assistant message. Nothing else on the parent names the child.

Verbatim, redacted, from probe 1 — the complete `part` row:

```json
{
  "id": "prt_ff7fa66e0001cL9xr2UK03G1aZ",
  "message_id": "msg_ff7fa5e02001JDizfjc8d59PvB",
  "session_id": "ses_00805b0c4ffe83RIol5CpbYSsX",
  "time_created": 1786571810528,
  "time_updated": 1786571812330
}
```

and its `data` column, in full:

```json
{
  "type": "tool",
  "tool": "task",
  "callID": "call_WkKROqMfgu0NQCmwrPEQpxiL",
  "state": {
    "status": "completed",
    "input": {
      "description": "Return required word",
      "prompt": "Reply with the single word BANANA. Do not include any other text.",
      "subagent_type": "general"
    },
    "output": "<task id=\"ses_008059773ffenwuq9PQN3wdajn\" state=\"completed\">\n<task_result>\nBANANA\n</task_result>\n</task>",
    "metadata": {
      "parentSessionId": "ses_00805b0c4ffe83RIol5CpbYSsX",
      "sessionId": "ses_008059773ffenwuq9PQN3wdajn",
      "model": { "modelID": "gpt-5.6-sol", "providerID": "openai" },
      "truncated": false
    },
    "title": "Return required word",
    "time": { "start": 1786571810962, "end": 1786571812330 }
  },
  "metadata": { "openai": { "itemId": "fc_01b2…" } }
}
```

`state.metadata.parentSessionId` is **new in this version** — it is absent from all 32 historical task parts in this store (measured; see _Gaps and traps_). Upstream sets it in `packages/opencode/src/tool/task.ts`:

```ts
const metadata = {
  parentSessionId: ctx.sessionID,
  sessionId: nextSession.id,
  model,
  ...(runInBackground ? { background: true } : {}),
};
```

The `part` table keeps only the **final** state — one row, mutated in place (measured: exactly 1 part row for `call_WkKROqMfgu0NQCmwrPEQpxiL`). The lifecycle is only in the `event` table.

## Spawn: child side

The child is a **full first-class `session` row**, indistinguishable from a top-level session except for `parent_id`. No separate "subagent" table, no marker column.

Verbatim, redacted, probe 1 — the complete new child `session` row:

```json
{
  "id": "ses_008059773ffenwuq9PQN3wdajn",
  "project_id": "global",
  "parent_id": "ses_00805b0c4ffe83RIol5CpbYSsX",
  "slug": "nimble-harbor",
  "directory": "/tmp/opencode-spawn-probe",
  "title": "Return required word (@general subagent)",
  "version": "1.18.16",
  "share_url": null,
  "summary_additions": 0,
  "summary_deletions": 0,
  "summary_files": 0,
  "summary_diffs": null,
  "revert": null,
  "permission": "[{\"permission\":\"question\",\"pattern\":\"*\",\"action\":\"deny\"},{\"permission\":\"plan_enter\",\"pattern\":\"*\",\"action\":\"deny\"},{\"permission\":\"plan_exit\",\"pattern\":\"*\",\"action\":\"deny\"},{\"permission\":\"task\",\"pattern\":\"*\",\"action\":\"deny\"}]",
  "time_created": 1786571810956,
  "time_updated": 1786571812333,
  "time_compacting": null,
  "time_archived": null,
  "workspace_id": null,
  "path": "",
  "agent": "general",
  "model": "{\"id\":\"gpt-5.6-sol\",\"providerID\":\"openai\",\"variant\":\"default\"}",
  "cost": 0.053155,
  "tokens_input": 10595,
  "tokens_output": 6,
  "tokens_reasoning": 0,
  "tokens_cache_read": 0,
  "tokens_cache_write": 0,
  "metadata": null
}
```

Three things are load-bearing for an ingester:

- **`title`** is machine-generated as `<description> (@<agent> subagent)` — upstream `params.description + \` (@${next.name} subagent)\``. It is a reliable _hint_ that a session is a subagent, but it is a display string, not the link.
- **`agent`** carries the subagent type (`general`), matching the parent's `state.input.subagent_type`.
- **`permission`** ends with `{"permission":"task","pattern":"*","action":"deny"}` on the child and not on the parent. That deny is what caps nesting in practice.

The child's own message/part records are ordinary: `role: "user"` (the delegated prompt, verbatim) then `role: "assistant"`. The child's messages carry `agent: "general"`; nothing inside a child message names the parent.

## The link

Two independent edges, both measured:

| edge                          | field                                                     | direction              | note                                        |
| ----------------------------- | --------------------------------------------------------- | ---------------------- | ------------------------------------------- |
| child → parent **session**    | `session.parent_id` (SQL) = `SessionInfo.parentID` (JSON) | child names parent     | authoritative, always present for subagents |
| parent **tool call** → child  | `part.data.state.metadata.sessionId`                      | parent names child     | ties the spawn to the exact turn            |
| parent **tool call** → parent | `part.data.state.metadata.parentSessionId`                | redundant back-pointer | **1.18.16+ only**                           |

**Which id ties the spawn to the exact parent turn:** the `part` row carries `message_id` and `session_id` columns and a `data.callID`. So the full chain is

```
session(child).parent_id
      ↕
part.session_id = parent session
part.message_id = the parent assistant message that issued the call
part.data.callID = the provider-level tool-call id
part.data.state.metadata.sessionId = child session id
```

`callID` is the provider's id (`call_…` for OpenAI); it is unique within the parent session but is **not** a session id and does not appear anywhere in the child.

Upstream confirmation — `packages/opencode/src/tool/task.ts`, symbol `TaskTool`, inner `Effect.fn("TaskTool.execute")`:

```ts
const nextSession = session ?? (yield* sessions.create({
  parentID: ctx.sessionID,
  title: params.description + ` (@${next.name} subagent)`,
  agent: next.name,
  permission: [ ...childPermission, ...childToolDenies.filter(…) ],
}))
```

The parent-session field name in source is **`parentID`**, declared in `packages/schema/src/v1/session.ts:550`, symbol `SessionInfo`:

```ts
export const SessionInfo = Schema.Struct({
  id: SessionID,
  slug: Schema.String,
  projectID: Project.ID,
  workspaceID: optional(WorkspaceID),
  directory: Schema.String,
  path: optional(Schema.String),
  parentID: optional(SessionID),
  …
}).annotate({ identifier: "Session" })
```

(`packages/schema/src/session-v1.ts` is a one-line re-export `export * from "./v1/session"`; `packages/core/src/v1/session.ts` re-exports `SessionInfo` from `@opencode-ai/schema/session-v1`. The path moved — resolve through those re-exports rather than guessing.)

The SQL column is `parent_id`; the JSON/event field is `parentID`. Same edge, two spellings.

## Join: how results come back

A **text envelope** inside `part.data.state.output`. There is no structured result field.

Built by `renderOutput()` in `packages/opencode/src/tool/task.ts`:

```ts
function renderOutput(input: {
  sessionID: SessionID;
  state: "running" | "completed" | "error";
  summary?: string;
  text: string;
}) {
  const tag = input.state === "error" ? "task_error" : "task_result";
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n");
}
```

### Exact byte shape — current (1.18.16)

Measured on the probe output, 104 bytes total:

```
<task id="ses_008059773ffenwuq9PQN3wdajn" state="completed">\n<task_result>\nBANANA\n</task_result>\n</task>
```

Byte arithmetic, with a 30-character session id and **no** `<summary>`:

| segment                     | bytes                                            |
| --------------------------- | ------------------------------------------------ |
| `<task id="`                | 10                                               |
| session id                  | 30                                               |
| `" state="` + state + `">`  | 20 for `completed` (`"` + ` state="` + 9 + `">`) |
| `\n<task_result>\n`         | 15                                               |
| **header total**            | **75**                                           |
| body text                   | _n_                                              |
| `\n</task_result>\n</task>` | 23                                               |
| **total**                   | **98 + n** → 98 + 6 = 104 ✓                      |

- `state` ∈ `running` \| `completed` \| `error`. `running` is what a **background** spawn returns immediately.
- When `state="error"` the tag becomes `task_error` / `</task_error>` — the closing tag changes with it.
- A `<summary>…</summary>` line is inserted between the open tag and `<task_result>` **only** for background start/update/injection envelopes.
- The body is the child's **last text part**: `result.parts.findLast((item) => item.type === "text")?.text ?? ""`. Tool calls, reasoning and intermediate text are dropped from the join.

### Exact byte shape — legacy (≤ 1.2.21 in this store)

29 of 33 historical task parts, all with a byte-identical header form (measured: 1 distinct form):

```
task_id: ses_3131f61eeffesjDHOeAro7lg0P (for resuming to continue this task if needed)\n\n<task_result>\n…\n</task_result>
```

| segment                                           | bytes   |
| ------------------------------------------------- | ------- |
| `task_id: `                                       | 9       |
| session id                                        | 30      |
| ` (for resuming to continue this task if needed)` | 47      |
| `\n\n<task_result>\n`                             | 16      |
| **header total**                                  | **102** |
| `\n</task_result>` (no `</task>`)                 | 15      |

The TUI parses either shape with one regex (measured in the binary): `/<task_result>\s*([\s\S]*?)\s*<\/task_result>/`.

## Agent-to-agent messages

**Absent. opencode expresses only parent-to-child task delegation.** Reported as a negative with counts:

- **Message roles: 2, ever.** Schema declares exactly `role: Schema.Literal("user")` and `role: Schema.Literal("assistant")` (`packages/schema/src/v1/session.ts:334,455`). Measured across all 1,455 message rows in this store (post-probe): `{"user":116,"assistant":1339}`. There is no `agent`, `peer` or `system` role, and no `from`/`to`/`sender`/`recipient` field anywhere in `SessionInfo`, the message schemas, or the part schemas.
- **Tools: no messaging primitive.** 14 part-type literals and the full tool registry contain nothing that addresses another agent. Measured across all 6,148 part rows (post-probe), 12 distinct tools were ever used: `read` 819, `bash` 416, `edit` 233, `todowrite` 163, `glob` 117, `write` 117, `question` 48, **`task` 34**, `grep` 26, `skill` 21, `webfetch` 11, `apply_patch` 8. Binary strings add `list`, `patch`, `websearch`, `invalid`. No `send_message`, no `broadcast`, no `hub`-equivalent. (Grepping the binary for `broadcast`/`MessageChannel`/`peer` returns only Bun/WHATWG runtime internals and TLS error strings — not opencode features.)
- **`AgentPart` is not a message.** There is a part type `type: "agent"` (`packages/schema/src/v1/session.ts:181`), but it is `{ name: string, source?: { value, start, end } }` — an `@agent-name` mention span inside a **human's** user message, used for routing the human's turn. It carries no session id and no sender.
- **The only cross-session write is the background injection**, and it is still parent-child: `TaskTool.injectBackgroundResult` prompts `ctx.sessionID` (the parent) with a `synthetic: true` text part containing the child's `renderOutput` envelope. A sibling can never write into another sibling.
- Siblings are therefore only _inferable_: two children sharing a `parent_id`. There is no record of them exchanging anything, because they cannot.

## Nesting and identity

**Depth.** The schema permits arbitrary depth (`parentID` is a plain optional self-reference), but the runtime caps it at 1 by default, and does so **twice**:

1. `subagent_depth` (default 1) — `TaskTool.execute` walks the chain and fails before spawning:
   ```ts
   let current = parent,
     depth = 0;
   while (current.parentID) {
     depth++;
     current = yield * sessions.get(current.parentID);
   }
   if (depth >= (cfg.subagent_depth ?? 1))
     return (
       yield *
       Effect.fail(
         new Error(
           `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
         ),
       )
     );
   ```
2. A **permission deny baked into the child session row** — `deriveSubagentSessionPermission()` in `packages/opencode/src/agent/subagent-permissions.ts` appends `{permission:"task", pattern:"*", action:"deny"}` unless the subagent's _own_ agent definition already carries a `task` rule.

**Measured, probe 2:** with a project config of `{"subagent_depth": 2}` the nested spawn still failed. The child reported `no Task/subagent tool is available in this session`, and the DB gained exactly **2** sessions, not 3 — the grandchild was never created. The child's `permission` column contained the `task`/`deny` rule regardless of `subagent_depth`. So raising `subagent_depth` alone is insufficient; the subagent must also be granted `permission.task` in its agent definition. `[INFERENCE]` — setting both (`subagent_depth: 2` plus `agent.general.permission.task: "allow"`) would allow depth 2; derived from `canTask` in `deriveSubagentSessionPermission`, not probed, to stay inside the two-spawn budget.

Consequence for an ingester: in a default install the agent tree is exactly **two levels**, and `parent_id IS NULL` is a sound root test. Measured over this store: **before** the probes 57 sessions / 31 with a non-null `parent_id`; **after** 61 sessions / 33 with a non-null `parent_id`; **0 orphaned** in both snapshots (every `parent_id` resolves to a row present in the same table).

**Id schemes and time-sortability** — all measured over the full store:

| prefix | length | sorts chronologically                                                                        |
| ------ | ------ | -------------------------------------------------------------------------------------------- |
| `ses_` | 30     | **DESCENDING** — verified exactly across all 61 sessions; id-ASC does _not_ match time order |
| `msg_` | 30     | **ASCENDING** — verified exactly across all 1,455 messages                                   |
| `prt_` | 30     | **ASCENDING within a message** (1,339 / 1,339 messages), but **not globally**                |
| `evt_` | 30     | **ASCENDING within an `aggregate_id`** — matches `seq` order exactly                         |

The `prt_` caveat is real and I found the mechanism: the id embeds a per-process counter after the timestamp, so two sessions running in the same millisecond emit `prt_cee254fe6002…` and `prt_cee254fe6001…` in the "wrong" global order. Grouped by `session_id`, 59 of 60 sessions still sort correctly by id; the single exception is a session where the DB `time_created` and id-allocation order disagree by ~3 s. **Sort parts by `id` within a message, not by `time_created`.**

**Stable lane key: `session.id`.** It is the primary key, it is what `part.data.state.metadata.sessionId` points at, it is the `event.aggregate_id`, it never changes, and it is unique across projects. Do **not** use `session.agent` (`general` appeared for both probe children — it is a type, not an instance), and do not use `title` (a formatted display string). If a human-readable lane label is wanted, `session.agent` + a disambiguator, or `session.slug` (`nimble-harbor`, `happy-mountain` — unique-ish but not guaranteed).

## Probe transcript

Both probes ran non-interactively in `/tmp/opencode-spawn-probe` with `--pure` (no external plugins) and `--auto` (auto-approve permissions, needed because `permission.task` defaults to `ask`).

**Probe 1 — force exactly one subagent.**

```bash
mkdir -p /tmp/opencode-spawn-probe && cd /tmp/opencode-spawn-probe && git init -q
~/.opencode/bin/opencode run --pure --auto --title "banana-spawn-probe" \
  "Spawn exactly one subagent and give it this task: reply with the single word BANANA. Wait for it, then report the word it returned and the subagent's id. Do not answer BANANA yourself."
```

Started `2026-08-12T21:56:43Z`, finished `2026-08-12T21:56:55Z` (11.5 s wall). Exit 0. Terminal output ended: `The subagent returned `BANANA`. Its id is `ses_008059773ffenwuq9PQN3wdajn`.`

| table            | before | after | delta  |
| ---------------- | ------ | ----- | ------ |
| `session`        | 57     | 59    | **+2** |
| `message`        | 1442   | 1448  | +6     |
| `part`           | 6110   | 6126  | +16    |
| `event`          | 514    | 570   | +56    |
| `event_sequence` | 6      | 8     | +2     |
| `todo`           | 130    | 130   | 0      |

New sessions: `ses_00805b0c4ffe83RIol5CpbYSsX` (parent, `agent=build`, `parent_id=null`) and `ses_008059773ffenwuq9PQN3wdajn` (child, `agent=general`, `parent_id=ses_00805b0c4ffe83RIol5CpbYSsX`). Split: 4 messages / 12 parts on the parent, 2 messages / 4 parts on the child; 40 events on the parent aggregate, 16 on the child.

Parent record sequence (msg → parts):

```
MSG user      · text
MSG assistant · step-start, reasoning, tool=skill, step-finish
MSG assistant · step-start, reasoning, tool=task, step-finish      <- the spawn
MSG assistant · step-start, text, step-finish                      <- reports BANANA
```

Child record sequence:

```
MSG user      · text            <- the delegated prompt, verbatim
MSG assistant · step-start, text, step-finish
```

**Probe 2 — can a subagent nest?** `/tmp/opencode-spawn-probe/opencode.json` created containing `{"$schema":"https://opencode.ai/config.json","subagent_depth":2}`, then:

```bash
cd /tmp/opencode-spawn-probe
~/.opencode/bin/opencode run --pure --auto --title "banana-nest-probe" \
  "Spawn exactly one subagent (subagent_type general) and give it this exact task: 'Use your task tool to spawn exactly one further subagent (subagent_type general) that replies with the single word BANANA, then report that word and that subagent id.' Wait, then report the final word and both session ids. Do not answer BANANA yourself."
```

22.2 s wall, exit 0. Delta: `session` +2 (**not +3**), `message` +7, `part` +22, `event` +72. Sessions `ses_00801f0d7ffeV14odW5sb4LXAn` (parent) and `ses_00801ce77ffer8DRcCHICj1lPq` (child). The child produced no `task` part; its final text was `I can't complete this: no Task/subagent tool is available in this session…`, which the parent's join envelope wrapped as a normal `state="completed"` result.

Two spawns total, as budgeted. Store read read-only via `bun:sqlite` throughout; nothing in the store or in `~/.config/opencode/` was modified.

## Gaps and traps

1. **Two incompatible join envelopes coexist in one database, and the version column is the only discriminator.** Measured across all 34 `task` parts in this store: 29 legacy `task_id: …` (all `session.version = 1.2.21`, March 2026), 3 with empty output (`status = error`, also 1.2.21), 2 new `<task id=… state=…>` (`1.18.16`, the two probes). A parser must branch on the leading bytes (`task_id: ` vs `<task `), not on a config flag. The shared `<task_result>` regex is the only thing that works on both. Note the split is perfectly clean: **zero** legacy-format parts exist on a 1.18.16 session and vice versa.
2. **`state.metadata.parentSessionId` is new.** Present in 2 of 34 task parts — both written today. Do not depend on it; `session.parent_id` is the durable edge.
3. **Truncation clips the closing tag.** `state.metadata.truncated: true` (1 occurrence measured) came with `state.metadata.outputPath` pointing at `~/.local/share/opencode/tool-output/tool_<id>`, and the stored 51,544-byte `output` **ends mid-sentence with no `</task_result>`**. A regex requiring the closing tag silently drops the whole result. Exact key presence over the 34 task parts: `sessionId` 33, `model` 33, `truncated` 31, `parentSessionId` 2, `outputPath` 1 — so treat a missing `truncated` as "unknown", not "false", and note `outputPath` appears only when clipping happened.
4. **A failed spawn can carry no child id at all.** 3 of 34 task parts have `state.status = "error"` (31 `completed`). Of those three, one has **no `state.metadata` object whatsoever** — no `sessionId`, nothing. For that call the child session is unrecoverable from the parent side; only a `parent_id` scan of the `session` table could find it, and if the session was never created there is nothing to find. An ingester must tolerate a spawn tool call that names no child.
5. **The join is lossy by design.** Only the child's _last_ text part reaches the parent. Everything the child actually did is reachable only by following `parent_id` into the child session. An ingester that reads the parent transcript alone sees one opaque string.
6. **`part` rows are mutated in place; the lifecycle exists only in `event`.** The `part` table held exactly 1 row for the probe's `callID`, showing only `status=completed`. The `event` table held 4 `message.part.updated.1` rows for the same part: `pending` (no ids) → `running` (child `sessionId` **and** `parentSessionId` already populated, `output` empty) → `running` → `completed` (104-byte output). **The child session id is knowable at spawn time, not just at join time** — an ingester using the event stream can open the child lane when the spawn starts; one using the `part` table cannot distinguish spawn time from join time at all.
7. **The `event` table adds ordering, not new linkage.** `session.created.1` carries `data.info.parentID` — the same edge as `session.parent_id`, just camelCase, plus the full `SessionInfo` including the `permission` ruleset. It does **not** carry any tool-call-level parent link that the older tables lack; the spawn→turn link still comes from the `part` row. What it _does_ add is a monotone per-session `seq` (`aggregate_id` = session id, `seq` 0..n), which is a sounder ordering than `time_created`.
8. **The `event` table does not cover history.** Measured: 61 sessions, **only 10 covered** by `event_sequence` (all `version ≥ 1.17.15`, earliest `2026-07-09`); the 51 sessions on `1.2.21` have zero events. The table was added by migration `20260323234822_events`. An ingester must treat `event` as an optional accelerator and fall back to `session`/`message`/`part`. (`OPENCODE_DISABLE_CHANNEL_DB` and `OPENCODE_DISABLE_PRUNE` exist, so coverage may also be truncated at the other end. `[INFERENCE]` — pruning behaviour not probed.)
9. **The WAL is not optional.** 4.3 MB of the store was uncheckpointed WAL at probe time. Copying `opencode.db` alone loses recent sessions — including, in this case, both probes.
10. **`part.time_created` is not a reliable sort key** (see _Nesting and identity_); sort by `prt_` id within a message. Conversely `ses_` sorts _descending_ — a naive `ORDER BY id` lists sessions oldest-last, which silently reverses every session-level timeline.
11. **`title` is a formatted string, not data.** `"<description> (@<agent> subagent)"` is generated by string concatenation upstream. Parsing it to recover the agent name works today but is not a contract; use `session.agent`.
12. **Background subagents change the shape without changing the version.** With `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`, the spawn part's terminal `output` is a `state="running"` envelope carrying `<summary>Background task started</summary>` and boilerplate prose — **never** the child's answer — and `state.metadata` gains `background: true` and `jobId`. The real result arrives later as a **`synthetic: true` text part in a new parent message** (`TaskTool.injectBackgroundResult`), disconnected from the original `callID`. `[INFERENCE]` — read from source, not probed; the flag was off on this machine.
13. **`task_id` re-entry breaks the 1 spawn = 1 child assumption.** The tool accepts an optional `task_id` parameter ("resume a previous task … instead of creating a fresh one"). When set, `sessions.create` is skipped and **no new session row appears** — two different `task` parts in two different parent turns then point at the same child `sessionId`. Child sessions are not 1:1 with spawn calls.
14. **`project_id` was `global`** for both probes (run from `/tmp`), so project id is not a usable partition key for scratch or non-VCS directories.
