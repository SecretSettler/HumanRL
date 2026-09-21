---
status: accepted
owner: maintainers
last_reviewed: 2026-08-12
normative: true
milestone: Gate 5
---

# Agent spawn 与 join 拓扑

语义图当前在任何数据上都只能渲染成一条链。本文定义完整的修复设计，分三层：**harness 拓扑能力声明**（哪些 code agent 有追踪能力、能力到什么程度，并把这个事实记进 IntentTrace）、**逐 harness 适配映射**（把各家的 spawn/join 字段翻译成 canonical 事实）、**确定性 reducer 派生**（把事实变成结构边）。外加 demo 录制的重生成，让自产数据与外部导入共用同一套字段。

各 harness 的实测证据不在本文重复，见[六个 Agent Harness 的 spawn 记录格式](research/agent-spawn-formats.md)与其附录。

## 问题

四处独立缺陷。任何一处单独修复都不足以让图变成 DAG。

**1. 派生层（决定性）。** `packages/summarizer/src/index.ts:96` 取 `input.allowedNodeIds.at(-1)` 作为新节点的 `primaryParentRef`（`:118`）并据此建边（`:129-137`）。parent 恒等于"最近创建的节点"，与 agent、span、时间重叠无关，因此拓扑恒等于 ingest 顺序。已提交的 demo revision 上实测 5 条边全部是 `attempts`×4 + `produces`×1 的单链，其中 `ImoConstructions → ImoImpossibility` 在真实运行里并不存在——两者是被同时派出的兄弟。

**2. 适配层。** `packages/adapters/src/claude.ts:267` 是 `agentId: object.agentId ?? "claude"`，而 Claude Code 的 root 记录上根本没有 `agentId`，于是整条 trace 只有一条泳道；`packages/adapters/src/codex.ts:306` 同理，且完全丢弃 `parent_thread_id`。`packages/adapters/src/common.ts:112` 用 `stableUuid(source + sessionId)` 生成 `traceId`，让每个 session 文件自成一条 trace——即使解析对了，父子也会落到互不相干的两条 trace 上。两个 adapter 都从不设 `spanId`/`parentSpanId`。

**3. 切分层。** `packages/db/src/repository.ts:409-411` 以全局 ingestSeq（第 1 条、每 50 条、`trace_complete`）建 summary job，chunk 横跨所有 agent；`packages/summarizer/src/index.ts:89` 每个 chunk 只选一条事件建一个节点。6 个 job → 6 个节点，六条并行泳道被压成六个采样点。

**4. 数据层。** demo 录制里 `parentSpanId` 存的是原始 transcript 的记录链，不是因果父；5 个子 agent 的根 span 没有 parent。spawn 关系只以自然语言形式存在于 `tool_result(task)` 的 payload 文本里，`artifactRefs` 在 231 条事件上全为空。

视图层不是缺陷：`apps/web/components/workbench/graph/GraphPanel.tsx:80-119` 已经用 ELK 分层布局、按 `primaryAgentId` 分泳道、并消费 `graph.edges`。给它扇出扇入的边集即可渲染真实 DAG。

## 目标与非目标

目标：

- spawn、join 与 agent 间消息尽可能成为**事实**而非推断：每条结构边都能回到具体 raw event，`provenance` 如实反映该来源的表达能力（格式直接给出字段则 `stated`，只能从布局或文本推断则 `inferred`），而不是一律标成 `stated`。
- **能力可声明、缺失可解释。** 一条 trace 必须能回答"这里没有 spawn 边，是因为这个 harness 表达不了，还是因为这次运行真的没有派发"。今天这两种情况在 UI 上完全无法区分。
- 结构边由确定性 reducer 产出，provider 不再决定 parent，符合[系统不变量](../architecture.md#system-invariants)与 [reducer 契约](../contracts.md#reducer-contract)。
- 自产录制与外部导入共用同一组 canonical 字段，不为 demo 造特例。

非目标：

- 不改节点密度。每个 chunk 一个节点（缺陷 3）留待独立设计；本文只保证既有节点之间的边正确、泳道数正确。
- 不新增语义边类型。`SemanticEdgeKindSchema`（`packages/schema/src/index.ts:327-338`）已有 `decomposes_to`、`hands_off_to`、`depends_on`、`supports`、`blocks`、`resolved_by`、`produces`，够用。
- 不改视图层。
- 不解密任何 harness 的密文载荷。Codex 的 `spawn_agent.message` 是服务端密钥的密文（9260/9260 条），指令内容不可得也不应承诺可得。

## 概念模型

五种关系，彼此正交：

| 关系    | 含义                                      | 事实来源                                      |
| ------- | ----------------------------------------- | --------------------------------------------- |
| lane    | 一个 agent 的执行序列                     | `agentId`                                     |
| spawn   | 父 agent 的某次调用创建了子 agent         | 父侧派发记录 + 子侧 `agent_start`             |
| join    | 子 agent 的产物被父 agent 收敛            | 子侧 `agent_end` + 父侧收敛处的 `tool_result` |
| message | 两个 agent 之间的直接通信，可以是兄弟之间 | 带发送方与接收方的消息事件                    |
| human   | 人对某个节点的干预                        | 真人 `user_message`；`node_feedback` 行       |

`message` 不是 spawn 的特例。Codex 实测 9766 条 `agent_message` 中有 **1341 条是同级兄弟之间**的，omp 的 `hub send` 同样允许兄弟直连。只按 spawn 树建图会把这两家的真实拓扑退化成树。

关键区分：机器注入的任务书与真人请求在当前模型里都是 `kind: user_message`，无法区分。demo 录制 6 条 `user_message` 中只有第 1 条是真人，其余 5 条是编排者派活时注入的任务书。任务书是**子 lane 的目标**，不是用户意图。

## 一、Harness 拓扑能力声明

### 为什么必须显式声明

六家 harness 的拓扑表达能力差异极大：Codex 与 Grok Build 在父侧写下子 session id，Claude Code 写在 sidecar 文件里，omp 只写 agent 名字，pi 根本没有子 agent 功能。如果不声明，所有这些情况在图上都长得一样——一条没有分叉的链——而读者无从判断这是数据的样子还是产品的缺陷。

`docs/contracts.md:57` 已经要求"An adapter declares its source kind, adapter name/version, supported source versions, **and capabilities**"。`AdapterManifest`（`packages/adapters/src/types.ts:3-8`）目前只有前三项，**capabilities 这一句至今没有实现**。本节把它补齐，并限定为拓扑能力。

### 声明的数据结构

`AdapterManifest` 增加一个 `topology` 块：

```ts
/** 一项拓扑关系在该 source 格式中的可得性。 */
type TopologyFidelity =
  | "stated" //   格式以结构化字段直接表达，adapter 无需推断
  | "inferred" //  只能从文本、时序或文件布局推断，provenance 必须降级
  | "passthrough" // 由生产者决定（canonical JSONL / OTLP），逐 trace 实测
  | "unsupported"; // 该 harness 没有这个概念

interface TopologyCapability {
  spawn: TopologyFidelity;
  join: TopologyFidelity;
  peerMessages: TopologyFidelity;
  /** 子 agent 是否与父在同一份输入里。bundle 表示必须同时提供兄弟文件/目录/DB。 */
  input: "single-file" | "bundle";
  /** 该格式下用作 agentId 的字段，写进 trace 供审计。 */
  laneKey: string;
  /** 已知会导致边缺失的格式限制，逐条可读。 */
  limits: readonly string[];
}
```

`TopologyFidelity` 直接决定 reducer 产出的边的 `provenance`：`stated` → `stated`，`inferred` → `inferred`，`unsupported` → 不产边。`passthrough` 逐条边解析：该边所依据的 canonical 字段（`attributes.parentAgentId`、`parentSpanId`、`causationSourceEventId`）实际存在则按 `stated` 处理，不存在则该边不产出——**`passthrough` 从不降级成推断**，因为 canonical 生产者本来就有能力把事实说清楚。这是能力声明与证据模型之间唯一的耦合点，故意做窄。

### 六家的声明值

| source     | spawn         | join          | peerMessages  | input       | laneKey                   |
| ---------- | ------------- | ------------- | ------------- | ----------- | ------------------------- |
| `codex`    | `stated`      | `stated`      | `stated`      | bundle      | `session_meta.payload.id` |
| `claude`   | `stated`      | `stated`      | `inferred`    | bundle      | `agentId`                 |
| `opencode` | `stated`      | `stated`      | `unsupported` | bundle      | `session.id`              |
| `grok`     | `stated`      | `stated`      | `unsupported` | bundle      | `resumed_from` 链根       |
| `omp`      | `inferred`    | `stated`      | `stated`      | bundle      | agent 名（文件名）        |
| `pi`       | `unsupported` | `unsupported` | `unsupported` | single-file | `session.id`              |
| `jsonl`    | `passthrough` | `passthrough` | `passthrough` | single-file | `agentId`                 |
| `otlp`     | `passthrough` | `passthrough` | `unsupported` | single-file | `service.name`            |

几处判断的理由：

- **omp 的 spawn 是 `inferred`**，不是 `stated`。子 session UUID 在父文件中出现 0/8 + 0/2 次，唯一的链接是文件名与 `details.progress[].id` 的字符串相等。这是布局约定而非字段。修法在本文最后一节：让 omp 把 `toolCallId` 与父 session id 写进子的 `session_init`，届时可升级为 `stated`。
- **Claude 的 peerMessages 是 `inferred`**：`SendMessage.input.to` 给出接收方，但接收方记录只有 `origin.kind: "coordinator"`，**没有发送方 id**（179/179 条 `origin` 只有 `kind` 一个键），必须靠内容与时间配对。
- **pi 三项全是 `unsupported`**：默认安装下子 agent 是一个 `bash` 起的子进程，父侧只有一个与 `ls` 无异的 `bash` toolCall；加载官方示例扩展后子进程带 `--no-session`，**子什么都不写**，结果整个嵌在父的 `toolResult.details.results[]` 里且没有 id。既然没有子 lane 可连，join 也就无从谈起——把它标成 `inferred` 会诱导 reducer 去连一条不存在的边。
- **`passthrough` 不是"能力强"**，而是"能力由生产者决定"。canonical JSONL 想表达什么都行，所以必须逐 trace 实测，见下。

### 怎么记进 IntentTrace 的记录

**声明按 `(sourceKind, adapterVersion)` 查表，不落库。** 每条 raw event 已经存了 `source_kind` 与 `adapter_version`（`packages/db/src/schema.ts:112-114`），registry 就是查找表。

不采用的替代方案：在 `traces` 表加一列存能力快照。它会与 registry 漂移——adapter 升级后老 trace 的能力描述会永远停留在导入那天的值，而能力描述的意义恰恰是"用今天的理解解释这份数据"。声明是读取器的属性，不是事实的属性；把它塞进 append-only 的事实里违反[系统不变量](../architecture.md#system-invariants)。

**实测覆盖率则逐 trace 计算并随快照返回。** `TraceSnapshotSchema` 增加一个 `topology` 块：

```ts
topology: {
  declared: TopologyCapability; // 查表所得
  observed: {
    lanes: number; // distinct agent_id
    lanesWithParent: number; // 有 attributes.parentAgentId 的 lane 数
    spawnEdges: number; // 已提交 revision 上的 decomposes_to 条数
    peerEdges: number; // 跨 lane 的 hands_off_to 条数
  }
}
```

`observed` 由一条对 `raw_events` 的聚合加一条对 `semantic_edge_versions` 的计数得出，不新增存储。

**UI 契约（本文只定契约，不做实现）：** 当 `lanes > 1` 而 `spawnEdges == 0` 时，Intent Graph 必须显示声明里的原因，而不是静默画一条链。三种文案对应三种 fidelity：`unsupported` → "该来源不记录 agent 派发关系"；`inferred` → "派发关系为推断，证据为文件布局"；`passthrough` → "该 trace 的生产者未提供派发字段"。

## 二、逐 harness 适配映射

所有 adapter 共用同一套目标字段：`traceId` 取**根** session、`agentId` 取 laneKey、子 lane 首事件的 `parentSpanId` 指向父侧派发调用的 span、`attributes.parentAgentId` 给出 lane 级父子。

### 通用前置：session bundle

`AdapterInput`（`packages/adapters/src/types.ts:10-13`）从 `{bytes, sourceIdentity}` 改为：

```ts
interface AdapterInput {
  parts: readonly { path: string; bytes: Uint8Array }[]; // path 相对用户选定的根
  sourceIdentity: string;
}
```

单文件是 `parts.length === 1` 的退化情形，`jsonl`/`otlp`/`pi` 永远走这条路。这是本设计**唯一的公开接口破坏性变更**。

边界不变：API 仍然不接受路径参数、服务端仍然不枚举目录（`docs/security.md:19`）。字节的来源只有两个——浏览器的目录选择（`/import` 已支持选目录）与 Collector 的显式授权根。adapter 拿到的是一个已经被交出来的字节集合，它只能在集合内部按相对路径解析关系。

### Codex

- **输入**：`~/.codex/sessions/**/rollout-*.jsonl` 的一个集合。父与子是同级文件，靠内容而非路径关联。
- **traceId**：`session_meta.payload.session_id`（cli ≥ 0.145 全链恒定，等于根 thread id）；旧文件沿 `forked_from_id` 走到根。
- **agentId**：`session_meta.payload.id`。**绝不能用 `session_id`**——子文件里它是父的 id。
- **spawn**：`event_msg.sub_agent_activity{event_id, agent_thread_id, agent_path, kind:"started"}`。`event_id == 父 function_call.call_id`，`agent_thread_id` 是子的 `agentId`。子侧 `parentSpanId` = 该 `call_id`，`attributes.parentAgentId` = `parent_thread_id`。
- **join / message**：`response_item.agent_message{author, recipient}` → `hands_off_to`。`Message Type: FINAL_ANSWER` 是完成信号（**没有完成事件**：`sub_agent_activity.kind` 只有 `started|interacted|interrupted`）。
- **必须的预处理**：
  1. **fork 去重**。`fork_turns:"all"` 把父的整个 rollout 抄进子文件并把每行时间戳重盖为 fork 时刻，本机 3,455,710 条记录里 3,220,520 条（93%）是这种副本。按 `forked_from_id` 读祖先、对 payload 做哈希去重（实测 7683/7683 精确命中）。不做这一步，一次 24 分钟的运行会变成一毫秒内的雪崩。
  2. **fork ≠ spawn**。`parent_thread_id` 才是派发边；`forked_from_id` 只表示历史被复制。只有 `forked_from_id` 而没有 `parent_thread_id` 的那 1 个文件是人类会话分叉，画派发边是错的。
  3. **取 line 1 的 `session_meta`**。forked 文件有两条，第二条是祖先的。
  4. **按 `multi_agent_version` 分支**。v1（0.141–0.143，namespace `multi_agent_v1`）的 `function_call_output` 直接给 `{"agent_id":"<child uuid>","nickname":…}` 且 message 是明文；v2（0.144.1+，namespace `collaboration`）改为路径与密文。v1 反而更好读。
  5. **`history_mode: "paginated"` 下 `sub_agent_activity` 不落盘**（上游 `rollout/src/policy.rs` 只在 legacy 分支持久化），本机已有 8 个这样的文件。此时 spawn 降级为 `inferred` 或缺失，必须如实声明而不是猜。
- **去重**：agent 间消息同时写进收发双方的 rollout，按 `(author, recipient, encrypted_content)` 去重，否则每条 peer 消息双计。

### Claude Code

- **输入**：`<cwd-slug>/<rootSessionId>.jsonl` **加上** `<rootSessionId>/subagents/**`。`meta.json` 不是 `.jsonl`，bundle 的通配必须显式包含它——丢了它，46/48 条非 workflow 的 spawn 边全部不可恢复。
- **traceId**：root `sessionId`。
- **agentId**：子记录的 `agentId`（10803/10803 覆盖）；父 lane 用 root sessionId。**绝不能用 `sessionId`**——父子共用一个值，这正是当前的扁平化 bug。
- **spawn**：`agent-<id>.meta.json` 的 `toolUseId` == 父侧 `tool_use.id`（工具名是 **`Agent`**，不是 `Task`；46/46 条实测）。子侧 `parentSpanId` = 该 `toolu_…`，`attributes.parentAgentId` = `meta.parentAgentId`（仅 `spawnDepth > 1` 时存在）或 root。
- **join**：同步为 `tool_result` + `toolUseResult{agentId, agentType, status, totalDurationMs, totalTokens}`；异步为 `origin.kind == "task-notification"` 的散文，解析 `<task-id>`/`<tool-use-id>`。
- **必须的预处理**：
  1. **异步 join 去重**。同一信封会重复出现在 `queue-operation`（enqueue **和** remove）与 `attachment{queued_command}` 里，一次 join 最多被数到 4 次。按 `<task-id>` + `<tool-use-id>` 去重。
  2. **过滤后台 bash**。`<task-notification>` 也用于后台 shell，其 `<task-id>` 是 `b` 前缀，不是 agentId。不过滤会凭空造出 agent 泳道。
  3. **join 不是 1:1**。agent 被 `SendMessage` 唤醒后会再次通知，同一 `task-id` 可多次 join。lane 是可续跑区间，不是单个闭区间。
  4. **workflow 子 agent 单独归组**。157 个 sidecar 里 109 个（`workflows/wf_*`）没有 `toolUseId`，与父 turn 永久无法关联。按 `wf_<id>` 分组呈现，**不要编造边**。
  5. **容错**。root 文件里 `queue-operation`/`ai-title`/`last-prompt` 没有 uuid、有时没有 timestamp；`message.content` 是 `string | Array<block>` 两种形态；`thinking` 块带 signature 明文存盘，必须显式丢弃。
- **可选增强**：`--output-format stream-json` 的 `system/task_started` 在 spawn 时刻同时给出 `task_id` 与 `tool_use_id`，比磁盘更完整。若将来做实时采集，这是首选来源；磁盘导入不依赖它。

### opencode

- **输入**：`~/.local/share/opencode/opencode.db` **加上 `-wal`**。探针时 4.3 MB 未 checkpoint，只拷 `.db` 会丢掉最近的 session（包括探针自己）。
- **traceId**：沿 `session.parent_id` 走到根。**agentId**：`session.id`（不是 `session.agent`，那是类型；也不是 `title`，那是格式化字符串）。
- **spawn**：`part.data.state.metadata.sessionId`（父→子）与 `session.parent_id`（子→父）双向都有。`parentSpanId` = `part.data.callID`，父 turn 由 `part.message_id` 精确定位。
- **join**：`part.data.state.output` 的文本信封，正文只有子的最后一个 text part。
- **必须的预处理**：
  1. **两种 join 信封共存于一个库**，判别只有 `session.version`：`<task id=… state=…>`（1.18.16+）与 `task_id: ses_… (for resuming…)`（≤1.2.21）。共用的只有 `<task_result>` 正则。
  2. **截断会吞掉闭合标签**。`truncated: true` 的输出没有 `</task_result>`，要求闭合标签的正则会静默丢结果；此时正文在 `state.metadata.outputPath` 指向的溢出文件里。
  3. **失败的 spawn 可能没有子 id**：34 条 task part 里 3 条 `status=error`，其中一条连 `state.metadata` 都没有。要容忍"一次派发调用指不出任何子"。
  4. **`ses_` 前缀字典序倒序**（61 个全部验证）。`ORDER BY id` 会把时间线整个反过来。
  5. **`task_id` 可复用既有子 session**，子与派发调用不是 1:1。
- **注意**：`event` 表只覆盖 61 个 session 中的 10 个，只能当加速器，不能当唯一来源。

### Grok Build

- **输入**：`~/.grok/sessions/<cwd>/` 下的**多个同级 session 目录**——子不是父的子目录。加上父目录里的 `subagents/<child>/meta.json`。
- **traceId**：沿 `parent_session_id` 走到根。**agentId**：`resumed_from` 链的**根**。168 个子 session id 实际只对应 64 条逻辑线程，用 `child_session_id` 直接做泳道键会把一条 agent 线程切成最多 10 条。
- **spawn**：`_x.ai/session/update` 上的 `subagent_spawned{parent_session_id, child_session_id, parent_prompt_id, subagent_type, effective_context_source, resumed_from}`，以及等价的持久文件 `subagents/<child>/meta.json`。
- **join**：`subagent_finished{status, tool_calls, turns, duration_ms, tokens_used, output}` 与 `output.json`——六家里结构化程度最高的。
- **必须的预处理**：
  1. **必须读厂商方法**。合规的 ACP 读取器只认 `session/update`，会把对话解析得好好的却丢掉 100% 的 agent 结构（2540 条 vendor 记录分布在 184 个 session）。
  2. **不要以 `spawn_subagent` 工具调用为准**。它只在 2 个文件里出现，而 `subagent_spawned` 有 168 次——约 81% 的 spawn 由内部 planner 发起，没有可见工具调用。
  3. **`parent_prompt_id` 只有 53/168 有**（`resumed` 的 104 个里仅 1 个）。缺失时退到 `_meta.eventId`（格式 `<parent-session-id>-<seq>`，给出父流内的全序）定位派发位置，并把该边的 `parentSpanId` 留空而不是编一个。
  4. **子从不提及父**，边只存在于父侧；枚举必须遍历所有 session 再按 `session_kind` 分类，不能只读一个目录。
  5. `updates.jsonl` 里 `agent_thought_chunk` 是**明文推理**，必须显式丢弃。

### omp

- **输入**：`<ts>_<id>.jsonl` 加上同名目录下的全部 `<AgentName>.jsonl`（含 `Parent/Parent.Child.jsonl` 的深度 2 形态）。**单文件上传等于永久扁平**——父文件只知道有个叫 X 的子 agent，子的上百条记录在另一个文件里且无反向引用。
- **traceId**：父 session 文件名里的 session id。**agentId**：agent 名（子文件的 basename），它同时出现在 `details.progress[].id`、`details.async.jobId`、`hub` 的 `details.jobs[].id`、`<task-result id=…>`、消息的 `from`/`to` 以及 `agent://` 授权段。父 lane 是字面量 `Main`。
- **spawn**：`inferred`——由 bundle 内的目录归属加 agent 名相等确定。`parentSpanId` 只能留空，因为 `toolCallId` 不传给子。
- **join**：`custom_message/async-result` 与 `hub` 的 `details.jobs[]`（结构化元数据）+ `<task-result …>` 文本信封（结果本身）。
- **message**：`stated`。`details.waited{id, from, to, body, ts}` 是六家里最完整的消息记录。注意 `details.from` 在 `wait` 上是**调用者**不是发送方，只有 `details.waited.from` 是发送方；注入路径 `irc:incoming` 的 `details{id, from, message}` **没有 `to`**，接收方隐含在文件归属里。
- **必须的预处理**：
  1. **`parentId` 不是因果**。实测 172/172 条等于紧邻前一条的 id；两个并行工具调用时，第二个 `tool_execution_start` 的 `parentId` 指向第一个 `tool_execution_start`。因果只能走 `toolCallId`。
  2. **第一物理行是 256 字节 title 填充槽**，不是 session 头。
  3. **合成的 `task` 结果**：`details.__synthetic: true` / `executed: false` 表示没有真的 spawn。
  4. **job 状态 ≠ 答案质量**。两次探针都返回了正确内容却因 `yield` 空数据被判 `failed (exit 1)`。不要把 job 状态直接映射成语义 `status: "error"`。
  5. JSONL 不自包含：超长内容被替换为占位串、图片是 `blob:sha256:…`、大工具输出溢出到 `<n>.<tool>.log` 并以 `artifact://<n>` 引用。

### pi

- **能力**：`spawn: "unsupported"`。README 与 `--help` 的内置工具清单（`read/bash/edit/write/grep/find/ls`）都明确没有子 agent；官方示例扩展 `examples/extensions/subagent/` 可加上，但它给子进程传 `--no-session`，子什么都不写。
- **处理方式**：按单 agent trace 导入，`topology.declared.spawn = "unsupported"`，UI 据此说明"该来源不记录 agent 派发关系"。
- **绝不要**从 `bash` 调用里嗅探"看起来像是在起子 agent"的命令行。默认安装下子 agent 确实表现为一个 `bash` toolCall，但它与 `ls` 在 schema 层面毫无区别；这样的启发式会在别的项目里凭空造出 agent。
- 已知会误导的字段：`SessionHeader.parentSession` 是 `/fork` 写的**文件路径**，是会话血缘不是派发，两个探针子会话上都是 undefined。

### `TraceSourceKind` 扩容

`packages/schema/src/index.ts:14` 现为 `["jsonl","otlp","codex","claude","custom"]`，需要加入 `opencode`、`omp`、`grok`。这是一次已发布响应契约变更：`source.kind` 出现在每条 raw event、每个 import 响应与生成的 OpenAPI 里，必须重新生成契约产物并在 `docs/contracts.md` 记录。

## 三、Canonical 事件模型变更

三项，均为加法。

**1. `attributes.parentAgentId`（子侧）。** 子 agent 的 `agent_start` 携带派生它的 agent id。这是 lane 级父子关系，与具体调用点无关，六家里有五家能直接填。

**2. `parentSpanId` 语义收敛（子侧）。** 子 lane 首个事件的 `parentSpanId` 必须指向**父侧那次派发调用的 span**——Codex 的 `call_id`、Claude 的 `toolUseId`、opencode 的 `callID`、Grok 的 `parent_prompt_id`——而不是同 lane 的上一条记录。同 lane 内的顺序由 `occurredAt` 与 `ingestSeq` 表达，不需要链表。这是语义修正，不是新字段：`parentSpanId` 已存在于 `packages/schema/src/index.ts:204`、DB 列 `parent_span_id`（`packages/db/src/schema.ts:127`）与 repository 双向映射。取不到时**留空**，由 `parentAgentId` 承担 lane 级关系。

**3. `causationSourceEventId`（input-only）。** `causationEventId`（`packages/schema/src/index.ts:201`）已存在于 schema、DB 列与 repository 映射，但 `packages/db/src/repository.ts:353` 是 `const eventId = randomUUID()`，生产者无法预知服务端 UUID，因此该字段至今无人写入。在 `RawTraceEventInputSchema` 上新增 input-only 的 `causationSourceEventId`（同 trace 内的 `source.sourceEventId`），由 ingest 在同一事务内解析成 `causation_event_id`。解析不到时以 warning 落库为 null，不拒绝事件——raw 事实优先于关系完整性。

不采用的替代方案：把 `eventId` 改成由身份四元组派生的确定性 UUID。它同样能让生产者预填 `causationEventId`，但会改变既有行的 id 生成语义，牵动幂等与外键，收益不足以抵消风险。

`artifactRefs`（`packages/schema/src/index.ts:213`）已经存在且为空数组，产物关系直接使用它，不需要新字段。

## 四、Reducer 派生规则

结构边在 reducer 提交 revision 时由 raw 事实生成，不经过 provider。

**前置缺陷：committed 边不带证据。** `ProviderGraphEdgeSchema`（`packages/schema/src/index.ts:481-488`）要求 `evidenceEventIds` 至少一条，但 `packages/intent-reducer/src/index.ts:395-406` 在提交时只保留 `logicalEdgeId/versionId/source/target/kind/retired`，证据被丢弃；读模型 `SemanticEdgeVersionSchema`（`packages/schema/src/index.ts:395-405`）与表 `semantic_edge_versions`（`packages/db/src/schema.ts:239-257`）也都没有证据或 provenance 列。若不修复，本文产出的结构边就是一组无法审计的断言，与 `AGENTS.md` 的 "evidence-backed" 不变量冲突。因此本设计包含：给 `semantic_edge_versions` 增加 `evidence_event_ids` 与 `provenance` 两列（Drizzle schema + 提交进仓库的 migration），reducer 不再丢弃 `evidenceEventIds`，读模型与生成的 JSON Schema/OpenAPI 相应更新。

**artifact 不是节点。** `SemanticNodeKindSchema`（`packages/schema/src/index.ts:285-293`）没有 artifact 类型；artifact 通过节点的 `artifactIds` 挂载。因此涉及产物的边一律连接**持有该 artifact 的节点**，而不是 artifact 本身。

每条边的 `evidenceEventIds` 为"事实"列列出的 raw event；`provenance` 取该 source 声明的 fidelity（`stated` 或 `inferred`），不是恒为 `stated`。

| 边              | 源 → 目标                                      | 事实                                                       |
| --------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| `decomposes_to` | 父 lane 的 handoff 节点 → 子 lane 的首节点     | 父侧派发记录 + 子侧 `agent_start.attributes.parentAgentId` |
| `hands_off_to`  | 子 lane 的末节点 → 父 lane 收敛处的节点        | `agent_end` + 父侧收敛处的 `tool_result`                   |
| `hands_off_to`  | 发送方 lane 的节点 → 接收方 lane 的节点        | 带发送方/接收方的 agent 间消息事件，且两者不同 lane        |
| `depends_on`    | 消费方节点 → 该 artifact 的显式生产方节点      | 显式 producer 事实 + 双方命名同一个已注册 artifact         |
| `produces`      | 代持写入节点 → 持有该 artifact 的节点          | `file_write.attributes.onBehalfOf` + `artifactRefs`        |
| `blocks`        | 工具缺失的 issue 节点 → 被阻塞 lane 的后继节点 | `tool_result` 且 `status = "error"`                        |

`revises` **不产出**：`node_feedback` 既没有语义源节点也没有 raw-event 证据，任何连线都只能是自环或凭空断言。人工编辑继续以 immutable human revision 表达。`SemanticEdgeKindSchema` 中的 `attempts`、`supports`、`resolved_by`、`revises`、`supersedes` 均为保留名，没有任何派生规则会产出它们；可派生集合以 `ReducerDerivedEdgeKindSchema` 为单一真源。

三条兜底规则，都优先于"把边画出来"：

- `depends_on` 需要显式 producer 事实，并且双方命名的必须是同一个**已注册**的 artifact。仅凭 `artifactIds` 交集或时间先后推断依赖是推断而非事实，宁可缺边；未注册的 artifact UUID 一律不产边，以免证据路径指向不存在的数据。
- 任何解析后源与目标落在同一节点的边一律丢弃：`semantic_edge_versions` 有 `semantic_edges_no_self_edge` 约束（`packages/db/src/schema.ts:255`），自环会让整个 patch 失败。`blocks` 在被阻塞 lane 没有后继节点时同样省略。
- 声明为 `unsupported` 的关系不产边，也不尝试启发式补齐；缺失由 `topology.declared` 解释。

`packages/summarizer/src/index.ts:96`、`:118`、`:129-137` 一并删除：provider 只提节点语义（`kind`、`title`、`claims`），parent 与边不再由它决定。这样真实 LLM 也无法幻觉出错误结构，且 `ChunkSummaryInput` 接口不必扩展。

`primaryParentId`（`packages/db/src/schema.ts:220`）由 reducer 按同一规则回填：同 lane 最近节点优先，否则派生它的 lane 的对应节点，否则 request 根。

## 五、录制重生成

现存 transcript 仍在 `2026-08-12T13-41-44-827Z_*` 会话目录下（主 session 175 条记录 + 8 个子 agent 文件），因此重跑 recorder 可行。重生成不重跑 agent。

recorder 变更：

- 子 `agent_start` 写 `attributes.parentAgentId` 与指向父侧 handoff span 的 `parentSpanId`。
- `tool_result(task)` 写 `attributes.spawnedAgentIds`，值从其 payload 文本的 ``- `<Name>` (job `<Name>`)`` 列表提取。
- `agent_end` 写 `attributes.joinedBy` 与 `artifactRefs`。
- `tool_result(hub)` 写 `attributes.joinedAgentIds`，值从 `### <Name> [task] — completed` 提取。
- 编排者代持写入的 `file_write` 写 `attributes.onBehalfOf` 与 `artifactRefs`。
- 任务书 `user_message` 写 `attributes.assignedBy`，据此与真人请求区分。
- 补录被丢弃的 3 条 scout 泳道（`WebUiSurface`、`IngestAndFixtures`、`DocsConventions`）。当前录制只有 6 条泳道，而 `#8` 明确记录 spawn 了这三个 agent，`#79` 的 join 因此指向一条不存在的 lane。

`parentSpanId` 不再存放 transcript 记录链；同 lane 顺序由时间与 ingestSeq 表达。

重生成后的录制 `source.kind` 仍是 `jsonl`，其 `topology.declared` 是 `passthrough`，而 `observed` 会显示 9 条泳道、8 条 spawn 边——正好用来验证 `passthrough` 的实测路径。

## 六、上游修复：让 omp 的 spawn 变成 `stated`

omp 是我们自己的 harness，也是六家里链接最弱的一个（`inferred`）。三处一次性改动即可升到 `stated`，且都在 omp 侧、不影响 IntentTrace 的 canonical 模型：

1. 子 `session_init` 增加 `parentSessionId` 与 `spawnToolCallId`（父侧那次 `task` 调用的 `toolCallId`）。这两个值在 spawn 时刻都在手边。
2. `task` 的 toolResult `details.progress[]` 增加 `childSessionId`。
3. `hub send` 的接收方记录（`irc:incoming`）增加 `to` 与发送方回执里的消息 id，让一条 DM 的两半可以按 id 联接，而不是靠 `(from, to, body, ts)` 匹配。

改完之后 omp 的 `parentSpanId` 可以填，`spawn` 声明升为 `stated`，且不再依赖"子文件必须和父文件一起上传"这个布局约定。这一项独立于本文其余部分，可以单独做。

## 影响面与验证

变更范围：

| 包                        | 变更                                                                     |
| ------------------------- | ------------------------------------------------------------------------ |
| `packages/schema`         | input-only 字段、边读模型加证据、`TraceSourceKind` 扩容、快照 `topology` |
| `packages/adapters`       | `AdapterInput` 改 bundle、`AdapterManifest.topology`、六个 adapter 映射  |
| `packages/db`             | ingest 解析 `causationSourceEventId`、边两列与其 migration、覆盖率聚合   |
| `packages/intent-reducer` | 结构边派生、不再丢弃边证据、按 fidelity 定 provenance                    |
| `packages/summarizer`     | 删除 `at(-1)` 及其建边                                                   |
| 录制与 fixture            | 重生成，9 条泳道                                                         |

验证：

- schema、OpenAPI 与 Drizzle migration 由 `pnpm schema:check` 守住（`drizzle-kit check` 在同一命令内）；生成产物不得手改，migration 必须提交进仓库。
- **每个 adapter 一份 bundle fixture**，断言：泳道数、spawn 边数、`parentSpanId` 覆盖率、以及该格式特有的预处理（Codex 的 fork 去重后记录数、Claude 的异步 join 去重后条数、opencode 的两种信封各解析出结果、Grok 的 `resumed_from` 链合并后的泳道数）。fixture 从本机实测样本裁剪，脱敏规则同 `docs/design/research/spawn-formats/`。
- 契约测试断言重生成后的自产录制：泳道数、`parentAgentId` 覆盖率、`spawnedAgentIds` 与实际 `agent_start` 集合一致。
- **能力声明本身要有测试**：`adapterManifests` 的每个 `topology.laneKey` 必须与该 adapter 实际写入 `agentId` 的字段一致，否则声明会悄悄说谎。
- 端到端证据是图本身：导入后 `/graph` 必须出现 `decomposes_to` 扇出与 `hands_off_to` 扇入，而不是单链；README 截图随之重拍。
- 全部门禁按 `AGENTS.md` 执行，证据记入 `project/progress.md`。

## 风险

- **`AdapterInput` 是破坏性变更**，全部调用点：四个 adapter 的 `sniff`/`parse`、`packages/adapters/src/registry.ts:34` 的 `detectSourceKind`、`packages/adapters/src/session.ts:91` 的 `prepareSessionBytes`、`apps/api/src/trace-routes.ts:268` 与 `:359`、`apps/collector/src/session-preflight.ts:59`，以及 `packages/adapters/tests/` 下两个测试。缓解：单文件是 `parts.length === 1` 的退化情形，改动是机械的。
- **bundle 放大了输入体积**。Codex 一个 forked rollout 就有 93% 是副本；去重必须发生在解析阶段而不是入库之后，否则 `IMPORT_UPLOAD_MAX_BYTES`（默认 64 MiB）会先被撑爆。
- **重生成改变 fixture 内容**，README 截图、契约测试计数与 `project/progress.md` 的既有记录都要同步更新，且必须在同一轮内完成。
- **`causationSourceEventId` 解析依赖同 trace 内的父事件已先行入库**。乱序导入时字段落 null 并留 warning，不重试、不阻塞；关系完整性由 reducer 按 `agentId` 与 span 兜底。
- **能力声明会过期**。六家全部在快速演进：Codex 在两个月内换过一整套多 agent 协议，opencode 的 join 信封在同一个数据库里就有两代。声明必须按 `(sourceKind, adapterVersion)` 生效，并在 adapter 升级时同步更新；`limits` 里的每一条都应指向 `research/spawn-formats/` 中的实测出处。

## 实施顺序

四轮，每轮结束时树是绿的：

1. **能力声明 + 快照 `topology`**（无破坏性变更，UI 立刻能诚实解释"为什么没有边"）。
2. **canonical 三项字段 + reducer 派生 + 边证据两列**（用重生成的自产录制验证图变成 DAG）。
3. **`AdapterInput` 改 bundle + Codex/Claude 两个 adapter**（覆盖两个 `stated` 且证据最完整的格式）。
4. **opencode / omp / grok 三个 adapter + `TraceSourceKind` 扩容**。

`pi` 全程无需 adapter 改动，只需声明为 `unsupported`。

## 参考

- [六个 Agent Harness 的 spawn 记录格式](research/agent-spawn-formats.md)——汇总与速查表。
- `research/spawn-formats/` 下六份逐 harness 原始报告——本文每一条格式断言的实测出处。
