---
status: current
owner: maintainers
last_reviewed: 2026-08-12
normative: false
milestone: Gate 5
---

> 附录：Oh My Pi (omp) 的 spawn 记录实测原始报告。汇总与跨 harness 对比见 [六个 Agent Harness 的 spawn 记录格式](../agent-spawn-formats.md)。

# Oh My Pi (`omp`)

Everything below was measured on this machine on 2026-08-12 unless tagged `[INFERENCE]`.
Two live probes were run (1 spawn, then 2 spawns). Redaction: no `thinking` /
`thinkingSignature` payloads are reproduced, the home directory is written `~`, and prose is
clipped to a sentence.

## Version and enablement

- Binary `~/.bun/bin/omp`; `omp --version` → `omp/17.2.15`.
- **Subagents are on by default. There is no flag, no config key and no opt-in.** The probe
  ran `omp -p "<prompt>"` in a scratch dir with a default config and got a spawn on the first
  attempt. The `task` tool is always registered; the `hub` tool is registered
  `loadMode: "essential"`.
- **Recording is on by default too.** Sessions persist unless `--no-session` is passed.
  Subagent `<Name>.jsonl` / `<Name>.md` artifacts are written when the parent session has an
  artifacts dir, i.e. whenever the parent is persisted; otherwise they go to a temp dir
  (`omp://tools/task.md`, "Artifacts dir comes from the parent session file when available,
  otherwise a temp dir"). No verbosity/trace flag exists or is needed.
- Settings that change the _shape_ of what is recorded, not whether it is recorded
  (`omp://tools/task.md`):
  - `task.batch` (default **on**) — one `task` call carries `{context, tasks[]}`, so one tool
    call can spawn N children. Off → one spawn per call, and `context` is rejected.
  - `async.enabled` (default **on**) — spawns become background jobs, so the parent's `task`
    tool result is a _spawn receipt_, not a result, and the result arrives later as a separate
    `async-result` record. Off → the tool result carries the child's output inline.
  - `task.maxRecursionDepth` — hides `task` from the child at the limit; caps nesting depth.
  - `task.agentIdleTtlMs` (default `420000`) — after this a finished child is parked; the JSONL
    stays on disk.
- Harness docs are readable in-session at `omp://` (127 files); the two that matter are
  `omp://session.md` (entry taxonomy, authoritative) and `omp://tools/task.md`.

## Where the trace lives

```
~/.omp/agent/sessions/<bucket>/
├── <timestamp>_<sessionId>.jsonl          # the main (parent) session, JSONL
├── <timestamp>_<sessionId>/               # sibling dir, same name minus .jsonl
│   ├── <AgentName>.jsonl                  # one per subagent: its full session
│   ├── <AgentName>.md                     # one per subagent: its final output artifact
│   ├── <AgentName>/                       # only if that subagent spawned children
│   │   └── <AgentName>.<ChildName>.jsonl  # depth-2, dot-qualified
│   ├── local/                             # local:// shared artifacts (parent + all children)
│   └── <n>.<tool>.log                     # spilled tool output → artifact://<n>
├── ~/.omp/agent/blobs/<sha256>            # externalized image payloads
├── ~/.omp/agent/terminal-sessions/<id>    # breadcrumb: cwd + session path
└── ~/.omp/agent/history.db                # SQLite prompt history, NOT session replay
```

`<timestamp>` is `2026-08-12T13-41-44-827Z`; `<sessionId>` is a UUIDv7. Format is JSONL, one
JSON object per line, **first physical line is a fixed-width 256-byte title slot**
(`{"type":"title","v":1,"title":…,"updatedAt":…,"pad":"   …"}`), second is the session header.
A naive reader that assumes line 1 is the header gets the pad record.

`<bucket>` measured on this machine: `-Projects-IntentTrace`, `-Projects-wavel`, `-tmp`,
`-tmp-omp-spawn-probe`. That is the **legacy** separator-replacement scheme
(`/home/<user>/Projects/IntentTrace` → `-Projects-IntentTrace`; `/tmp/omp-spawn-probe` →
`-tmp-omp-spawn-probe`). `omp://session.md` documents a newer
`<scope>-<basename>-<sha256(cwd)>` scheme; **17.2.15 on this box has not migrated**, so an
ingester must accept both and must not try to parse the cwd out of the bucket name.

Measured counts under `~/.omp/agent/sessions/-Projects-IntentTrace/`:

| session                                         | main .jsonl bytes | child .jsonl | child .md | `*.log` | `local/` |
| ----------------------------------------------- | ----------------- | ------------ | --------- | ------- | -------- |
| `2026-08-07T01-30-01-721Z_019fd9d7-…3168248`    | 2 146             | (no dir)     | –         | –       | –        |
| `2026-08-09T14-39-01-940Z_019fe6f6-…fb20d25`    | 1 174 709         | 6            | 6         | 25      | 1        |
| `2026-08-09T16-55-10-074Z_019fe773-…506f8f61`   | 8 054 745         | 53           | 53        | 87      | 2        |
| `2026-08-12T13-41-44-827Z_019ff635-…63cd0dbd2c` | 992 777           | 8            | 8         | 0       | 4        |
| `2026-08-12T14-46-43-564Z_019ff670-…9a586c6`    | 1 827 573         | 10           | 4         | 34      | 4        |

(The last row is live; `.md` files appear only as children finish. The first row is a session
that never spawned — **the directory is created lazily, its absence is not an error.**)

Newest session, one line:

```sh
ls -t ~/.omp/agent/sessions/*/*.jsonl | head -1
```

## Spawn: parent side

Three records, always in this order, appended to the **parent's** `<timestamp>_<id>.jsonl`.
Verbatim from probe 1 (`thinking` block removed, prompt text intact because it is my own):

**1. assistant `message` carrying the `task` tool call**

```json
{
  "type": "message",
  "id": "8373732a",
  "parentId": "8af5935f",
  "timestamp": "2026-08-12T21:58:50.437Z",
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "toolCall",
        "id": "call_DP3MgDl9hnlVS8tbqxmqSO4O",
        "name": "task",
        "arguments": {
          "context": "# Goal\nReturn the requested single-word response.\n# Constraints\n…",
          "i": "Spawn one exact-response subagent",
          "tasks": [
            {
              "name": "BananaResponder",
              "agent": "sonic",
              "task": "Reply with exactly the single word BANANA. …"
            }
          ]
        }
      }
    ]
  }
}
```

**2. `custom` / `tool_execution_start` marker**

```json
{
  "type": "custom",
  "customType": "tool_execution_start",
  "data": {
    "toolCallId": "call_DP3MgDl9hnlVS8tbqxmqSO4O",
    "toolName": "task",
    "startedAt": "2026-08-12T21:58:50.438Z",
    "intent": "Spawn one exact-response subagent"
  },
  "id": "6b050996",
  "parentId": "8373732a",
  "timestamp": "2026-08-12T21:58:50.438Z"
}
```

**3. `message` / `role:"toolResult"` — the spawn receipt**

```json
{
  "type": "message",
  "id": "2a688d56",
  "parentId": "6b050996",
  "timestamp": "2026-08-12T21:58:50.449Z",
  "message": {
    "role": "toolResult",
    "toolCallId": "call_DP3MgDl9hnlVS8tbqxmqSO4O",
    "toolName": "task",
    "content": [
      {
        "type": "text",
        "text": "Spawned agent `BananaResponder` (job `BananaResponder`). Its result auto-delivers on yield …"
      }
    ],
    "details": {
      "projectAgentsDir": null,
      "results": [],
      "totalDurationMs": 2,
      "async": { "state": "running", "jobId": "BananaResponder", "type": "task" },
      "progress": [
        {
          "index": 0,
          "id": "BananaResponder",
          "agent": "sonic",
          "agentSource": "bundled",
          "modelRole": "smol",
          "status": "pending",
          "task": "Complete assignment thoroughly:\n\nReply with exactly …",
          "assignment": "Reply with exactly the single word BANANA. …",
          "recentTools": [],
          "recentOutput": [],
          "toolCount": 0,
          "requests": 0,
          "tokens": 0,
          "cost": 0,
          "durationMs": 0
        }
      ]
    },
    "isError": false,
    "timestamp": 1786571930449
  }
}
```

A batch spawn is the same three records with N entries in `tasks[]` and N in
`details.progress[]`; the text becomes a list (measured, IMO session):

```
Spawned 3 background agents using task. …
- `ImoBruteForce` (job `ImoBruteForce`)
- `ImoConstructions` (job `ImoConstructions`)
- `ImoImpossibility` (job `ImoImpossibility`)
```

**The machine-readable child identity is `details.progress[].id` (and `details.async.jobId`),
which is the agent _name_, not a session id.** `details.results` is `[]` for background
spawns; it is populated only when `async.enabled=false`.

## Spawn: child side

New file `<sessiondir>/<AgentName>.jsonl`. Probe 1's child, complete record sequence
(12 records, 51 404 bytes):

| #   | id                                     | parentId   | record                                                |
| --- | -------------------------------------- | ---------- | ----------------------------------------------------- |
| 0   | –                                      | –          | `title` (256-byte pad slot)                           |
| 1   | `019ff7fc-3b59-7000-babe-18d698db22a1` | –          | `session` header                                      |
| 2   | `e89d0cb7`                             | `null`     | `model_change`                                        |
| 3   | `d3010280`                             | `e89d0cb7` | `thinking_level_change`                               |
| 4   | `4819bd68`                             | `d3010280` | `session_init`                                        |
| 5   | `8d5d36ef`                             | `4819bd68` | `message` role `user` (the assignment)                |
| 6   | `1064ac64`                             | `8d5d36ef` | `message` role `assistant` (thinking + text "BANANA") |
| 7   | `ef76298e`                             | `1064ac64` | `message` role `developer` (yield reminder 1 of 3)    |
| 8   | `cff589ef`                             | `ef76298e` | `message` role `assistant` (`toolCall` `yield`)       |
| 9   | `a4fd335a`                             | `cff589ef` | `custom` `tool_execution_start`                       |
| 10  | `cf0ed47b`                             | `a4fd335a` | `message` role `toolResult` `yield`                   |
| 11  | `489e41b7`                             | `cf0ed47b` | `custom` `session_exit`                               |

**Header — note what is absent:**

```json
{
  "type": "session",
  "version": 3,
  "id": "019ff7fc-3b59-7000-babe-18d698db22a1",
  "timestamp": "2026-08-12T21:58:50.457Z",
  "cwd": "/tmp/omp-spawn-probe"
}
```

No `parentSession`. No agent name. No parent session id. No job id. `omp://session.md`
documents an optional `parentSession` lineage field — **grep over every session file on this
machine: 0 occurrences.** It is written by `/fork` flows, never by `task`.

**`session_init` — the only child-side record about the spawn:**

```json
{
  "type": "session_init",
  "id": "4819bd68",
  "parentId": "d3010280",
  "timestamp": "2026-08-12T21:58:50.470Z",
  "systemPrompt": "<system-conventions>\nRFC 2119: MUST, REQUIRED, …",
  "task": "Complete assignment thoroughly:\n\nReply with exactly the single word BANANA. …",
  "tools": [
    "read",
    "bash",
    "edit",
    "eval",
    "glob",
    "grep",
    "task",
    "hub",
    "web_search",
    "write",
    "yield"
  ],
  "agent": "sonic",
  "modelRole": "smol",
  "resolvedModel": "openai-relay/gpt-5.6-sol:xhigh",
  "readOnly": false,
  "spawns": ""
}
```

`agent` is the agent **type** (`sonic`, `task`, `scout`, …), not the id. Read-only spawns also
carry `restrictToolNames: true` (measured on `ImoWriteup`).

**The child's own id appears exactly once in its whole file** — measured, `grep -c
BananaResponder BananaResponder.jsonl` → 1 occurrence, and it is inside
`session_init.systemPrompt` as English prose:

```
§ Coop
You are operating on a piece of work assigned to you by the main agent.
# Peers
You can reach other live agents via the `hub` tool. Your id is `BananaResponder`.
Currently visible peers:
- `Main` — main (main, running)
```

That prose block is also the only place the parent is named, and it names it `Main`, a literal,
not an id.

## The link

**The link is the filename.** `<parent-session-dir>/<AgentName>.jsonl` sits inside the
directory whose name is the parent session file minus `.jsonl`. Nothing inside either file
carries the other's session id.

Measured, IMO session, 8 children:

| check                                              | result                                                                                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| child session UUID present anywhere in parent file | **1 / 8**                                                                                                                                                                   |
| that one hit is a structural reference             | **no** — `WebUiSurface` was a scout that _read_ its own JSONL and the file content landed in a `read` tool result in the parent transcript. Accidental content, not a link. |
| child header names the parent                      | 0 / 8                                                                                                                                                                       |
| `parentSession` field anywhere                     | 0 occurrences store-wide                                                                                                                                                    |

Probe 1, clean-room repeat: child session id `019ff7fc-3b59-7000-babe-18d698db22a1` present in
parent file → **False**. The string `BananaResponder` appears 20× in the parent file, all of it
inside tool-call arguments, receipt prose and job snapshots.

**Spawn → exact parent turn** is properly linked, by `toolCallId`:
`call_DP3MgDl9hnlVS8tbqxmqSO4O` appears in (a) the assistant message's `content[].toolCall.id`,
(b) `tool_execution_start.data.toolCallId`, (c) the `toolResult.message.toolCallId`. That is a
real 3-way join key on the parent side. It never reaches the child.

So the only usable child↔parent join for an ingester is
`agentName = basename(childFile, ".jsonl")` matched against
`parentToolResult.details.progress[].id`, which is exactly the same string. It is unique per
session (`AgentOutputManager` uniquifies: `Task`, `Task-2`, `Task-3`).

## Join: how results come back

Two structured paths, both on the parent side, plus one file artifact.

**(a) Auto-delivery — `custom_message` / `customType: "async-result"`** (measured, IMO session):

```json
{
  "type": "custom_message",
  "customType": "async-result",
  "display": true,
  "details": {
    "jobs": [
      {
        "jobId": "IngestAndFixtures",
        "type": "task",
        "label": "IngestAndFixtures",
        "durationMs": 335665
      }
    ]
  },
  "attribution": "agent",
  "id": "650f379a",
  "parentId": "150d5402",
  "timestamp": "2026-08-12T14:24:36.987Z",
  "content": "<system-notice>\nBackground job IngestAndFixtures has completed. …\n<task-result id=\"IngestAndFixtures\" agent=\"scout\" status=\"completed\" duration=\"5m35s\">\n<meta lines=\"58\" size=\"29.8KB\" />\n<preview full-output=\"agent://IngestAndFixtures\">\n{…}\n</preview>\n</task-result>"
}
```

`details.jobs[]` is structured (`jobId`, `type`, `label`, `durationMs`). The **result itself is
a text envelope** inside `content`: `<task-result id agent status duration>` wrapping
`<meta lines size />` and `<preview full-output="agent://<id>">`. Status, agent type and
duration are attributes of an XML-ish string, not JSON fields.

**(b) `hub` wait/jobs snapshot — `message` / `toolResult` / `toolName:"hub"`** (measured,
probe 1):

```
## Completed (1)

### BananaResponder [task] — failed
Label: BananaResponder
Error: <task-result id="BananaResponder" agent="sonic" status="failed (exit 1)" duration="14.9s">
<meta lines="3" size="61B" />
<output>
SYSTEM WARNING: Subagent called yield with null data.

BANANA
</output>
</task-result>

BananaResponder is now idle — message it via `hub` to follow up; transcript at history://BananaResponder
```

```json
"details":{"op":"wait","jobs":[{"id":"BananaResponder","type":"task","status":"failed",
  "label":"BananaResponder","durationMs":14916,
  "resolvedModel":"openai-relay/gpt-5.6-sol:xhigh","errorText":"<task-result …>"}]}
```

`details.jobs[].{id,type,status,label,durationMs,resolvedModel}` is genuinely structured;
`resultText` (success) / `errorText` (failure) hold the same text envelope. A run that ends
while still watching also emits `## Still Running (1)\n\n- \`ImoVerifier\` [task] — ImoVerifier`.

**(c) Child side — the `yield` pair.** The child terminates through a hidden `yield` tool:

```json
{"type":"message","id":"cff589ef","parentId":"ef76298e","message":{"role":"assistant",
 "content":[{"type":"toolCall","id":"call_zjZFJfaI4MYxZu4KZY8DIQAa","name":"yield",
             "arguments":{"type":"result","result":{}}}],
 "provider":"openai-relay","model":"gpt-5.6-sol","stopReason":"toolUse"}}
{"type":"message","id":"cf0ed47b","parentId":"a4fd335a","message":{"role":"toolResult",
 "toolCallId":"call_zjZFJfaI4MYxZu4KZY8DIQAa","toolName":"yield",
 "content":[{"type":"text","text":"Result submitted."}],
 "details":{"status":"success","type":"result","useLastTurn":true},"isError":false}}
```

For a structured yield, `toolResult.details.data` holds the parsed object verbatim (measured on
`ImoWriteup`: `details.data.{file,note,content}`).

**(d) `agent://<id>` and `history://<id>` — measured, both resolve to real files that survive
the run.** Probe 2 asked the parent to read both; the `read` results carry `details.resolvedPath`:

| URL              | resolves to                                                                              | first line returned                                     |
| ---------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `agent://Pong`   | `~/.omp/agent/sessions/-tmp-omp-spawn-probe/2026-08-12T22-00-24-846Z_019ff7fd-…/Pong.md` | `SYSTEM WARNING: Subagent called yield with null data.` |
| `history://Pong` | `…/Pong.jsonl` rendered as markdown, 20 lines                                            | `# Pong (idle)`                                         |

Both files still exist after the process exited. The **URLs** are session-scoped
(`AgentOutputManager` allocates ids per session), so they resolve from the owning session or a
resume of it, not from an unrelated session `[INFERENCE]` — grounded in `omp://tools/task.md`
("session-scoped `agent://` id allocation") and `omp://agent-hub.md` ("Opening the Hub for a
persisted session scans that session's artifact tree").

## Agent-to-agent messages

**Yes — omp records sibling/peer DMs, with sender and recipient, on both sides.** Measured in
probe 2 (`Ping` → `Pong`, one hop) and independently in a historical run
(`NodePackaging` ↔ `PgliteViability`).

**Sender side** — in `Ping.jsonl`, a `hub` tool result:

```json
{
  "type": "message",
  "id": "64f30bdb",
  "parentId": "b5f8505d",
  "timestamp": "2026-08-12T22:00:49.633Z",
  "message": {
    "role": "toolResult",
    "toolCallId": "call_IA42OK85PHII5t4SxUFLmnRg",
    "toolName": "hub",
    "content": [{ "type": "text", "text": "Delivered to 1 peer(s):\n- Pong: injected" }],
    "details": {
      "op": "send",
      "from": "Ping",
      "to": "Pong",
      "receipts": [{ "to": "Pong", "outcome": "injected" }]
    },
    "isError": false,
    "timestamp": 1786572049633
  }
}
```

`details.{op,from,to,receipts[].outcome}` — fully structured. `outcome` ∈
`injected | woken | revived | failed`.

**Recipient side, variant 1 — the receiver was blocked in `hub wait`** (probe 2, `Pong.jsonl`):

```json
{
  "type": "message",
  "id": "178c8f0b",
  "parentId": "06fe6b9e",
  "timestamp": "2026-08-12T22:00:50.311Z",
  "message": {
    "role": "toolResult",
    "toolCallId": "call_uP45OMDM9RehPvSLaUQfljMu",
    "toolName": "hub",
    "content": [{ "type": "text", "text": "[15554cd73836cad9] Ping: MANGO" }],
    "details": {
      "op": "wait",
      "from": "Pong",
      "waited": {
        "id": "15554cd73836cad9",
        "from": "Ping",
        "to": "Pong",
        "body": "MANGO",
        "ts": 1786572049632
      }
    },
    "isError": false,
    "timestamp": 1786572050310
  }
}
```

`details.waited` is the richest message record omp writes: **message id, sender, recipient,
body and timestamp, all typed.** Trap: the sibling `details.from` is the _caller_ (`Pong`), not
the sender — only `details.waited.from` is the sender.

**Recipient side, variant 2 — the receiver was mid-turn and the message was injected**
(historical, `PgliteViability.jsonl`):

```json
{
  "type": "custom_message",
  "customType": "irc:incoming",
  "display": true,
  "attribution": "agent",
  "id": "61e59846",
  "parentId": "0a145da3",
  "timestamp": "2026-08-09T21:47:02.335Z",
  "content": "<irc>\nIncoming IRC message from agent `NodePackaging`:\n\nNodePackaging here — I'm covering packaging … Shout if you want that too and I'll drop it.\n</irc>",
  "details": {
    "id": "15516cea462e7867",
    "from": "NodePackaging",
    "message": "NodePackaging here — I'm covering packaging …"
  }
}
```

Here `details` has `{id, from, message}` — **no `to` field**; the recipient is implicit in which
file the record lives in. The message `id` (16 hex) is shared with the sender's bus record and
is the one true message-level join key, but note the _sender_ side does not print it: the
`send` receipt has no message id. So sender→recipient message correlation across the two files
must go through `(from, to, body, ts±1s)`, not an id.

Broadcasts (`to: "all"`) produce one receipt per peer in `receipts[]` and one `irc:incoming` per
recipient file `[INFERENCE]` — not exercised in these probes.

## Nesting and identity

- **Depth:** supported and observed at depth 2. A subagent that spawns gets its own
  subdirectory named after itself, and its children are dot-qualified:
  `…/019ff670-…/CodexSpawn/CodexSpawn.UpstreamCodexProto.jsonl`, and in another project
  `…/GemvFmac/GemvFmac.GemvMeasureMap.jsonl`. Only 2 such files exist store-wide, so depth 2 is
  measured and depth 3+ is `[INFERENCE]` (documented: `agent://<id>/<child>` reads nested
  output; `task.maxRecursionDepth` gates it).
- **Id schemes present in one trace:**

  | id                  | shape                                              | scope       | sortable                       | stable after run |
  | ------------------- | -------------------------------------------------- | ----------- | ------------------------------ | ---------------- |
  | session id          | UUIDv7 `019ff7fc-113f-7000-…`                      | global      | **yes** (v7 prefix is ms time) | yes              |
  | agent name / job id | `BananaResponder`, `CodexSpawn.UpstreamCodexProto` | per session | no                             | yes              |
  | entry `id`          | 8 hex `8373732a`                                   | per file    | no                             | yes              |
  | `toolCallId`        | `call_…` / `toolu_…` (provider-issued)             | per session | no                             | yes              |
  | IRC message id      | 16 hex `15554cd73836cad9`                          | process     | no                             | yes              |
  | filename timestamp  | `2026-08-12T21-58-39-679Z`                         | global      | **yes**                        | yes              |

- **Lane key: use the agent name** — the basename of the child JSONL, which equals
  `details.progress[].id`, `details.async.jobId`, `hub` `details.jobs[].id`,
  `<task-result id="…">`, `details.from`/`to` on messages, and the `agent://` / `history://`
  authority. It is the one identifier that appears on both sides and in every join surface. The
  parent lane is `Main` (the literal used in the peer roster and as a `to:` target). Do **not**
  use the child session UUID as a lane key: it appears in exactly one file and in no join.
- Time-sortability: every record has RFC3339 `timestamp` at ms precision; `message` records
  additionally carry `message.timestamp` as epoch ms. Both were consistent in every probe
  record; children's timestamps interleave with the parent's, so a global sort across files
  reconstructs the true parallel timeline.

## Probe transcript

**Snapshot.** `find ~/.omp/agent/sessions -mindepth 1 | wc -l` → **607**;
buckets `-Projects-IntentTrace  -Projects-kernel-agent-gpu  -Projects-kobon  -Projects-wavel  -tmp`.
No `-tmp-omp-spawn-probe` bucket existed.

**Probe 1 — one spawn.**

```sh
mkdir -p /tmp/omp-spawn-probe && cd /tmp/omp-spawn-probe
timeout 900 omp -p --max-time 12m "Spawn exactly one subagent and give it this task: reply \
with the single word BANANA. Wait for it, then report the word it returned and the subagent's \
id. Do not answer BANANA yourself."
```

stdout (30.7 s wall):

```
Returned word: BANANA
Subagent ID: `BananaResponder`
```

New bucket `~/.omp/agent/sessions/-tmp-omp-spawn-probe/` with 5 new paths:

| path                                                                                  | bytes  | records |
| ------------------------------------------------------------------------------------- | ------ | ------- |
| `2026-08-12T21-58-39-679Z_019ff7fc-113f-7000-9e1d-86dac929a289.jsonl`                 | 17 015 | 16      |
| `2026-08-12T21-58-39-679Z_019ff7fc-113f-7000-9e1d-86dac929a289/BananaResponder.jsonl` | 51 404 | 12      |
| `…/BananaResponder.md`                                                                | 61     | –       |

Parent session id `019ff7fc-113f-7000-9e1d-86dac929a289`; child session id
`019ff7fc-3b59-7000-babe-18d698db22a1`. Parent record sequence:

```
title · session · model_change · thinking_level_change · user
assistant[thinking,toolCall:read] · tool_execution_start · toolResult:read
assistant[thinking,toolCall:task] · tool_execution_start · toolResult:task
assistant[toolCall:hub] · tool_execution_start · toolResult:hub
assistant[thinking,text] · session_exit
```

The child answered correctly but called `yield` with `{}`, so omp graded the job
`failed (exit 1)` while the text output still contained `BANANA`. Useful negative: **job status
is about protocol compliance, not about the answer.**

**Probe 2 — two spawns, sibling DM.**

```sh
cd /tmp/omp-spawn-probe
timeout 900 omp -p --max-time 12m "Spawn exactly two subagents named Ping and Pong in one task \
batch. Ping's task: use hub op send to='Pong' with the message MANGO, then yield the word SENT. \
Pong's task: use hub op wait from='Ping' with timeoutMs 120000, then yield the exact word you \
received. Neither may touch the filesystem. After both finish, read agent://Pong and \
history://Pong and report verbatim the first line each returned."
```

stdout (54.5 s wall):

```
`agent://Pong`: `# Pong (idle)`

`history://Pong`: `SYSTEM WARNING: Subagent called yield with null data.`
```

(The model swapped the two labels in its prose; the recorded `read` results'
`details.resolvedPath` show `agent://Pong` → `Pong.md` and `history://Pong` → `Pong.jsonl`.
Corrected mapping is in _Join_, above.)

Second session `2026-08-12T22-00-24-846Z_019ff7fd-ac0e-7000-bba7-6d0091216752`, 26 parent
records, children `Ping.jsonl` (13 records, session `019ff7fe-0275-7001-a87d-b658f7b4ec27`) and
`Pong.jsonl` (13 records, session `019ff7fe-0275-7000-8806-9af96c6c3497`), plus `Ping.md`,
`Pong.md`. DM delivered at `22:00:49.633Z`, received at `22:00:50.311Z`.

**Store after both probes:** 616 paths (+9: the new bucket, 2 session dirs, 2 main JSONL,
3 child JSONL, 3 child MD — minus concurrent writes in the IntentTrace bucket from other agents
during the window).

**Corpus cross-checks (not probes).** `~/.omp/agent/sessions/-Projects-IntentTrace/2026-08-12T13-41-44-827Z_019ff635-…`:
175 records — `message` 102 (`toolResult` 59, `assistant` 41, `user` 2), `custom` 59,
`custom_message` 5, `thinking_level_change` 3, `mode_change` 3, `title` 1, `session` 1,
`model_change` 1. `customType` distribution: `tool_execution_start` 59, `async-result` 4,
`plan-mode-context` 1. `toolResult.toolName`: `read` 22, `eval` 17, `write` 6, `task` 4,
`hub` 4, `grep` 3, `glob` 1, `bash` 1, `edit` 1.

**`parentId` is positional, not causal — measured.** Over the 173 non-header entries of that
file, `parentId == id of the immediately preceding entry` in **172 / 172** comparable cases;
the first entry has `parentId: null`. Proof that it is not a causal edge: when one assistant
turn issues two parallel tool calls, the second `tool_execution_start`'s `parentId` is the
_first `tool_execution_start`_, not the assistant message that caused it — probe 2 records 5–7:
assistant `d2f55712` → start `8826ad2d` (parent `d2f55712`) → start `804158b9` (parent
`8826ad2d`). Same pattern in the IMO session: `tool_execution_start` `6d3dacdc` has
`parentId: 73e3c016`, another `tool_execution_start`. `parentId` is an append-order back-pointer
in a tree that only branches on `/clear`, rewind or fork. **Causality must come from
`toolCallId`, never from `parentId`.**

**`title_change` and `parentSession`.** `title_change` records exist in interactive sessions
(`{"type":"title_change","title":"…","source":"auto","previousTitle":"…","trigger":"replan"}`)
and re-title mid-session; `-p` print-mode probes produced none and left the title slot empty.
`parentSession`: 0 occurrences store-wide.

## Gaps and traps

**Blunt comparison with Codex 0.147.** Codex writes, on the parent side, a structured
`sub_agent_activity{agent_thread_id, agent_path}` — a typed pointer from the parent's turn to
the child's own thread — and expresses messages as `agent_message{author, recipient}`. omp
17.2.15 does neither of those first things:

1. **No parent-side pointer to the child session.** Codex's `agent_thread_id` has no omp
   counterpart. omp's parent records the _agent name_ only. The child's session UUID exists,
   is written in the child's header, and is referenced by **nothing**. Measured: 0/8 + 0/2
   structural hits. An ingester must reconstruct the edge from the directory layout, which
   means **an omp trace shipped as a single file is unrecoverably flat** — the parent JSONL
   alone tells you a subagent named `X` was spawned and what it returned, but the child's 100
   internal records are in a different file with no back-reference. Any collector that uploads
   "the session file" loses every child.
2. **No `agent_path`.** Depth is encoded in the filesystem (`Parent/Parent.Child.jsonl`) and in
   the dot-qualified name. Parse the name; there is no field.
3. **Messages are half-typed.** omp is _better_ than Codex on the `hub wait` path
   (`details.waited{id,from,to,body,ts}` beats `{author,recipient}`), but the injected path
   (`irc:incoming`) has **no recipient field at all** and the send receipt has **no message
   id**. So the two halves of one DM cannot be joined by id across files; you must match on
   `(from, to, body, ts)`. And a broadcast's per-recipient copies carry no broadcast id.
4. **Results are XML-in-a-string.** `<task-result id agent status duration>` /
   `<meta lines size />` / `<preview full-output="agent://…">` is prose. `status="failed (exit 1)"`
   has to be regex'd. The typed twin (`details.jobs[]`) exists on `hub` results and the
   `async-result` `details.jobs[]`, but **it does not contain the output** — only
   `resultText`/`errorText`, which is the same string. There is no JSON result field on the
   parent side; the only parsed result object lives in the _child's_ `yield` toolResult
   `details.data`.

**Traps that will silently corrupt an ingest:**

- **Line 1 is a 256-byte pad record**, not the header. `{"type":"title","v":1,…,"pad":"    …"}`.
- **`parentId` is not causality.** See the measurement above. Building a call graph from
  `parentId` produces a chain, not a tree, and attributes tool starts to the wrong cause
  whenever two tools run in parallel — which is the common case.
- **`role:"toolResult"` records are `type:"message"`**, not a separate record type; and
  `tool_execution_start` is `type:"custom"`. A reader that only handles `type:"message"` loses
  every intent string and every start timestamp; a reader that only handles known `type` values
  loses `custom` extension records entirely.
- **A `task` toolResult can be synthetic.** Measured: `{"details":{"__synthetic":true,
"source":"interrupt_skipped","executed":false},"isError":true}` with text "Skipped due to
  queued user message." No spawn happened. `details.__synthetic` and `details.executed` are the
  discriminators; the `toolName` is still `task`.
- **Job status ≠ answer quality.** Both probes returned correct content and were graded
  `failed (exit 1)` purely because the model called `yield` with empty data. Mapping
  `status:"failed"` → `status:"error"` in a semantic trace will mislabel successful work. The
  same session also shows the reverse (`ImoConstructions` `completed` while reporting it could
  not run a single check).
- **Truncation and spilling are lossy in the file.** Strings over 500 000 chars are replaced by
  `[Session persistence truncated large content]`; image payloads become `blob:sha256:<hash>`
  pointing into `~/.omp/agent/blobs/`; large tool outputs spill to `<n>.<tool>.log` beside the
  session and are referenced as `artifact://<n>`. The JSONL is not self-contained.
- **Directory-name drift.** `omp://session.md` documents `<scope>-<basename>-<sha256(cwd)>`;
  17.2.15 on this machine still writes `-Projects-IntentTrace`. Both schemes must be tolerated,
  and the docs also state legacy buckets are migrated _best-effort on access_ — meaning a
  bucket can be renamed between two reads.
- **The child's model/agent metadata is not in the parent and vice versa.** `resolvedModel`
  appears in the child's `session_init` **and** in the parent's `hub` `details.jobs[]`, but the
  parent's `task` receipt only has `modelRole` (`smol`/`task`). Reconcile, do not assume.
- **Nothing records _why_ a child was spawned as data.** The `intent` string on
  `tool_execution_start` ("Spawn one exact-response subagent") is a generated one-liner, and
  the shared `context` lives only inside the tool-call arguments and, textually, inside the
  child's `session_init.systemPrompt`. There is no structured task/plan object.
- **Version drift risk is real and recent.** `task.batch` reshapes the tool schema
  (`{context,tasks[]}` vs a flat single spawn) and both shapes are accepted at runtime, so a
  parser must handle `arguments.tasks[]` _and_ `arguments.task`. Likewise `async.enabled`
  decides whether the result is in the `task` toolResult (`details.results[]`, populated) or in
  a later `async-result` record (`details.results: []`). Both shapes appear in this store.
