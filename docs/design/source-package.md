---
status: accepted
owner: architecture
last_reviewed: 2026-08-01
normative: true
milestone: Gate 0
---

# 原始设计包登记

原始 `IntentTrace_Design_Package.zip` 按字节保存在 [`source/`](source/)；总包 SHA-256 是 `947efe8970e2cf29b8bf1334da927d1b888364b1480d81f4687b0e0deb0c580d`。解包内容位于 `source/package/intenttrace_design/`，逐文件哈希见 `source/manifest.sha256`。`docs:check` 会验证总包和清单，任何变化都必须作为新的历史版本导入，禁止覆盖 v0.1。

设计包是 historical reference。HTML/PNG 中的服务连接、成本、置信度、模型和测试结果均为 mock；原 prompt 与 JSON Schema 也不再是规范契约。当前事实以 `packages/schema`、`packages/db`、migration、生成 OpenAPI 和 Accepted ADR 为准。

审阅后保留：ETG/EIG 双层模型、evidence-backed 语义、LLM patch + deterministic reducer、Graph/Gantt/Evidence/replay 稳定 ID。明确偏离：MinIO 不作为默认依赖；完整 semantic UI、provider、2,000-event fixture 延后到对应 Gate；原型不复制进生产 React。
