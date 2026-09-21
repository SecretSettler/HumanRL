---
status: current
owner: product-design
last_reviewed: 2026-08-09
normative: true
milestone: post-Gate 5 import UX
---

# 聊天记录导入体验调研

## 调研范围与可复现性

参考项目：[getpaseo/paseo](https://github.com/getpaseo/paseo)，调研固定于 commit [`f2054cc701f4cdaa43b509331a393956bc67decc`](https://github.com/getpaseo/paseo/tree/f2054cc701f4cdaa43b509331a393956bc67decc)（2026-08-06）。Paseo 根 `LICENSE` 声明项目主体为 AGPLv3；IntentTrace 也是 `AGPL-3.0-only`。本次实现没有复制 Paseo 源文件或 UI 代码，只借鉴公开的交互/边界模式，并在本仓库重新实现。

重点阅读：

- [`packages/server/src/server/agent/import-sessions.ts`](https://github.com/getpaseo/paseo/blob/f2054cc701f4cdaa43b509331a393956bc67decc/packages/server/src/server/agent/import-sessions.ts)：listing/filter/sort/already-imported/selected import 边界；
- [`provider-session-import.ts`](https://github.com/getpaseo/paseo/blob/f2054cc701f4cdaa43b509331a393956bc67decc/packages/server/src/server/agent/provider-session-import.ts)：selected handle resume 后完整 history hydration；
- [`agent-sdk-types.ts`](https://github.com/getpaseo/paseo/blob/f2054cc701f4cdaa43b509331a393956bc67decc/packages/server/src/server/agent/agent-sdk-types.ts)：`ImportableProviderSession` 最小 descriptor；
- Claude `listImportableSessions`/`parseClaudeSessionDescriptor`：候选 overscan、首 prompt/cwd/session handle 提取；
- Codex `listImportableSessions`：优先使用 `thread/list` 的 cheap metadata，而非读完整 history；
- [`providers/pi/session-descriptor.ts`](https://github.com/getpaseo/paseo/blob/f2054cc701f4cdaa43b509331a393956bc67decc/packages/server/src/server/agent/providers/pi/session-descriptor.ts)：先按 mtime 排序、只解析 bounded recent window、head/tail bounded reads；
- [`import-session-sheet-view-model.ts`](https://github.com/getpaseo/paseo/blob/f2054cc701f4cdaa43b509331a393956bc67decc/packages/app/src/components/import-session-sheet-view-model.ts) 与 sheet：provider fan-out、dedupe、筛选、刷新、部分失败、已导入 empty state；
- [`import-session.opencode.real.spec.ts`](https://github.com/getpaseo/paseo/blob/f2054cc701f4cdaa43b509331a393956bc67decc/packages/app/e2e/browser/import-session.opencode.real.spec.ts)：真实 provider session 从 listing 到 UI import/history 可见的端到端证据。

## Paseo 的有效设计

### 1. Listing 与 import 分离

Picker listing 只返回 provider handle、cwd、title、first/last prompt preview 和 last activity。选择后 import 直接使用该 handle，不重新 listing。这样 UI 不持有完整历史，provider 能选择最便宜的 metadata 来源；只有用户选中的会话才 hydrate 完整 history。

### 2. Provider-owned discovery，统一 descriptor

Codex 使用 app-server `thread/list`；Claude/Pi/OMP 无同等 API 时读取持久化文件。不同发现方式在 provider 边界内统一为 descriptor，UI 不理解每种磁盘格式。可 pre-filter cwd 的 provider 尽早过滤，顶层再用 realpath-aware matcher 复核。

### 3. 有界近期窗口（仅 Pi provider）

复核后修正：只有 Pi provider 是 byte-bounded 的——`HEAD_BYTES = 64 KiB`、`TAIL_BYTES = 256 KiB`、`FULL_SCAN_LINE_LIMIT = 2000`、`candidateLimit = max(limit * 40, 400)`；它先遍历文件并按 mtime 排序，只解析 recent candidate window。Claude provider 则用 `readFile(…, "utf8")` 读取整份文件，并不 bounded。Claude 的 overscan 体现在 `limit + alreadyImportedCount` 的补偿式取数上：已导入的行会被过滤掉，所以先多取再裁剪，避免过滤后不足 limit。这对数百/数千会话目录比“全部完整 parse 后排序”更可靠，IntentTrace 因此照搬 Pi 的 64 KiB head 上限而不是 Claude 的整文件读取。

### 4. 失败隔离与显式状态

多 provider listing fan-out 时一个 provider 失败不清空其他结果；UI 区分全部失败、部分失败、loading、没有 provider、没有 recent session、全部已导入、当前 filter 无结果。空态优先级以 `allQueriesSettled` 为门：未 settled 前不显示任何空态，避免 loading 抖动出“没有会话”。已导入信号是 count-only 的 `filteredAlreadyImportedCount`，只用于把空态措辞从“没有可导入的会话”换成“都已经导入过”，不逐行回传身份。跨 provider dedupe 是 `provider:handle` 上的 first-wins。刷新是显式动作，不做隐藏轮询。

复核后修正三处此前的推测：Paseo 的 picker **没有**搜索框（sheet 显式传 `searchable={false}`）；**没有**多选（单行 press 直接导入，导入期间整个列表锁定）；**没有** retry-failed，也没有 per-file rejection 概念——解析失败的文件让 descriptor 返回 `null` 后直接从列表消失。它的 view-model 是纯函数加两个 `useState` 的薄状态，八个空/错状态全部可单测；IntentTrace 采用这个拆分方式，但在其上补齐搜索、多选、逐行失败与 retry-failed。

### 5. 重复与并发导入

Paseo 按 provider + providerHandle 过滤 active imported rows；导入 mutation 按 handle 串行化，再次导入 active owner 明确失败。archived session 有独立 restore/rollback 语义。selected import 完整 hydrate 后才发布 ready。

## 不直接采用的部分

| Paseo 行为                                        | IntentTrace 决定                                                                        | 原因                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| daemon 可从默认 provider home 发现 sessions       | 必须由 Collector 接收显式 `--path` 授权根                                               | API 无 auth 且 Compose 内不可访问宿主 home；ADR 0011 安全边界不可突破            |
| descriptor 默认携带 cwd/native provider handle    | stdout 只给 project basename hint 与 opaque catalog ID                                  | 真实绝对路径和 native session ID 不得进入日志/文档；选择器不应泄露身份           |
| picker 默认显示 prompt previews                   | CLI 默认不显示，只有 `--include-previews` opt-in                                        | stdout/CI log 比受控 app sheet 更容易长期留存 payload 正文                       |
| import 的目标是可继续运行的 provider agent        | import 的目标是 immutable raw facts + derived semantic revisions                        | IntentTrace 不恢复执行权限，也不让 provider history 替代 raw ingestion authority |
| archived agent 可 reimport/restore                | raw facts始终幂等 append，semantic revision另行派生                                     | IntentTrace 没有 provider agent ownership 生命周期                               |
| provider process API 优先（如 Codex thread/list） | 当前仍解析显式文件；未来可新增 provider metadata helper，但不能读取 auth 或恢复 session | Collector 应保持离线、无 provider egress、无执行权限                             |

## IntentTrace 目标体验

### CLI v1（本次实现）

```bash
# 默认 catalog 不输出 prompt 正文
intenttrace discover --source codex --path ~/.codex/sessions --limit 50

# 操作者显式同意后显示 bounded visible preview
intenttrace discover --source codex --path ~/.codex/sessions --limit 50 --include-previews

# 精确选择，可重复 --session
SESSION_ID_1="paste-24-character-catalog-id"
SESSION_ID_2="paste-24-character-catalog-id"
intenttrace import --source codex --path ~/.codex/sessions \
  --session "$SESSION_ID_1" --session "$SESSION_ID_2" --api "$WEB_ORIGIN"

# 不指定 --session 时仍是批量导入；--newest 配合 --max-files 只取最近若干文件
intenttrace import --source claude --path ~/.claude/projects \
  --newest --max-files 20 --api "$WEB_ORIGIN"
```

`SessionCatalog` version 1 包含：opaque ID、source、generic/preview title、project hint、first/last preview、last activity、mtime、bytes、event/warning counts、typed failed candidates、limit/unreadable/missing counts。绝对 path、relative path、file name、native session ID 不进入输出。ID 绑定授权 root、placement、inode/size/mtime，preflight 以 `O_NOFOLLOW` open 并在 read 前后复核，文件改变后旧 ID fail-visible。默认单文件上限 64 MiB。每个成功 import 另发 schema-validated path-free outcome（含 trace ID/inserted/duplicates/warnings），最后发聚合 summary，便于未来 UI 跳转与 retry-failed。

### 图形导入器（已实现：`/import`）

本轮实现了浏览器内的导入器，见 ADR [`0013`](../../decisions.md#adr-0013-browser-delivered-session-upload)。区别于原计划的 Tauri helper：它不需要本机 helper，因为浏览器的文件/目录选择器本身就是操作者显式交出字节的边界，服务端仍然不枚举任何目录。

`/import` 提供拖放、多文件选择与 `webkitdirectory` 目录选择三种入口，按 mtime 倒序（同 mtime 按文件名）排出最多 50 个候选，`name\0size\0lastModified` 上 first-wins 去重，每个文件只读前 64 KiB 交给 `POST /api/v1/imports/candidates`。返回的候选带 source chip、title、project hint、partial-head 标记与 already-imported 徽章；already-imported 由 `listTracesByIds` 一次批量查询得到，正是本文此前记为“该接口本轮未实现”的部分。preview 是显式 consent toggle，默认关闭，打开后重新请求。导入用 2 路并发把原始 `File` 直接 `POST /api/v1/imports/sessions`，逐行失败不影响其他行，失败行可 retry-failed。视图逻辑集中在无 React 依赖的 `apps/web/lib/import/view-model.ts`，组件只保留 rows/phase/query/sourceFilter/hideImported/showPreviews/inspectError 少量状态。

仍然禁止的是**服务端**目录选择器：Web server 不扫描目录，API 也不接受路径参数。CLI 命令保留在 `/traces` 空态的 headless 区块里，供批量与无头场景使用。

## 验收维度

- 目录 1,000+ 文件时先 metadata sort，再只 parse limit/selected candidates；
- discovery 发起 0 个 API 请求；默认 stdout 不包含授权 root、cwd、relative path、native session ID、文件名或 prompt；
- preview 只来自 adapter 已允许的 visible user content，长度不超过 160；
- malformed tail 在发送第一条 event 前被发现，该 candidate 插入数为 0；
- stale/unknown catalog ID 不回退到全量 import；
- batch 中一个 candidate 失败不阻止其他 candidate；
- 同文件重试保持 raw identity 幂等，completion marker 仍由 content hash 派生；
- future UI 的截图/自动化只能使用 synthetic fixtures。
