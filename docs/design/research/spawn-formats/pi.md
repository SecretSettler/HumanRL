---
status: current
owner: maintainers
last_reviewed: 2026-08-12
normative: false
milestone: Gate 5
---

> 附录：pi coding agent 的 spawn 记录实测原始报告。汇总与跨 harness 对比见 [六个 Agent Harness 的 spawn 记录格式](../agent-spawn-formats.md)。

# pi (Pi coding agent)

## Version and enablement

**Product identification (measured).** `~/.nvm/versions/node/v24.14.0/bin/pi` is a 63-byte shim resolving to
`~/.nvm/versions/node/v24.14.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`.

| field                               | value (from the installed `package.json`)                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `name`                              | `@earendil-works/pi-coding-agent`                                                  |
| `version`                           | `0.84.1` (`pi --version` → `0.84.1`)                                               |
| `description`                       | "Coding agent CLI with read, bash, edit, write tools and session management"       |
| `author` / `license`                | Mario Zechner / MIT                                                                |
| `repository.url`                    | `git+https://github.com/earendil-works/pi.git`, `directory: packages/coding-agent` |
| `piConfig.configDir`                | `.pi`                                                                              |
| homepage (README `<img>`/logo link) | `https://pi.dev`                                                                   |

It is **not** a wrapper around another agent. It is a first-party monorepo product: it depends on
sibling packages `@earendil-works/pi-agent-core`, `pi-ai`, `pi-client`, `pi-protocol`, `pi-tui`, all
pinned `^0.84.1`. It talks to model providers directly (`api: "anthropic-messages"`, `openai-*`, …).

Upstream repo, verified by HTTP: `https://github.com/earendil-works/pi` → `200`.
`https://github.com/earendil-works/pi-mono` → `301` redirect to `.../pi` (the repo was renamed; the
shipped `docs/session-format.md:31` still links to the old `pi-mono` name).

**Subagent capability: NOT BUILT IN. Clean negative, four independent pieces of evidence.**

1. README:17 — "Pi ships with powerful defaults but skips features like sub agents and plan mode."
2. README:500 — "**No sub-agents.** There's many ways to do this. Spawn pi instances via tmux, or
   build your own with extensions, or install a package that does it your way."（原文此处链向
   README 自身的 extensions 小节）
3. `docs/usage.md:303` — "It intentionally does not include built-in MCP, sub-agents, permission
   popups, plan mode, to-dos, or background bash."
4. `pi --help`, section **Built-in Tool Names**, is exhaustive and lists exactly seven tools:
   `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. There is no `task`/`subagent`/`spawn_agent`
   entry, and no CLI flag anywhere in `--help` that turns one on.

**What can be enabled.** The package _ships an example extension_ that adds the capability:
`examples/extensions/subagent/` (`index.ts`, `agents.ts`, `agents/{worker,reviewer,scout,planner}.md`,
`prompts/`). `docs/extensions.md:2970` lists it as `subagent/` — "Spawn sub-agents — `registerTool`, `exec`".
It registers a tool literally named `subagent` (`examples/extensions/subagent/index.ts:461-462`).

Enablement paths (from `docs/extensions.md:7,113-120`) — **all opt-in, default state is off**:

| how                                                | scope                                                      |
| -------------------------------------------------- | ---------------------------------------------------------- |
| `pi -e <path/to/index.ts>`                         | one run (what this probe used)                             |
| copy to `~/.pi/agent/extensions/<name>/index.ts`   | global, auto-discovered, `/reload`-able                    |
| copy to `<project>/.pi/extensions/<name>/index.ts` | project-local, loads **only after the project is trusted** |
| `pi install <source>`                              | writes the source into `settings.json`                     |

The tool additionally needs _agent definitions_: markdown files with YAML frontmatter
(`name`, `description`, optional `tools`, `model`) in `~/.pi/agent/agents/` (user scope) or the
nearest ancestor `<dir>/.pi/agents/` (project scope) — `examples/extensions/subagent/agents.ts:88,97-99`.
With zero agent files the tool exists but can dispatch nothing.

This host's actual state: `~/.pi/agent/extensions/` contains exactly one extension,
`sub2api-model-failover.ts` (a provider-failover extension, not a subagent one). So on a default
install **and** on this host, `pi` has no delegation tool.

## Where the trace lives

```
~/.pi/agent/                                   # PI_CODING_AGENT_DIR, default ~/.pi/agent
├── auth.json                                  # 2 bytes here: "{}" (creds come from env)
├── settings.json / settings.shared.json       # 438 bytes each
├── models.json                                # custom provider catalog ({providers:{…}})
├── models-store.json                          # downloaded model catalog
├── extensions/*.ts                            # auto-discovered global extensions
└── sessions/
    └── --<encoded-cwd>--/                     # one dir per working directory
        └── <ISO-timestamp>_<uuidv7>.jsonl     # one file per session
~/.config/pi/
└── anthropic.env                              # NOT pi's own config; a user shell snippet
                                               # (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN)
```

**Format: JSONL, one JSON object per line, `type`-tagged. There is no SQLite anywhere.**
Measured: `find ~/.pi ~/.config/pi -type f \( -name '*.db' -o -name '*.sqlite*' -o -name '*.db3' \) | wc -l`
→ `0`. Every persisted fact is in the `.jsonl` files.

**Directory name encoding** (`dist/core/session-manager.js:245`):
`` const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--` `` — leading
separator stripped, every `/`, `\`, `:` → `-`, wrapped in `--`. So `/tmp/pi-spawn-probe` →
`--tmp-pi-spawn-probe--`. **This is lossy and not invertible** (a real `-` in a path is
indistinguishable from a separator) — but the header's `cwd` field carries the true path.

**Filename** (`session-manager.js:666-667`): `${new Date().toISOString().replace(/[:.]/g,"-")}_${sessionId}.jsonl`,
e.g. `2026-08-12T21-57-00-032Z_019ff7fa-8c00-7250-a43b-f07eb0bbd133.jsonl`. `sessionId` is a **UUIDv7**,
so both the filename and the id sort chronologically.

**Store census on this host, before the probe (measured):** 6 directories, **1** session file total
(`--home-<user>-Projects-IntentTrace--`, 783 lines, 3,423,595 bytes, 2026-08-05→06); the other five
directories (`--home-<user>--`, `…-kernel-agent-gpu--`, `…-kobon--`, `…-wavel--`, and later the probe dir)
held **0** files. After the probe: 4 files. Date range across the whole store: 2026-08-05 … 2026-08-12.
`~/.pi/backups/` holds 4 unrelated `.tar.gz` config backups.

**Newest session, one line:**

```bash
ls -1t ~/.pi/agent/sessions/*/*.jsonl | head -1
# scoped to one project:
ls -1t ~/.pi/agent/sessions/--$(pwd | sed 's|^/||; s|[/:]|-|g')--/*.jsonl | head -1
```

Because the filename starts with an ISO timestamp, plain lexicographic sort works too, and is
immune to `cp`-clobbered mtimes.

**Record types.** Header `SessionHeader` (`type:"session"`, no `id`/`parentId` — it is not a tree node),
then entries extending `SessionEntryBase {type, id, parentId, timestamp}`
(`dist/core/session-manager.d.ts:5-107`): `message`, `model_change`, `thinking_level_change`,
`compaction`, `branch_summary`, `custom`, `custom_message`, `label`, `session_info`.
`CURRENT_SESSION_VERSION = 3`.

Measured `type` histogram of the pre-existing 783-line real session:
`message` 780, `session` 1, `model_change` 1, `thinking_level_change` 1.

### How a consumer obtains a trace

1. **Read the files.** `~/.pi/agent/sessions/**/*.jsonl`, append-only, written live during the run —
   no export step needed, no lock to respect for reading. Override roots with
   `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, or `--session-dir <dir>`; a purpose-built
   capture can therefore isolate a run into its own tree.
2. **Live stream.** `pi --mode json "<prompt>"` emits the event stream to stdout as JSON lines
   (`docs/json.md:1-7`); documented filter idiom `… | jq -c 'select(.type == "message_end")'`
   (`docs/json.md:90`). Event catalogue in `docs/rpc.md:841-888`. Note the stream is _not_ identical
   to the file: it adds `agent_start`/`turn_*`/`message_update`/`agent_end`/`agent_settled` and omits
   `id`/`parentId`.
3. **RPC.** `pi --mode rpc` — bidirectional JSON protocol over stdin/stdout (`docs/rpc.md`), the
   route for a supervising process that wants to both drive and observe.
4. **Export commands.** `/export [file]` exports the session to **HTML or JSONL**; `pi --export <in> [out]`
   does HTML non-interactively; `/import <file>` reads a JSONL back; `/share` uploads as a private
   GitHub gist. The JSONL export (`agent-session.js:2609-2632`) **flattens the branch tree**: it
   re-chains `parentId` into a linear sequence and emits only the active branch.
5. **SDK.** `import { SessionManager } from "@earendil-works/pi-coding-agent"` —
   `SessionManager.open(path)`, `.list(cwd)`, `.listAll()`, `.getTree()`, `.getBranch()`
   (`docs/session-format.md:386-431`). `listAll()` is the sanctioned enumerator and already returns
   `parentSessionPath`.
6. **Ecosystem.** `badlogic/pi-share-hf` publishes pi sessions to Hugging Face (README:29-35);
   `badlogicgames/pi-mono` on HF is a public corpus of real pi sessions — a ready-made ingest test set.

## Spawn: parent side

Two distinct realities, both probed live.

### (a) Default install — the spawn is an ordinary `bash` tool call

With no extension, the model has no delegation tool, so it spawned a subagent the only way it
could: by shelling out to another `pi` process. The parent session therefore records a **`bash`
toolCall**, indistinguishable at the schema level from `ls` or `git status`:

```json
{"type":"message","id":"62e8cd05","parentId":"bfe546ad","timestamp":"2026-08-12T21:57:08.356Z",
 "message":{"role":"assistant","content":[
   {"type":"thinking","thinking":"<REDACTED>","thinkingSignature":"<REDACTED>"},
   {"type":"text","text":"No dedicated subagent tool is available, so I'll spawn one as a child `pi` process via bash."},
   {"type":"toolCall","id":"toolu_01JyogQi6faoGidcJKeQUgGW","name":"bash",
    "arguments":{"command":"cd /tmp/pi-spawn-probe && pi -p --mode json --provider \"$PI_PROVIDER\" --model \"$PI_MODEL\" -nt \"Reply with the single word BANANA and nothing else.\" 2>&1 | tail -20","timeout":180}}],
  "api":"anthropic-messages","provider":"sub2api-claude","model":"claude-opus-5",
  "usage":{"input":2,"output":…,"cacheRead":…,"cacheWrite":…,"totalTokens":…,
           "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0},"reasoning":"<REDACTED>"},
  "stopReason":"toolUse","timestamp":1786571824…,"responseId":"msg_…","rawStopReason":"tool_use"}}
```

There is **no** spawn-typed record, no child id field, no agent name field. An ingester can only
recognise this by regex-matching the `bash` command string for `pi ` — which is a heuristic, not a
format feature.

Notably, pi exports its own identity into every `bash` tool environment (captured verbatim in the
first tool result of the probe):

```
PI_CODING_AGENT=true
PI_REASONING_LEVEL=high
PI_SESSION_FILE=~/.pi/agent/sessions/--tmp-pi-spawn-probe--/2026-08-12T21-57-00-032Z_019ff7fa-8c00-7250-a43b-f07eb0bbd133.jsonl
PI_PROVIDER=sub2api-claude
PI_MODEL=claude-opus-5
PI_SESSION_ID=019ff7fa-8c00-7250-a43b-f07eb0bbd133
```

So a child `pi` launched from `bash` _inherits_ `PI_SESSION_ID`/`PI_SESSION_FILE` pointing at its
parent — but the child does **not** read them (it minted a fresh id), and nothing writes them to
disk. This is a live-process link only; it is unrecoverable from the stored trace.

### (b) With the shipped `subagent` extension — a named tool call

Loaded with `-e examples/extensions/subagent/index.ts`, the parent writes a proper tool call:

```json
{"type":"message","id":"b81502c9","parentId":"3f2a7a03","timestamp":"2026-08-12T21:58:31.228Z",
 "message":{"role":"assistant","content":[
   {"type":"toolCall","id":"toolu_01Y75QiXwhmjPjG4QtUq5ZxS","name":"subagent",
    "arguments":{"agent":"worker","agentScope":"project","confirmProjectAgents":false,
                 "task":"Reply with the single word BANANA. Nothing else."}}],
  "api":"anthropic-messages","provider":"sub2api-claude","model":"claude-opus-5",
  "usage":{…},"stopReason":"toolUse","timestamp":1786571909126,"responseId":"msg_…"}}
```

`name:"subagent"` is the extension's own string (`index.ts:462`), not a protocol constant. A
different extension or package would emit a different name.

## Spawn: child side

**Not applicable as a separate on-disk record under the shipped extension, and only accidentally
present without it.** Evidence:

**(b) with the `subagent` extension — the child writes nothing at all.** `runSingleAgent` builds the
child argv at `examples/extensions/subagent/index.ts:294`:

```ts
const args: string[] = ["--mode", "json", "-p", "--no-session"];
```

`--no-session` is "Ephemeral mode (don't save)" (README:575), and it makes `SessionManager` skip file
creation entirely (`session-manager.js:665 if (this.persist) {…}`). Measured: the probe-2 store diff
produced **exactly one new file — the parent's**. Zero child files.

The child's records exist only _inside_ the parent's tool result, in `details.results[0].messages`,
as a bare `AgentMessage[]` with **no session id, no agent id, no parent pointer** — see the join
section below. Extra loss: the extension's stdout reader (`index.ts:342-377`) only keeps
`message_end` and `tool_result_end` events and **silently drops the `session` header event**
(`index.ts:346-349` parses every line, `:351/:373` are the only branches). So even the ephemeral
child id is discarded before it can be recorded.

**(a) without the extension — the child is a normal, unmarked top-level session.** Because the model
did _not_ pass `--no-session`, the child got a full session file, identical in shape to any
human-started run and containing **no reference to its parent**:

```json
{"type":"session","version":3,"id":"019ff7fa-addf-76b1-aa42-a61de0c1d66b","timestamp":"2026-08-12T21:57:08.703Z","cwd":"/tmp/pi-spawn-probe"}
{"type":"model_change","id":"ddb29230","parentId":null,"timestamp":"2026-08-12T21:57:08.724Z","provider":"sub2api-claude","modelId":"claude-opus-5"}
{"type":"thinking_level_change","id":"2f9947be","parentId":"ddb29230","timestamp":"2026-08-12T21:57:08.724Z","thinkingLevel":"high"}
{"type":"message","id":"2c05dca5","parentId":"2f9947be","timestamp":"2026-08-12T21:57:08.732Z","message":{"role":"user","content":[{"type":"text","text":"Reply with the single word BANANA and nothing else."}],"timestamp":1786571828732}}
{"type":"message","id":"dbef2205","parentId":"2c05dca5","timestamp":"2026-08-12T21:57:10.258Z","message":{"role":"assistant","content":[{"type":"text","text":"BANANA"}],"api":"anthropic-messages","provider":"sub2api-claude","model":"claude-opus-5","usage":{"input":2,"output":6,"cacheRead":0,"cacheWrite":1195,"totalTokens":1203,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0},"reasoning":"<REDACTED>"},"stopReason":"stop","timestamp":1786571828748,"responseId":"msg_011CdybsvAKEaygV3Y8rYDY6","rawStopReason":"end_turn"}}
```

The header has an optional field that _could_ have carried the parent — `parentSession?: string`
(`session-manager.d.ts:5-12`) — and it is **absent** here. See next section.

## The link

**There is no field that ties a child agent to a parent agent. This is the headline negative.**

What exists, and why none of it is an agent link:

| candidate                     | what it actually links                                                                                                                                                                                                                                                                                                          | verdict                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `SessionEntryBase.parentId`   | previous _entry_ in the same file (a per-session DAG enabling `/tree` branching)                                                                                                                                                                                                                                                | intra-session only                                                                  |
| `SessionHeader.parentSession` | **path string** to another session **file**; written only by `newSession({parentSession})`, `/fork`, `/clone`, `/tree`-branch (`session-manager.js:657,1104,1264`; `agent-session-runtime.js:157-158,205,236`) and rendered as a session tree in the resume picker (`modes/interactive/components/session-selector.js:164-180`) | **session lineage, not delegation** — and it was `undefined` in both probe children |
| `toolCallId` (`toolu_…`)      | parent `toolCall` ↔ parent `toolResult`                                                                                                                                                                                                                                                                                         | intra-session only                                                                  |
| directory name                | shared `cwd`                                                                                                                                                                                                                                                                                                                    | coincidence; sibling projects collide                                               |
| `PI_SESSION_ID` env           | live process ancestry                                                                                                                                                                                                                                                                                                           | never persisted                                                                     |

**Which field ties the spawn to the exact parent turn:** on the parent side that part _is_ clean —
`message.toolCallId` on the `toolResult` record equals `content[].id` of the `toolCall` in the
preceding assistant record (`toolu_01Y75QiXwhmjPjG4QtUq5ZxS` in probe 2), and `parentId` chains both
into the turn sequence. So "which turn spawned it" is recoverable; "what did it spawn" is not.

**The only recoverable child→parent link, and it is textual.** In case (a) the child's own
`--mode json` stdout — including its `{"type":"session","id":"019ff7fa-addf-…"}` header line — was
captured as the parent's `bash` tool-result **text**. An ingester can parse that string out and join
it against the child's on-disk session file by `id`. That works only because the invocation happened
to use `--mode json` and did not use `--no-session`; both are the model's free choice, not a
guarantee. Under the shipped extension (case b) even this is gone.

`[INFERENCE]` A well-behaved pi _extension_ could produce a real link, because the extension API
exposes `pi.newSession({ parentSession })` (`dist/core/extensions/types.d.ts:260-264`,
`dist/core/agent-session-runtime.js:156-159`), which writes `parentSession: <parent file path>` into
the child header. No shipped code path does this for subagents — the shipped one uses `--no-session`
instead. If IntentTrace wants pi lanes, `parentSession` is the field to lobby for / to populate from
a custom extension.

## Join: how results come back

**Text envelope for the model, structured sidecar for the UI — both in one `toolResult` record.**

The `content[]` the LLM sees is plain text (`"BANANA"`). The full child transcript rides alongside in
`message.details`, which pi persists verbatim to the JSONL. Verbatim, redacted, from probe 2 line 12:

```json
{
  "type": "message",
  "id": "021069ab",
  "parentId": "b81502c9",
  "timestamp": "2026-08-12T21:58:33.176Z",
  "message": {
    "role": "toolResult",
    "toolCallId": "toolu_01Y75QiXwhmjPjG4QtUq5ZxS",
    "toolName": "subagent",
    "content": [{ "type": "text", "text": "BANANA" }],
    "details": {
      "mode": "single",
      "agentScope": "project",
      "projectAgentsDir": "/tmp/pi-spawn-probe/.pi/agents",
      "results": [
        {
          "agent": "worker",
          "agentSource": "project",
          "task": "Reply with the single word BANANA. Nothing else.",
          "exitCode": 0,
          "messages": [
            {
              "role": "user",
              "content": [
                { "type": "text", "text": "Task: Reply with the single word BANANA. Nothing else." }
              ],
              "timestamp": 1786571911616
            },
            {
              "role": "assistant",
              "content": [{ "type": "text", "text": "BANANA" }],
              "api": "anthropic-messages",
              "provider": "sub2api-claude",
              "model": "claude-opus-5",
              "usage": {
                "input": 2,
                "output": 6,
                "cacheRead": 1698,
                "cacheWrite": 1250,
                "totalTokens": 2956,
                "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
                "reasoning": "<REDACTED>"
              },
              "stopReason": "stop",
              "timestamp": 1786571911632,
              "responseId": "msg_011Cdybz2JpQjCri7JNSupqL",
              "rawStopReason": "end_turn"
            }
          ],
          "stderr": "",
          "usage": {
            "input": 2,
            "output": 6,
            "cacheRead": 1698,
            "cacheWrite": 1250,
            "cost": 0,
            "contextTokens": 2956,
            "turns": 1
          },
          "model": "claude-opus-5",
          "stopReason": "stop"
        }
      ]
    }
  }
}
```

This is genuinely rich — nested `messages[]` (including the child's own tool calls, via the
`tool_result_end` branch at `index.ts:373`), per-child `usage`, `exitCode`, `stderr`, `stopReason`,
the agent's `name`+`source`, and `mode: "single" | …` for parallel/chained batches
(`MAX_PARALLEL_TASKS = 8`, `MAX_CONCURRENCY = 4`, `index.ts:33-34`). It is also **entirely
extension-defined**: `details` is an opaque `T` in the core schema
(`session-manager.d.ts:42,53,101`), so the shape above is a contract with
`examples/extensions/subagent`, version 0.84.1, and nothing else.

In case (a), the join is the raw stdout of the child process pasted into the `bash` tool result as
text (the parent's own final answer then quoted the child's id from it).

## Agent-to-agent messages

**Not applicable — the format has no concept of a message with a sender and a recipient.**

Evidence: the message roles in the union are `user`, `assistant`, `toolResult`, plus the
coding-agent extensions `BashExecutionMessage` / `CustomMessage`
(`docs/session-format.md:72-172`). No `from`/`to`/`sender`/`recipient` field exists on any entry
type in `session-manager.d.ts:5-107`. Communication is strictly a tree of parent→child _task
strings_ and child→parent _result strings_; there is no sibling channel, no broadcast, no mailbox.

`CustomMessageEntry {customType, content, details, display}` is the only escape hatch: an extension
could encode peer messages there, and pi would persist and re-inject them. Nothing shipped does.
`[INFERENCE]` an IntentTrace pi adapter should not look for peer edges; it should treat every pi
trace as a strict tree at best.

## Nesting and identity

- **Depth:** unbounded in principle — a subagent is a full `pi` process, and a subagent's own tools
  include `bash`/extensions, so it can spawn again. `[INFERENCE]` unbounded, not exercised: the probe
  used depth 1 by design (constraint: two spawns maximum). Depth is _invisible_ on disk regardless,
  since nothing records ancestry.
- **Id schemes:**
  - `session.id` — **UUIDv7** (`019ff7fa-8c00-7250-…`, `019ff7fb-d07d-…`; the `019ff7f*` prefix is a
    millisecond timestamp). Validated by `assertValidSessionId` (`session-manager.d.ts:141`).
    Lexicographically **time-sortable**. Unique per process.
  - `entry.id` — 8 hex chars (`45dddddc`, `be53de09`). Random, **not** time-sortable, unique only
    within a file. Ordering comes from `parentId` chaining and the `timestamp` field.
  - `toolCallId` — provider-issued (`toolu_…` for Anthropic). Format varies by provider.
  - Agent _name_ — `worker`/`reviewer`/`scout`/`planner`, from the frontmatter `name:` of a markdown
    file; not unique across concurrent invocations of the same agent.
- **Timestamps:** every entry has an RFC3339 `timestamp` with `Z`; messages carry a second epoch-ms
  `message.timestamp`. Both present in all probe records.
- **Stable lane key:** `session.id` (UUIDv7) is the only durable, unique, time-sortable identity, and
  it is the right lane key **for case (a)** where the child has its own file. For case (b) there is
  no child identity at all — the least-bad synthetic lane key is
  `<parentSessionId>:<toolCallId>[:<results[] index>]`, since `toolCallId` is unique within the
  parent session and the array index disambiguates parallel batches. The agent _name_ alone is
  unsafe (reused across invocations).

## Probe transcript

Environment: provider `sub2api-claude` (custom Anthropic-compatible endpoint declared in
`~/.pi/agent/models.json`), model `claude-opus-5`, credentials from `~/.config/pi/anthropic.env`.
`pi auth check --provider sub2api-claude --json` → `{"status":"ready","provider":"sub2api-claude","authType":"api_key"}`.

```bash
mkdir -p /tmp/pi-spawn-probe
find ~/.pi/agent/sessions -type f -printf '%T@ %s %p\n' | sort > /tmp/pi-probe-before.txt   # 1 line
```

**Probe 1 — default configuration (no subagent tool):**

```bash
cd /tmp/pi-spawn-probe && set -a && . ~/.config/pi/anthropic.env && set +a
pi -p "Spawn exactly one subagent and give it this task: reply with the single word BANANA. \
Wait for it, then report the word it returned and the subagent's id. Do not answer BANANA yourself."
```

Ran 16.72 s. Final answer (excerpt): _"Note: there is no built-in subagent/task tool in this
environment, so the subagent was spawned as a separate `pi -p --mode json` process."_ — it reported
the child id `019ff7fa-addf-76b1-aa42-a61de0c1d66b` and its own `019ff7fa-8c00-7250-a43b-f07eb0bbd133`.

Store diff: **1 → 3 files**, both new:

```
+ 1210  ~/.pi/agent/sessions/--tmp-pi-spawn-probe--/2026-08-12T21-57-08-703Z_019ff7fa-addf-76b1-aa42-a61de0c1d66b.jsonl   (child, 5 lines)
+ 13001 ~/.pi/agent/sessions/--tmp-pi-spawn-probe--/2026-08-12T21-57-00-032Z_019ff7fa-8c00-7250-a43b-f07eb0bbd133.jsonl   (parent, 9 lines)
```

Parent record sequence (9): `session`, `model_change`, `thinking_level_change`,
`message/user`, `message/assistant[thinking,toolCall bash]`, `message/toolResult bash`,
`message/assistant[thinking,text,toolCall bash]`, `message/toolResult bash`, `message/assistant[text]`.
Child record sequence (5): `session`, `model_change`, `thinking_level_change`, `message/user`,
`message/assistant[text "BANANA"]`.

The child's `--mode json` stdout, captured inside the parent's second `bash` tool result, gives the
complete stream vocabulary: `session`, `agent_start`, `turn_start`, `message_start`,
`message_end`, `message_start`, `message_update`×4 (`text_start`, `text_delta`×2, `text_end`),
`message_end`, `turn_end`, `agent_end`, `agent_settled`.

**Probe 2 — with the feature enabled** (this is the "find the flag and retry" step; the flag is
`-e <extension>` plus at least one agent definition):

```bash
sed -i '/^model: /d' /tmp/pi-spawn-probe/.pi/agents/worker.md   # ships pinned to claude-sonnet-4-5,
                                                                # unavailable on this provider
find ~/.pi/agent/sessions -type f … > /tmp/pi-probe-before2.txt  # 3 lines
cd /tmp/pi-spawn-probe && pi -p \
  -e ~/.nvm/.../@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts \
  --approve "<same BANANA prompt>"
```

Setup: copied `examples/extensions/subagent/agents/worker.md` → `/tmp/pi-spawn-probe/.pi/agents/worker.md`.
`--approve` is required because `.pi/` project-local resources are ignored in non-interactive mode
until the project is trusted (`docs/security.md:29`).

Ran 16.28 s. Final answer (excerpt): _"**Subagent id:** not available. The `subagent` tool returned
only the raw text `BANANA` with no id/handle in its result…"_

Store diff: **3 → 4 files**, exactly one new — the parent:

```
+ 11487 ~/.pi/agent/sessions/--tmp-pi-spawn-probe--/2026-08-12T21-58-23-101Z_019ff7fb-d07d-7a8e-8c06-d94748724f41.jsonl   (15 lines)
```

Parent tool sequence: `bash`(ls agents dir, exit 2) → `bash`(ls `~/.pi`) → `read`(`.pi/agents/worker.md`)
→ **`subagent`**`{agent:"worker",agentScope:"project",task:"Reply with the single word BANANA. Nothing else."}`
→ result `"BANANA"` + `details` → `bash`(looked for a child session dir; none exists).

Session ids produced: parent-1 `019ff7fa-8c00-7250-a43b-f07eb0bbd133`, child-1
`019ff7fa-addf-76b1-aa42-a61de0c1d66b`, parent-2 `019ff7fb-d07d-7a8e-8c06-d94748724f41`.
Two spawns total, as constrained. No pre-existing session was modified (byte sizes and mtimes of the
2026-08-05 file unchanged across both diffs).

## Gaps and traps

1. **Do not expect a delegation record; there is none by default.** Any pi adapter that scans for a
   spawn tool will find nothing in 100 % of default-configuration traces. That is correct behaviour,
   not a parsing bug.
2. **`parentSession` means "forked from", not "spawned by".** It is a _file path_, not an id, and it
   is populated by `/fork`, `/clone`, `/tree` and `newSession()`. An ingester that renders it as an
   agent-parent edge will draw a false hierarchy out of a user pressing `/fork`. Also, being a path,
   it breaks if the store is moved or the session dir is overridden — join on it defensively.
3. **The subagent child is ephemeral by construction.** `--no-session` at
   `examples/extensions/subagent/index.ts:294` means the child transcript exists _only_ inside the
   parent's `toolResult.details.results[].messages`. There is no second file to correlate, no id, and
   no timestamped `session` header — only epoch-ms `timestamp`s on the embedded messages. Reconstructing
   a child lane means synthesising an identity.
4. **`details` is unversioned, extension-private, opaque.** `details?: T` in the core types. The
   `{mode, agentScope, projectAgentsDir, results[]}` shape is one example extension at one version;
   a user's own or a third-party pi package will emit something completely different under a
   different `toolName`. Sniff on `toolName` + shape, never assume.
5. **The bash-spawn path is unrecognisable without heuristics** and depends on model whim: whether
   `--mode json` was used, whether `--no-session` was passed, whether output was `tail`-truncated
   (the probe's own command ended in `| tail -20`, which happened to keep the whole child stream but
   would silently decapitate a longer one and destroy the `session` header line).
6. **Sessions are trees, not logs.** `parentId` branching is in-place: a single file can contain
   several mutually exclusive conversation paths, and a naive line-order read will interleave
   abandoned branches with live ones. Use the leaf and walk to root (`buildContextEntries()` semantics),
   and honour `compaction.firstKeptEntryId` — after a compaction, earlier entries are still in the
   file but are no longer part of the context.
7. **`compaction` and `branch_summary` rewrite meaning, not bytes.** Anything derived from "all
   messages in the file" will double-count summarised content.
8. **The directory name is lossy** (`/`→`-`); always take `cwd` from the header. Note also that the
   header is the only entry without `id`/`parentId` — a parser that assumes `SessionEntryBase` on
   every line crashes on line 1.
9. **Version drift.** `CURRENT_SESSION_VERSION = 3` and old files may carry a different `version`
   (there is a `migrateSessionEntries` path, `session-manager.d.ts:143`). The example subagent
   extension is _not_ API-stable — it is sample code under `examples/`, upgraded with the package and
   free to change. Pin behaviour to the observed `version` and to `pi --version`.
10. **Nothing records the enabled toolset.** The trace does not say which extensions were loaded, so
    the absence of a `subagent` call cannot be distinguished from the tool never having been
    available. The only in-band hint is `model_change`/`thinking_level_change`, which say nothing
    about tools.
11. **Redaction burden:** `message.content[].type === "thinking"` carries raw chain-of-thought plus a
    `thinkingSignature`, and `usage.reasoning` is present on every assistant message. The probe's
    parent sessions contain both. Any pi ingester must strip these before storage.
