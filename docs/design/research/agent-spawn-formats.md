---
status: current
owner: maintainers
last_reviewed: 2026-08-12
normative: false
milestone: Gate 5
---

# 六个 Agent Harness 的 spawn 记录格式

本文回答两个问题：**每个 harness 是怎么 spawn 子 agent 的**，以及**这种 trace 怎么获取**。对象是 Codex、Claude Code、opencode、omp、pi、Grok Build 六个 CLI。

结论先行：**六个里有五个都以一等字段记录了 spawn 关系，只有 pi 没有 spawn 能力**。IntentTrace 之所以把并行 agent 画成一条链，不是因为数据里没有结构，而是因为 adapter 只读一个文件并把整个 session 压成单一 agent 泳道（`packages/adapters/src/claude.ts:267`、`packages/adapters/src/codex.ts:306`、`packages/adapters/src/common.ts:112`）。

## 证据与方法

全部数据在 2026-08-12 于本机实测。六个 harness 各跑一次 **live probe**：快照 session store → 用强制派发的提示词非交互运行 → diff store → 逐条 dump 父子两侧记录。

这个方法是被一次错误逼出来的。此前对 Codex 的调查扫了 993 个历史 rollout，结论是"父侧不记录 spawn，父 turn 归因只能靠时间窗猜"。**那是错的**：语料里从来没人用过 multi-agent 功能。开启后跑一次，父侧立刻出现 `function_call name="spawn_agent"` 和带子 thread id 的 `sub_agent_activity`。

> 历史语料只能证明"没用过"，不能证明"格式不支持"。判断一个格式的能力，必须实跑。

各 harness 版本与探针结果：

| harness     | 版本                                     | 子 agent 默认 | 探针结果                              |
| ----------- | ---------------------------------------- | ------------- | ------------------------------------- |
| Codex       | `codex-cli 0.147.0`                      | **关**，需开  | 1 spawn，父子各一个 rollout           |
| Claude Code | `2.1.228`                                | 开            | 2 spawn，各产生 root + subagents 目录 |
| opencode    | `1.18.16`                                | 开            | 2 spawn，SQLite 各 +2 session         |
| omp         | `17.2.15`                                | 开            | 2 probe（1 spawn + 2 spawn 互发消息） |
| pi          | `@earendil-works/pi-coding-agent 0.84.1` | **无此能力**  | 2 probe，确认无 delegation 工具       |
| Grok Build  | `grok 1.0.3 (1a29d5bc12)`                | 开            | 认证过期，改用 168 条历史 spawn 复核  |

## 速查表

### spawn 关系记在哪一侧

| harness     | 父侧 spawn 记录                                                         | 子侧 parent 指针                                      | 父 turn 精确归因                            |
| ----------- | ----------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------- |
| Codex       | `function_call spawn_agent` + `event_msg sub_agent_activity`（带子 id） | `session_meta.parent_thread_id`                       | `sub_agent_activity.event_id == call_id` ✅ |
| Claude Code | `tool_use name="Agent"`（**不含子 id**）                                | `agent-<id>.meta.json` 的 `toolUseId`/`parentAgentId` | `meta.toolUseId == tool_use.id` ✅          |
| opencode    | `part.data.state.metadata.sessionId`                                    | `session.parent_id`                                   | `part.message_id` + `data.callID` ✅        |
| omp         | 只有 agent **名字**（`details.progress[].id`）                          | **无**                                                | `toolCallId` 三方联接（但不传给子）⚠        |
| pi          | 不适用                                                                  | 不适用                                                | 不适用                                      |
| Grok Build  | `_x.ai/session/update` 的 `subagent_spawned`（带 `child_session_id`）   | **无**                                                | `parent_prompt_id`，仅 53/168 有 ⚠          |

### 结果如何回流与 agent 间通信

| harness     | join 形态                                         | 结构化程度             | agent↔agent 消息                          |
| ----------- | ------------------------------------------------- | ---------------------- | ----------------------------------------- |
| Codex       | `agent_message{author, recipient}` + 文本信封     | 高（字段化收发方）     | **有，含兄弟互发**：实测 1341 条同级消息  |
| Claude Code | 同步 `tool_result` + `toolUseResult`；异步纯文本  | 同步高 / 异步低        | 半有：`SendMessage.to` 有，收方无 sender  |
| opencode    | `part.data.state.output` 文本信封                 | 低（纯文本）           | **无**：只有 user/assistant 两种 role     |
| omp         | `async-result` / `hub` 的 `details.jobs[]` + 文本 | 中（元数据有，结果无） | **有**：`hub` DM，`details.waited` 最完整 |
| pi          | 不适用                                            | —                      | 无                                        |
| Grok Build  | `subagent_finished` + `output.json`               | **最高**（全字段）     | **无**：只有向下派发、向上回一个结果      |

### 泳道键（lane key）——最容易搞错的一项

| harness     | 用这个                       | 绝不能用                                       |
| ----------- | ---------------------------- | ---------------------------------------------- |
| Codex       | `session_meta.payload.id`    | `session_id`（子记录里它是**父**的 id）        |
| Claude Code | `agentId`（100% 覆盖子记录） | `sessionId`（父子共用同一值）                  |
| opencode    | `session.id`                 | `session.agent`（是类型不是实例）、`title`     |
| omp         | agent **名字**（文件名）     | 子 session UUID（无处被引用）                  |
| pi          | `session.id`（UUIDv7）       | —                                              |
| Grok Build  | `resumed_from` 链的**根**    | `child_session_id`（168 个 id 实为 64 条线程） |

Codex 与 Claude Code 的坑同源，也正是 IntentTrace 现在的 bug：**子记录里的 session id 是父的**，用它做泳道键会把所有 agent 合并成一条。

---

## Codex CLI

### 启用与版本

`codex-cli 0.147.0`。子 agent **默认关闭**，由 `~/.codex/config.toml` 打开：

```toml
[features]
multi_agent = true

[agents]
max_threads = 8   # 模型看到的是 max_threads + 1 个并发槽
max_depth = 1     # 非追溯、非全局不变量：本机实测 depth 最深到 5
```

第二个开关决定**记录格式**：`session_meta.payload.history_mode` ∈ `legacy`（默认）| `paginated`。这是对 ingester 最危险的变量，见陷阱 3。

### trace 位置

```
~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<local-time>-<thread-uuid>.jsonl
```

本机 997 个 rollout、3,455,710 条记录、4.7 GB。每行一个 JSON：`{timestamp, ordinal?, type, payload}`。`type` ∈ `session_meta` | `response_item` | `event_msg` | `turn_context` | `world_state` | `compacted` | `inter_agent_communication_metadata`。

两个路径陷阱：目录与文件名是**本地时间**而 `timestamp` 是 UTC；"最新文件"是父不是子（父比子晚结束）。`~/.codex/session_index.jsonl` 只覆盖 36/997 且无父子信息，不能用于发现。

### 父侧

一次 spawn 写三条记录加一条 `world_state` 增量：

```json
{"type":"response_item","payload":{
  "type":"function_call","name":"spawn_agent","namespace":"collaboration",
  "call_id":"call_eQoK6VDFkXnMBOfDuteRxhAg",
  "arguments":"{\"task_name\":\"banana_reply\",\"fork_turns\":\"none\",\"message\":\"gAAAAA…\"}",
  "internal_chat_message_metadata_passthrough":{"turn_id":"019ff6d2-8e3f-…"}}}

{"type":"event_msg","payload":{
  "type":"sub_agent_activity","event_id":"call_eQoK6VDFkXnMBOfDuteRxhAg",
  "agent_thread_id":"019ff6d2-acd9-7c91-89eb-2a73dd7467e9",
  "agent_path":"/root/banana_reply","kind":"started"}}

{"type":"response_item","payload":{
  "type":"function_call_output","call_id":"call_eQoK6VDFkXnMBOfDuteRxhAg",
  "output":"{\"task_name\":\"/root/banana_reply\"}"}}
```

`message` 是**密文**：1113/1113 `spawn_agent`、7525/7525 `send_message`、622/622 `followup_task` 全部以 `gAAAAA` 开头，零明文，密钥在服务端。完整工具面：`spawn_agent`、`send_message`、`followup_task`、`wait_agent`（无 target，等整个池）、`list_agents`（只给路径与状态，**无 UUID**）、`interrupt_agent`。

`fork_turns` ∈ `none` | `all`（默认）| 正整数字符串。实测 `all` 899、`3` 110、`none` 49。

### 子侧

```json
{
  "type": "session_meta",
  "payload": {
    "session_id": "019ff6d2-88ce-…", // ← 父的 id
    "id": "019ff6d2-acd9-…", // ← 自己的 id
    "parent_thread_id": "019ff6d2-88ce-…",
    "source": {
      "subagent": {
        "thread_spawn": {
          "parent_thread_id": "019ff6d2-88ce-…",
          "depth": 1,
          "agent_path": "/root/banana_reply",
          "agent_nickname": "Einstein",
          "agent_role": null
        }
      }
    },
    "thread_source": "subagent",
    "history_mode": "legacy",
    "multi_agent_version": "v2"
  }
}
```

### 链接

三条，可靠性递减：

1. `parent_thread_id`（789/997 rollout 携带，179 个父 id 全部可解析，零悬挂）。
2. `sub_agent_activity.event_id == function_call.call_id`，且该记录携带子 UUID。**这是父侧唯一同时出现子 UUID 与 call_id 的地方**——扫 177 个 v2 子 agent，子 UUID 在父文件中只出现在这一种记录里（175 命中，2 个完全缺失）。上游 `rollout/src/policy.rs::should_persist_event_msg` 只在 `history_mode == Legacy` 时落盘它。
3. 密文内容联接：父 `function_call.arguments.message` 与子 `agent_message.content[1].encrypted_content` **逐字节相同**（实测 164 字符），无需解密即可配对，且在 `sub_agent_activity` 缺失时仍然有效。

### join 与 agent 间消息

结果以 `response_item.agent_message` 回流，`author`/`recipient` 是一等字段，正文是 `Message Type: FINAL_ANSWER|NEW_TASK|MESSAGE` 信封。9766 条消息中：`MESSAGE` 7459、`NEW_TASK` 1226（均密文）、`FINAL_ANSWER` 1081（**明文**）。

> 结果可读，指令永远不可读。不要设计"展示子 agent prompt"的 UI。

方向分布：child→parent 4921、parent→child 3504、**同级兄弟 1341**。消息同时写进收发双方的 rollout，不按 `(author, recipient, encrypted_content)` 去重会双计。

没有完成事件：`sub_agent_activity.kind` 只有 `started` | `interacted` | `interrupted`，子完成只能由 `FINAL_ANSWER` 到达或子自身的 `task_complete` 观察。

### 陷阱

1. **fork 复制炸弹**。`fork_turns: "all"` 把父的整个 rollout 抄进子文件，并把每行时间戳**重盖为 fork 时刻**（实测一个文件 132 条记录同一毫秒）。全库 3,455,710 条里 3,220,520 条（93%）是这种副本。修法是内容寻址：按 `forked_from_id` 读祖先、对 payload 做哈希去重（实测 7683/7683 精确命中）。
2. **fork ≠ spawn**。`parent_thread_id` 才是派发；`forked_from_id` 只表示历史被复制。交叉表：两者都有 683（值恒等）、只有 parent 106、**只有 forked 1**（那是人类会话分叉，不是派发）。
3. **`legacy` vs `paginated`**。paginated 模式下 `sub_agent_activity` 不落盘，改为 `event_msg.item_completed` 包 `TurnItem`。本机已有 8 个 paginated 文件（7 个是 0.147.0，最新与探针同日）。
4. **`collab_agent_*` 事件永不落盘**。上游 `policy.rs` 把十个 `CollabAgentSpawnBegin/End` 等**无条件**列入非持久事件，实测 997 文件零命中。别等 `CollabAgentSpawnEndEvent.new_thread_id`。
5. **v1/v2 版本墙**。v1（0.141.0–0.143.0，namespace `multi_agent_v1`）的 spawn **明文**，且输出直接给出 `{"agent_id":"<child uuid>","nickname":"Nash"}`；v2（0.144.1–0.147.0，namespace `collaboration`）改为密文 + 路径，UUID 只剩 `sub_agent_activity`。切换发生在 0.144.x，2026-07-09 与 07-10 之间。**v1 反而更好 ingest。**

---

## Claude Code

### 启用与版本

`2.1.228`。**默认开启，无 flag 无配置项**。探针两次都首发即 spawn。13 个 agent 类型在握手时注册（3 个内置 + 8 个 `~/.claude/agents/` 用户文件），不是封闭集合。

### trace 位置

```
~/.claude/projects/<cwd-slug>/
├── <rootSessionId>.jsonl                 # 父/根
└── <rootSessionId>/subagents/
    ├── agent-<agentId>.jsonl             # 子 transcript
    ├── agent-<agentId>.meta.json         # ← 唯一存放父链接的地方
    └── workflows/wf_<id>/…               # 第三类，无 toolUseId
```

本机 174 个 root session、157 个 sidecar、10803 条子记录。注意 `<rootSessionId>` 既是文件名又是同级目录名。`/tmp/claude-<uid>/…/tasks/<agentId>.output` 是**指向 store 的软链**，跟着它走会双计。

### 父侧

```json
{
  "parentUuid": "e49bcd8c-…",
  "isSidechain": false,
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_01DAjDwYd9kHwNGKp777RZCt",
        "name": "Agent",
        "input": {
          "description": "Reply with one word",
          "prompt": "…",
          "subagent_type": "general-purpose",
          "run_in_background": false
        }
      }
    ]
  },
  "uuid": "467ecbd1-…",
  "sessionId": "232430eb-…",
  "version": "2.1.228"
}
```

**这条记录不含子 `agentId`**，唯一句柄是 `toolu_…`。工具名是 **`Agent`**——握手 `init.tools` 声明的是 `Task`，但 46/46 条实际记录都是 `Agent`，按 `Task` 匹配一无所获。

### 子侧

sidecar 完整 127 字节：

```json
{
  "agentType": "general-purpose",
  "description": "Reply with one word",
  "toolUseId": "toolu_01DAjDwYd9kHwNGKp777RZCt",
  "spawnDepth": 1
}
```

子 transcript 首条 `parentUuid` 为 **null**，`isSidechain: true`（父文件里零出现），`agentId` 在 10803/10803 条子记录上都有，而 `sessionId` 是**根**的 id。

### 链接与 join

`meta.toolUseId == 父 tool_use.id` 是 spawn 边；`meta.parentAgentId` 仅在 `spawnDepth > 1` 时出现（157 个里 2 个）。**157 个 sidecar 里 109 个（`workflows/wf_*`）没有 `toolUseId`，与父 turn 永久无法关联。**

同步 join 是 `tool_result` + 结构化 `toolUseResult{agentId, agentType, status, totalDurationMs, totalTokens}`。异步 join 是纯文本 `<task-notification>`，靠 `origin.kind == "task-notification"` 识别；同一信封会在 `queue-operation`（enqueue + remove）与 `attachment{queued_command}` 里重复出现，一次 join 最多被数到 **4 次**；它也覆盖后台 bash（`b` 前缀 id，不是 agentId）。异步启动回执带结构化 `toolUseResult{isAsync, status:"async_launched", agentId}`。

### stream-json 比磁盘更富

`--output-format stream-json` 额外发出三条磁盘上不存在的记录：

```json
{"type":"system","subtype":"task_started","task_id":"aa2df15cf06a92b22",
 "tool_use_id":"toolu_01DAj…","subagent_type":"general-purpose","task_type":"local_agent"}
{"type":"system","subtype":"task_updated","task_id":"…","patch":{"status":"completed","end_time":1786571762421}}
{"type":"system","subtype":"task_notification","task_id":"…","output_file":"…","summary":"BANANA","usage":{…}}
```

`task_started` 在 **spawn 时刻**同时给出 `task_id`（子 agentId）与 `tool_use_id`——正是磁盘父文件缺的那条结构化边；`task_type` 还能干净区分 `local_agent` 与 `local_bash`。流与磁盘可按记录 `uuid` 精确联接。`--forward-subagent-text` 只影响是否转发子的 assistant 文本，三条 `task_*` 是无条件的。

### 陷阱

- 子 `sessionId` 是父的 → 用它做键就是当前的扁平化 bug。用 `agentId`。
- `parentUuid` 链不跨文件，纯靠它建树会得到 N 个互不相连的森林。
- `meta.json` 不是 `.jsonl`，`**/*.jsonl` 通配会漏掉这个承重文件。
- 同一 `<task-id>` 可能**多次**通知（agent 被 `SendMessage` 唤醒续跑），join 与 spawn 不是 1:1。
- root 文件不是消息流：`queue-operation`、`ai-title`、`last-prompt` 等记录**没有 uuid，有时没有 timestamp**，探针父文件第一行就是 `queue-operation`。
- `message.content` 是 `string | Array<block>`，两种形态在同一次探针里都出现。
- `thinking` 块带 `signature` 明文存盘，未在静态时脱敏，必须显式丢弃。
- 本机 52/174 个 root 文件因目录属主问题不可读；ingester 要能跳过而不是中止。

---

## opencode

### 启用与版本

`1.18.16`，**默认开启**，`task` 是无条件注册的内置工具。真正的开关是 `permission.task`（pattern 匹配的是 `subagent_type`）、`agent.<name>.mode` ∈ `subagent|primary|all`、`subagent_depth`（默认 1）、以及后台子 agent 所需的 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`。

### trace 位置

```
~/.local/share/opencode/opencode.db      # SQLite + WAL，全部数据在这里
~/.local/share/opencode/storage/migration # 内容为 "2"：旧的一文件一记录布局已废弃
~/.local/share/opencode/tool-output/tool_<id>  # 被截断的工具输出溢出体
```

表：`session`（含 `parent_id`）、`message`、`part`、`event`/`event_sequence`。**WAL 不可忽略**——探针时有 4.3 MB 未 checkpoint，只拷 `.db` 会丢掉最近的 session。

### 父侧、子侧与链接

父侧只有一行：`part` 表里 `data.tool == "task"` 的记录。

```json
{"type":"tool","tool":"task","callID":"call_WkKROqMfgu0NQCmwrPEQpxiL",
 "state":{"status":"completed",
  "input":{"description":"Return required word","prompt":"…","subagent_type":"general"},
  "output":"<task id=\"ses_008059773ffenwuq9PQN3wdajn\" state=\"completed\">\n<task_result>\nBANANA\n</task_result>\n</task>",
  "metadata":{"parentSessionId":"ses_00805b0c…","sessionId":"ses_008059773ffe…",
              "model":{…},"truncated":false},
  "time":{"start":1786571810962,"end":1786571812330}}}
```

子侧是一行**完整的 `session`**，与顶层 session 无异，只多一个 `parent_id`；`title` 被生成为 `<description> (@<agent> subagent)`，`agent` 存子 agent 类型，`permission` 列尾部被塞进 `{"permission":"task","pattern":"*","action":"deny"}`。

链接链条：`session.parent_id`（子→父，权威）+ `part.data.state.metadata.sessionId`（父→子）+ `part.message_id`（精确到父的哪条 assistant 消息）+ `data.callID`（provider 级 tool-call id）。上游 `packages/opencode/src/tool/task.ts` 的 `TaskTool`、`packages/schema/src/v1/session.ts:550` 的 `SessionInfo.parentID` 均已核对。

### join

纯文本信封，无结构化结果字段。当前形态（`renderOutput()`）：

```
<task id="ses_…" state="completed">\n<task_result>\nBANANA\n</task_result>\n</task>
```

`state` ∈ `running` | `completed` | `error`（error 时标签变成 `task_error`）。正文只取子的**最后一个 text part**——子实际做的一切都被丢掉，必须顺 `parent_id` 进子 session 才看得到。

### 陷阱

1. **同一个数据库里并存两种 join 信封**，唯一判别是 `session.version`：29 条旧格式 `task_id: ses_… (for resuming…)`（1.2.21）、2 条新格式 `<task id=…>`（1.18.16）。共用的只有 `<task_result>` 正则。
2. `state.metadata.parentSessionId` 是新字段（34 条里只有 2 条），别依赖它。
3. 截断会**吞掉闭合标签**：`truncated: true` 的那条 51,544 字节输出没有 `</task_result>`，要求闭合标签的正则会静默丢结果。
4. 失败的 spawn 可能**完全没有子 id**：34 条 task part 里 3 条 `status=error`，其中一条连 `state.metadata` 都没有。
5. `part` 行是原地更新的，生命周期只在 `event` 表里；`event` 只覆盖 61 个 session 中的 10 个，只能当加速器不能当唯一来源。
6. `ses_` 前缀**字典序倒序**（61 个全部验证），`ORDER BY id` 会把时间线整个反过来；`msg_` 正序，`prt_` 仅在同一 message 内正序。
7. `task_id` 参数可复用既有子 session：两次不同的 spawn 调用可以指向同一个子，**子 session 与 spawn 调用不是 1:1**。
8. **不存在 agent 间消息**：schema 只有 `user`/`assistant` 两种 role（实测 1455 条消息），12 种用过的工具里没有任何寻址其它 agent 的原语，`AgentPart` 只是人类消息里的 `@mention` 片段。
9. 嵌套默认不通，且 `subagent_depth` 单独调大**不够**：实测配 `{"subagent_depth": 2}` 后孙子仍未创建，因为 `deriveSubagentSessionPermission()` 把 `task/deny` 烤进了子 session 行。

---

## omp（Oh My Pi）

### 启用与版本

`omp/17.2.15`，**默认开启且默认记录**（除非 `--no-session`）。影响记录形态的设置：`task.batch`（默认开，一次调用 `{context, tasks[]}` 可 spawn N 个）、`async.enabled`（默认开，`task` 结果是**回执**不是结果）、`task.maxRecursionDepth`、`task.agentIdleTtlMs`（默认 420000）。

### trace 位置

```
~/.omp/agent/sessions/<bucket>/
├── <ts>_<sessionId>.jsonl              # 父
└── <ts>_<sessionId>/
    ├── <AgentName>.jsonl               # 子的完整 session
    ├── <AgentName>.md                  # 子的最终产物
    ├── <AgentName>/<AgentName>.<Child>.jsonl   # 深度 2，点号限定
    ├── local/                          # local:// 共享产物
    └── <n>.<tool>.log                  # 溢出的工具输出 → artifact://<n>
```

**第一物理行是 256 字节定宽的 `title` 填充槽**，第二行才是 session 头。记录信封 `{type, id, parentId, timestamp}`；`type` ∈ `message`（含 `role: "toolResult"`）、`custom`（含 `customType: "tool_execution_start"`）、`custom_message`、`session`、`session_init`、`model_change` 等。

### 父侧

三条记录：assistant 的 `toolCall name="task"`（参数 `{context, i, tasks[]}`）、`custom/tool_execution_start`、`toolResult`。回执关键字段：

```json
"details":{"async":{"state":"running","jobId":"BananaResponder","type":"task"},
 "progress":[{"index":0,"id":"BananaResponder","agent":"sonic","agentSource":"bundled",
   "modelRole":"smol","status":"pending","task":"…","assignment":"…"}],
 "results":[]}
```

**机器可读的子身份是 agent 名字**（`details.progress[].id` / `details.async.jobId`），不是 session id。

### 子侧与链接

子文件的 `session` 头只有 `{type, version, id, timestamp, cwd}`——**没有 parentSession、没有 agent 名、没有父 id、没有 job id**。`omp://session.md` 文档化的 `parentSession` 字段在全机 session 里 **0 次出现**（它只由 `/fork` 写）。子唯一提到自己 id 的地方是 `session_init.systemPrompt` 里的英文散文（`Your id is \`BananaResponder\``），并把父称作字面量 `Main`。

> **链接就是文件名。** 实测：8 个子的 session UUID 在父文件中出现 1/8 次，而那一次是某 scout 读了自己的 JSONL 导致文件内容落进父的 tool result——是巧合内容，不是链接。clean-room 探针复核：0/2。

父侧内部由 `toolCallId` 三方联接（assistant `toolCall.id` = `tool_execution_start.data.toolCallId` = `toolResult.toolCallId`），但**这个 id 从不传给子**。

### join 与 agent 间消息

三条路径：`custom_message/async-result`（`details.jobs[{jobId,type,label,durationMs}]` + `<task-result id agent status duration>` 文本信封）、`hub` 的 `toolResult`（`details.jobs[{id,type,status,label,durationMs,resolvedModel,resultText|errorText}]`）、以及子侧隐藏的 `yield` 工具对（结构化结果在子的 `toolResult.details.data`）。`agent://<id>` 与 `history://<id>` 实测都解析到真实文件且在进程退出后仍存在。

omp 在 **agent 间消息**上比 Codex 更细：

```json
// 发送方（Ping.jsonl）
"details":{"op":"send","from":"Ping","to":"Pong","receipts":[{"to":"Pong","outcome":"injected"}]}
// 接收方阻塞在 hub wait（Pong.jsonl）
"details":{"op":"wait","from":"Pong",
  "waited":{"id":"15554cd73836cad9","from":"Ping","to":"Pong","body":"MANGO","ts":1786572049632}}
```

`details.waited` 同时给出消息 id、收发双方、正文与时间戳。但注入路径（`custom_message/irc:incoming`）只有 `{id, from, message}`，**没有 `to`**，且发送回执**没有消息 id**——两半 DM 无法按 id 联接，只能靠 `(from, to, body, ts)` 匹配。

### 陷阱

1. **`parentId` 是位置指针不是因果指针**。实测 172/172 条的 `parentId` 等于紧邻前一条的 `id`；当一个 assistant turn 并行发两个工具调用时，第二个 `tool_execution_start` 的 `parentId` 指向第一个 `tool_execution_start`，而不是发起它们的 assistant 消息。**因果必须走 `toolCallId`。**
2. **单文件上传 = 永久扁平**。父 JSONL 只知道"有个叫 X 的子 agent 被 spawn 了、它返回了这些字符串"，子的上百条内部记录在另一个文件里且无反向引用。任何"上传这个 session 文件"的采集器都会丢掉全部子 agent。
3. `task` 的 toolResult 可能是**合成的**：`details.__synthetic: true` / `executed: false`（"Skipped due to queued user message"），没有真的 spawn。
4. **job 状态 ≠ 答案质量**。两次探针都返回了正确内容却被判 `failed (exit 1)`，只因模型 `yield` 了空数据；反向的例子同样存在。把 `failed` 直接映射成语义错误会误标。
5. JSONL 不自包含：超长字符串被替换为占位串、图片变成 `blob:sha256:…`、大工具输出溢出到 `<n>.<tool>.log` 并以 `artifact://<n>` 引用。
6. bucket 命名有漂移：文档写的是 `<scope>-<basename>-<sha256(cwd)>`，17.2.15 本机仍写 `-Projects-IntentTrace`，且旧 bucket 会在访问时被尽力迁移——两次读之间目录可能改名。
7. 没有任何结构化字段记录**为什么**要 spawn：`intent` 是生成的一行字，共享 `context` 只存在于工具参数与子的 systemPrompt 文本里。

---

## pi

### 结论：没有子 agent 能力

`@earendil-works/pi-coding-agent 0.84.1`（Mario Zechner，MIT，`github.com/earendil-works/pi`）。四条独立证据：README:17「skips features like sub agents」、README:500「**No sub-agents.**」、`docs/usage.md:303`、以及 `pi --help` 的 Built-in Tool Names 穷举七个工具 `read/bash/edit/write/grep/find/ls`——没有 `task`/`subagent`/`spawn_agent`，也没有任何开关。

包内**附带一个示例扩展** `examples/extensions/subagent/`，注册名为 `subagent` 的工具，需 `pi -e <path>` 或装到 `~/.pi/agent/extensions/` 才生效，且还需要 `~/.pi/agent/agents/*.md` 里的 agent 定义。默认关闭；本机只装了一个 provider failover 扩展。

### 两次探针分别暴露两种失败模式

**默认安装**：模型没有派发工具，于是用 `bash` 起了一个子 `pi` 进程。子进程写了**自己的完整 session 文件**，与父文件之间**没有任何引用**——父侧只是一个普通的 `bash` toolCall，schema 层面与 `ls` 无异。

**加载扩展后**：子**什么都没写**。扩展给子进程传 `--no-session`（`index.ts:294`）并丢弃子的 `session` 流事件（`index.ts:342-377`）。父侧 `toolResult.details.results[]` 里嵌了子的整个 transcript（`{agent, agentSource, task, exitCode, messages[], stderr, usage, model, stopReason}`），但**没有 id**。

所以 pi 的 spawn 链接**不存在**：`parentId` 是文件内条目树、`toolCallId` 只配对调用与结果、`SessionHeader.parentSession` 是 `/fork` 写的**文件路径**（两个探针子会话上都是 undefined）。唯一可恢复的是文本：子的 `--mode json` stdout 被粘进父的 bash 结果里。

### trace 位置与获取

```
~/.pi/agent/sessions/--<cwd 的 / : 换成 ->--/<ISO>_<uuidv7>.jsonl
```

纯 JSONL，**零 SQLite**。获取途径最丰富的一个：直接读文件、`--mode json` 行流、`--mode rpc` 双向协议、`/export`（HTML 或 JSONL）、`pi --export`、`/import`、`/share`（gist）、以及 SDK 的 `SessionManager.open/list/listAll/getTree`。根目录可用 `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` / `--session-dir` 改写，便于把一次运行隔离到独立目录里采集。

### 陷阱

- session 是**分支树而非日志**，`/export` 的 JSONL 会把树压平成活动分支；要还原真实结构须用 `getTree()` 并尊重 `compaction.firstKeptEntryId`。
- 头行没有 `id`/`parentId`，不是树节点。
- 目录名编码有损（路径里真实的 `-` 与分隔符无法区分），真值在头部 `cwd`。
- `details` 是扩展私有、无版本约定的数据。
- `thinking` / `thinkingSignature` / `usage.reasoning` 明文在库，必须剥离。
- **"没有 spawn 记录"与"扩展没加载"在数据上无法区分。**

---

## Grok Build

### 启用与版本

`grok 1.0.3 (1a29d5bc12)`，原生 ELF，非 Node shim。"grok build" 是**产品名不是子命令**：22 个子命令里没有 `build`，该名字只出现在 `--help` 标题、默认模型 id `grok-build` 与工具命名空间 `grok_build`。文档随安装分发在 `~/.grok/README.md`（2689 行）。

**默认开启**，只有反向开关：`--no-subagents`、`GROK_SUBAGENTS=0`、`[subagents] enabled=false`，另有 `[subagents.toggle]`、`[subagents.models]`、`roles`/`personas`（persona 缺失时 **fail-closed**）。工具是 `spawn_subagent`（kind `task`）与 `get_command_or_subagent_output`。

### trace 位置

```
~/.grok/sessions/<percent-encoded-cwd>/<session-uuidv7>/
├── updates.jsonl        # 权威记录：ACP JSON-RPC 通知，紧凑 JSON
├── events.jsonl         # 生命周期/遥测
├── chat_history.jsonl   # 发给模型的原始消息
├── summary.json         # 索引项，含 session_kind / agent_name
└── subagents/<child-session-id>/{meta.json,output.json}   # 父侧子清单与结果
```

本机 214 个 session 目录 = **46 个根 + 168 个子**（`subagent` 56、`subagent_resume` 104、`subagent_fork` 8），只有 4 个父曾经 spawn 过。`session_search.sqlite` 只是 FTS 索引且只覆盖 51/214，不能用于枚举。

### 父侧：结构最完整的一家

关键记录在**厂商扩展方法 `_x.ai/session/update`** 上，而不是标准 `session/update`：

```json
{
  "method": "_x.ai/session/update",
  "params": {
    "sessionId": "019f97e1-…",
    "update": {
      "sessionUpdate": "subagent_spawned",
      "subagent_id": "019f9856-…",
      "parent_session_id": "019f97e1-…",
      "parent_prompt_id": "961b7f0f-…",
      "child_session_id": "019f9856-…",
      "subagent_type": "general-purpose",
      "description": "GitHub CoT decrypt search",
      "effective_context_source": "new",
      "capability_mode": "read-only",
      "model": "grok-4.5"
    },
    "_meta": { "eventId": "019f97e1-…-328", "agentTimestampMs": 1784967203942 }
  }
}
```

计数严丝合缝：**168 `subagent_spawned` ↔ 168 `subagent_finished` ↔ 168 `meta.json` ↔ 168 个子 session**。另有持久化的父侧清单 `subagents/<child>/meta.json`，字段包括 `status`、`started_at`、`completed_at`、`duration_ms`、`tool_calls`、`turns`、`effective_model_id`、`child_cwd`。

### 子侧与链接

子是父的**同级目录**，不嵌套；靠 `summary.json.session_kind` 与 `prompt_context.json.audience: "subagent"` 自证身份。**子从不提及父**：在子的 `updates.jsonl`、`events.jsonl`、`system_prompt.txt`、`summary.json` 中，父 id 出现 0 次。边只存在于父侧。

`subagent_id == child_session_id`（168/168），且等于目录名、`meta.json` 所在目录、join 工具的 `task_ids[]`。父 turn 归因用 `parent_prompt_id`，但**只有 53/168 有**（`resumed` 的 104 个里仅 1 个有）；退路是 `_meta.eventId`（格式 `<parent-session-id>-<seq>`，给出父流内的全序）与 `~/.grok/logs/unified.jsonl` 里 `prompt_id: subagent-completed-<child_session_id>` 的合成唤醒记录。

### join

三处冗余且**全部结构化**：`subagent_finished{status, tool_calls, turns, duration_ms, tokens_used, output}`、`rawOutput.MultiResult.results[]{task_id, command, status, exit_code, started, ended, duration_secs, output}`、以及持久文件 `output.json{schema_version, output}`。这是六家里 join 结构化程度最高的。

### 陷阱

1. **厂商方法承载全部结构**。合规的 ACP 读取器只认 `session/update`，会把对话解析得好好的，却丢掉 100% 的 agent 结构（本机 2540 条 vendor 记录分布在 184 个 session）。
2. **`spawn_subagent` 工具调用不是 spawn 的可靠标志**：只在 2 个文件里出现 32 次，而 `subagent_spawned` 在 4 个文件里出现 168 次——约 81% 的 spawn 由内部 goal/planner 子系统发起，没有可见工具调用。
3. **resume/fork 每次都铸新 session id**，靠 `resumed_from` 串链：168 个子 id 实际只对应 **64 条逻辑 agent 线程**，最长一条链 10 个 id 共享同一个 `description`。**泳道键必须取 `resumed_from` 链的根。**
4. 嵌套实测恰好深度 1（168 个子无一有 `subagents/` 目录）；更深的层级 schema 允许但未观察到。
5. 没有 agent 间消息：509 次工具调用的完整清单里没有任何消息原语，也没有任何记录带收发方。通信严格是"向下派发 prompt、向上回一个结果"。
6. `grok sessions list` 隐藏子 session；`grok trace <id> --local --json` 会把 77 个子的 meta+output 打包进一个 13 MB 的 JSON，但**不含子 session 目录本身**。
7. 每个 JSONL 旁有 0 字节 `.lock` 兄弟文件，通配时要跳过。

---

## 对 IntentTrace 的意义

### 现状为什么全丢

| 位置                                   | 现状                                       | 后果                               |
| -------------------------------------- | ------------------------------------------ | ---------------------------------- |
| `packages/adapters/src/claude.ts:267`  | `agentId: object.agentId ?? "claude"`      | root 记录无 `agentId` → 单泳道     |
| `packages/adapters/src/codex.ts:306`   | `agentId: payload?.agent_id ?? "codex"`    | 丢弃 `parent_thread_id` 等全部字段 |
| `packages/adapters/src/common.ts:112`  | `traceId = stableUuid(source + sessionId)` | 每个 session 文件自成一条 trace    |
| 两个 adapter                           | 从不设 `spanId`/`parentSpanId`             | 没有任何 span 结构                 |
| `packages/adapters/src/types.ts:10-13` | `AdapterInput = {bytes, sourceIdentity}`   | 只能吃单文件                       |

六家里有五家把子 agent 放在**父之外的文件、目录或数据库行**。单文件输入在架构上就无法表达 spawn。

### 规范映射

| canonical                  | Codex                                  | Claude Code                           | opencode              | omp                      | Grok Build                   |
| -------------------------- | -------------------------------------- | ------------------------------------- | --------------------- | ------------------------ | ---------------------------- |
| `traceId` 依据             | `session_meta.session_id`（fork 链根） | root `sessionId`                      | 顺 `parent_id` 走到根 | 父 session 文件名        | 顺 `parent_session_id` 到根  |
| `agentId`（泳道）          | `session_meta.id`                      | `agentId`                             | `session.id`          | agent 名（文件名）       | `resumed_from` 链根          |
| `attributes.parentAgentId` | `parent_thread_id`                     | `parentAgentId` 或 root               | `session.parent_id`   | 目录归属（无字段）       | `parent_session_id`          |
| `parentSpanId`（派发点）   | `sub_agent_activity.event_id`          | `meta.toolUseId`                      | `part.data.callID`    | `toolCallId`（未传给子） | `parent_prompt_id`（53/168） |
| join 事件                  | `agent_message` FINAL_ANSWER           | `tool_result` / `<task-notification>` | `state.output` 信封   | `async-result` / `hub`   | `subagent_finished`          |
| peer 消息                  | `agent_message{author,recipient}`      | `SendMessage.to`（无 sender）         | 无                    | `hub` `details.waited`   | 无                           |

### 落到设计上的三条结论

1. **`AdapterInput` 必须变成 session bundle。** 五家的子 agent 都在兄弟文件/目录/DB 行里。同时这会撞上 `docs/security.md:19` 的"服务端不枚举目录"边界，只能由浏览器目录选择或 Collector 授权根提供字节。
2. **`parentSpanId` 语义要收敛为"派发调用的 span"。** 五家都能提供这个锚点（Codex 的 `event_id`、Claude 的 `toolUseId`、opencode 的 `callID`、omp 的 `toolCallId`、Grok 的 `parent_prompt_id`），只是可靠性不同；omp 需要把 `toolCallId` 传给子才能补齐。
3. **peer 消息是一等关系，不是 spawn 的特例。** Codex 实测 1341 条兄弟消息，omp 有 `hub` DM。只按 spawn 树建图会把这两家的真实拓扑退化成树。详见 [Agent spawn 与 join 拓扑](../agent-spawn-topology.md)。

### 复现方法

```bash
# 通用配方：快照 → 强制单次 spawn → diff → dump 父子记录
PROMPT="Spawn exactly one subagent and give it this task: reply with the single word BANANA.
Wait for it, then report the word it returned and the subagent's id. Do not answer BANANA yourself."

codex exec --skip-git-repo-check "$PROMPT"                                   # 需 features.multi_agent = true
claude -p "$PROMPT" --output-format stream-json --verbose                     # stream-json 比磁盘更富
opencode run --pure --auto "$PROMPT"
omp -p "$PROMPT"
pi -e examples/extensions/subagent/index.ts --approve "$PROMPT"               # 默认无此能力
grok -p "$PROMPT" --output-format json                                        # 本机认证过期未跑通
```

各 store 的 diff 方式：Codex/Claude/omp/pi 数文件，opencode 数 SQLite 行，Grok 数 session 目录。

## 附录：逐 harness 原始报告

本文是汇总。每个 harness 的完整实测报告——逐条 verbatim 记录样本、全语料计数、探针命令与前后 diff、以及该格式独有的陷阱清单——保留在 `spawn-formats/` 下，未经压缩改写：

| harness          | 原始报告                                                       |
| ---------------- | -------------------------------------------------------------- |
| OpenAI Codex CLI | [`spawn-formats/codex.md`](spawn-formats/codex.md)             |
| Claude Code      | [`spawn-formats/claude-code.md`](spawn-formats/claude-code.md) |
| opencode         | [`spawn-formats/opencode.md`](spawn-formats/opencode.md)       |
| Oh My Pi (omp)   | [`spawn-formats/omp.md`](spawn-formats/omp.md)                 |
| pi coding agent  | [`spawn-formats/pi.md`](spawn-formats/pi.md)                   |
| Grok Build       | [`spawn-formats/grok-build.md`](spawn-formats/grok-build.md)   |

六份报告共用同一组标题（版本与启用、trace 位置、父侧、子侧、链接、join、agent 间消息、嵌套与身份、探针记录、陷阱），可以逐节横向对读。所有主机路径已改写为 `~` 或 `<user>`，隐藏推理内容未被复制。
