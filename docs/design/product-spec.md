---
status: accepted
owner: product
last_reviewed: 2026-08-10
normative: true
milestone: Gate 0-Gate 5
---

# 产品与交互规格

产品规格定义 IntentTrace 做什么、首发边界与非目标；交互规格定义页面清单、各视图的联动规则与可访问性要求。两节共享同一组非目标，交互实现不得越过产品规格的边界。

## 产品规格

IntentTrace 把不可变多 Agent 执行事件转换为可回放、可验证、可重建的 Evidence-backed Intent Graph。它不替代 tracing，也不推断或展示隐藏 chain-of-thought。

核心用户任务是：从 trace 列表进入一次执行；在 Raw Inspector 与 Agent Gantt 中查看事实；用语义图理解目标、工作、问题、修复、handoff 与结果；在 Evidence Inspector 中逐条验证 claim；按 ingest/revision watermark 回放“当时已知”的状态。

首发是 Linux x86_64 单主机、本地单用户、loopback、无认证；Gate 1–5 的本地 MVP implementation 已进入仓库。macOS 通过 Tauri 壳启动同一 Docker 栈，仍需 Docker Desktop；签名/公证是独立发布证据。真实 provider adapter 已实现但默认不联网，只有显式 egress、key、model、预算和 allowlisted host 同时存在才会调用。

MVP 输入覆盖 canonical JSONL、OTLP/HTTP JSON、Codex 和 Claude session；三种行分隔 source（canonical JSONL、Codex、Claude）现在同时接受行分隔 JSONL、顶层 JSON 数组和单个 pretty-printed JSON 对象，OTLP 一直是整文档 JSON 且仍要求根为对象。Codex/Claude 支持显式授权根内的 discover → opaque selection → import，以及显式单文件 follow。此外操作者可以直接在浏览器里选择文件或目录，由 `/import` 上传给本机 API 导入；同一份文件无论走 CLI 还是浏览器都得到相同 trace 身份，重复导入是幂等的。guided catalog 与浏览器候选列表默认都不披露 prompt/path/native session identity，preview 必须 opt-in。raw-only 必须在 worker、Redis 或 provider 不可用时继续浏览。正式 UI 只使用 `high|medium|low` 证据等级，不展示伪精确百分比。

非目标：公网 SaaS、auth/RBAC、多租户、OTLP gRPC、Kubernetes、图数据库、ClickHouse、Temporal、embedding、跨 run comparison、移动端。小于 1024px 只给有限只读/桌面提示；1440×900 是正式基线。

## 交互规格

入口就是 trace 列表：`/` 直接重定向到 `/traces`，不再有独立的营销式首页。该入口页清楚标注 local MVP、默认无云 egress、single-host/no-auth 边界、真实 session 只在操作者显式选择文件或目录后才由本机 API 解析（服务端不扫描任何目录），并提供 historical prototype 入口。页面清单：`/traces` 列表、`/traces/{traceId}` workbench、`/import` 浏览器导入、`/prototype` 历史原型；`/traces` 与 `/import` 共享同一 header 与 boundary bar。

**浏览器**文件/目录选择器现在是真实能力：`/import` 用 `<input type="file">`、`webkitdirectory` 目录选择和拖放接收操作者交出的字节，只读每个文件前 64 KiB 生成 ranked、deduped、already-imported-aware 的候选列表，再逐个上传。**服务端**目录选择器仍然被禁止——不能把“扫描整个 home”或任何由服务端枚举宿主目录的界面描述为已有能力。prompt preview 是显式 consent toggle，默认关闭，打开后才重新请求候选检查。空态按优先级区分“当前筛选没有匹配的会话”“所选会话都已经导入过”和“没有可导入的会话”，不把三者混成一句。`/traces` 空态给出浏览器导入主行动，并把 CLI `discover` → opaque catalog ID → `import` 收进可展开的 headless 区块。未来 Tauri guided picker 必须消费同一 versioned catalog/progress 协议。原型页带“非产品、非测试证据”警示，不执行原 HTML 中的 mock 行为。

当前桌面布局包含 trace nav、Graph、Evidence Inspector、Agent Gantt、raw table 和 replay bar。Graph、Gantt 和 Inspector 共享稳定 logical/event ID：选择 graph node 会打开 evidence，claim evidence 可定位 raw event，Gantt/raw 共用 event selection。Live/Final/stale revision 显示在图标题；pending chunk 只有确定性 SSE ghost，不显示未验证 provider 节点。

Raw table 必须沿 `nextCursor` 加载完整事件集，不能静默停在前 1,000 条。事件行显示 canonical readable preview；选择任一 raw/Gantt/evidence event 后，Inspector 读取其 `payloadRef` 并以 text-only `<pre>` 展示完整脱敏 JSON，同时提供独立 artifact 链接。超过 8 MiB 的 payload 明确标记 inline truncation。SSE 历史补发必须批量节流刷新，不能为每条历史 event 重取完整 snapshot。

Replay 的游标是 `ingestSeq`/revision commit watermark，source time 仅用于 Gantt 坐标。断线恢复期间显示“正在补发”；cursor 过期要明确要求快照重载。键盘必须能切换视图、遍历节点、打开/关闭 Inspector；200% zoom 不遮挡主要控制；`prefers-reduced-motion` 下禁用非必要动画。

1024–1279px 把 Inspector 改为抽屉；小于 1024px 显示只读摘要和桌面提示。颜色不能是状态的唯一载体，所有图形实体需可聚焦且有可读名称。
