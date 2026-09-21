---
status: accepted
owner: platform
last_reviewed: 2026-08-11
normative: true
milestone: post-Gate 5 runtime slimming
---

# 运行时瘦身与队列移除设计

> 本设计已实施完成，结论由 [ADR 0014](../../decisions.md#adr-0014-postgresql-single-source-job-scheduling) 承载。**本文件整体是改造前写下的设计记录**：全部八节——背景、目标与非目标、设计 A、设计 B、门禁影响清单、验证、风险与取舍、明确不做——记录的都是改造前的系统状态与当时的实施计划，没有任何一节描述当前系统。当前部署、契约与排障事实以 ADR 0014、[部署](../../operations.md#deployment) 与 [Runbook：Summary 作业队列](../../operations/runbooks.md#runbook-summary-job-queue) 为准。
>
> 实施过程中有三处结论被修正。正文按「设计记录不追改」保留原样，以 ADR 0014 为准：默认栈的计数单位是**镜像**而不是容器（两个镜像，五个 Compose 服务，`migrate` 为一次性）；跨主机 worker 并非技术上不可行，只是不再随栈提供现成路径（`claimSummaryJob` 是带条件的原子 `UPDATE`，对多消费者安全）；`/readyz` 在仓库内有两个消费者——Web 状态页与 Compose `api` healthcheck——且两者都只判断状态码，不读取 `dependencies` 结构。

## 背景

改造前，本地单用户 MVP 需要三个外部运行时依赖：Docker、PostgreSQL、Redis。复核后发现问题不在「用了 Docker」，而在镜像构建方式和一个不产生作用的中间层。三项证据：

**1. 镜像是 dev build 当 runtime 发。** `infra/Dockerfile` 是单阶段：`COPY . .` 之后 `pnpm install --frozen-lockfile --prod=false && pnpm build`。最终层包含整个 monorepo 源码与全部 dev 依赖（turbo、vitest、playwright、eslint、typescript、tsx、Tauri CLI）。实测镜像 1.18 GB，四个服务 tag 共享同一批 10 层，磁盘占用为一份。

**2. 已经构建好的 standalone 产物被忽略。** `apps/web/next.config.ts` 设了 `output: "standalone"`，构建出 42 MB 的 `.next/standalone`（含裁剪后的 node_modules），但当时 `docker-compose.yml` 的 web 命令是 `pnpm --filter @intenttrace/web start`，即 `next start`，走的是 647 MB 完整 `node_modules` 加 559 MB 完整 `.next`。

**3. Redis 是同进程内的空转往返。** `apps/worker/src/main.ts` 每 2 秒调用 `repository.listRunnableSummaryJobIds()` 从 PostgreSQL 取出待办，用 `queue.add()` 写入 Redis，再由同一进程内 `concurrency: 1` 的 BullMQ `Worker` 取回执行。

第 3 点的关键在于重试语义**完全不经过 BullMQ**：`failSummaryJob` 把作业置为 `status='failed'` 并设 `next_attempt_at = now() + 5s`；`listRunnableSummaryJobIds` 的查询同时捞取到期的 `pending`/`failed` 作业，以及 `status='running'` 且 `updated_at` 超过 5 分钟的作业（崩溃 worker 的收割）。BullMQ 侧未配置 `attempts`（默认 1 次）且 `removeOnComplete`/`removeOnFail` 均为 `true`。因此移除 BullMQ 不损失任何重试、退避或崩溃恢复行为。

此外改造前 `pnpm docker:up` 不可用：镜像内执行根 `pnpm build` 会连带构建 `@intenttrace/desktop`，其 bundle preflight 断言的 `apps/desktop/src-tauri/resources/intenttrace-stack.tar.gz` 由 gitignored 的 `desktop:prepare` 产出且被 `.dockerignore` 显式排除，构建必然以 `bundle resource is missing` 失败。

## 目标与非目标

**目标**：把默认栈从「1.18 GB 镜像 + postgres + redis 三容器」降到「瘦身镜像 + postgres 两容器」（见文首说明：计数单位应为镜像，此处措辞已被 ADR 0014 修订）；恢复 `pnpm docker:up`；删除 Redis 及其依赖、配置键、健康维度与威胁面。

**非目标**：不改变部署形态（仍是 Docker Compose）；不引入 embedded-postgres 或 npx 分发；不追求单文件二进制；不改变 worker 并发度；不动 adapter、API 业务路由或 Web 功能。

单文件二进制被 Next.js 16 阻断，不在本设计范围内：`next/dist/server/require.js` 以绝对路径加载每个 route，并显式标注 `turbopackIgnore: true`，Node SEA 与 `bun build --compile` 均无法吸收。该结论记录于此以免重复调研。

## 设计 A：多阶段镜像

### 构建阶段

沿用现有基础镜像与 pnpm 版本，安装完整依赖后构建，但排除桌面壳：

- `pnpm build --filter '!@intenttrace/desktop'` —— 这一处同时修复 `pnpm docker:up`。服务端镜像不应构建 macOS Tauri 外壳。
- 随后为三个 Node 入口产出自包含目录：`pnpm deploy --legacy --prod --filter <pkg> <out>`。

`--legacy` 是必需的。默认情况下 pnpm 10 起要求 `inject-workspace-packages=true`，否则报 `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`。全局开启注入会改变整个 workspace 的安装语义（workspace 依赖由符号链接改为硬链接复制，带来变更后的重建与 lockfile 影响），因此选择在 deploy 命令上加 `--legacy`，不改 `.npmrc`。

实测产物体积（当前依赖集，移除 Redis 前）：API 56 MB、worker 41 MB、db 25 MB（含 `migrations/`）。deploy 后的 `node_modules/@intenttrace/*` 指向虚拟store中的工作区包，`import('./dist/app.js')` 可正常解析出 `buildApp`。deploy 必须发生在 `pnpm build` 之后，否则工作区包的 `dist` 尚不存在。

### 运行时阶段

同一基础镜像，仅复制上述三个 deploy 目录，加上 Web 的三部分：`.next/standalone`、`.next/static`、`public`。Next 的 standalone 树在本仓库已是 monorepo 布局（`apps/web/server.js` 与提升的 `node_modules`，含 9 个内部符号链接），整树复制即可；`static` 与 `public` 需手动放置，Next 不会自动纳入。

运行时镜像不含 pnpm、源码、dev 依赖与 workspace 结构，因此 Compose 的 `command` 从 `pnpm --filter … start` 改为直接调用 node：

| 服务    | 命令                               |
| ------- | ---------------------------------- |
| migrate | `node packages/db/dist/migrate.js` |
| api     | `node apps/api/dist/main.js`       |
| worker  | `node apps/worker/dist/main.js`    |
| web     | `node apps/web/server.js`          |

`db:migrate` 使用 `drizzle-orm/postgres-js/migrator` 与 `packages/db/migrations`，运行时不需要 drizzle-kit。

Web 的监听方式随之变化：standalone `server.js` 读取 `PORT`（默认 3000）与 `HOSTNAME`（默认 `0.0.0.0`）环境变量，不接受 `--hostname` 参数。Compose 中改用环境变量表达，容器内仍监听 `0.0.0.0`，宿主映射仍只绑定 `127.0.0.1`，ADR 0009 的边界不变。

保留 `docker-compose.yml` 现有的 `x-app-build` 锚点结构：四个服务共用一个镜像，层继续共享。

### 可选收尾

各包 `package.json` 未声明 `files`，deploy 目录因此仍带 `src/`、`tests/`、`tsconfig*`。这属于次要优化，不作为本设计的验收条件。

## 设计 B：移除 Redis 与 BullMQ

### worker

`apps/worker/src/main.ts` 删除 `Queue`、`Worker` 与 `ioredis` 连接。作业处理体逐字保留，从 BullMQ 回调移入串行循环：仍是 2 秒轮询 `listRunnableSummaryJobIds()`，对每个 ID 依次执行 `claimSummaryJob` → provider → reducer → `commitSummaryJob`/`failSummaryJob`。并发保持 1，与现有 `concurrency: 1` 一致。

新增一个 in-flight 门：上一轮尚未跑完时跳过本次 tick，避免慢作业叠加。关停路径去掉 `worker.close()`/`queue.close()`/`redis.quit()`，改为等待当前作业结束后 `sql.end()`。

`apps/worker/src/policy.ts` 的队列常量随之调整为描述 PostgreSQL 作业表的策略常量，`SUMMARY_QUEUE_NAME` 由 `SUMMARY_POLL_INTERVAL_MS` 取代。

依赖移除：`bullmq`、`ioredis`。这同时移除 runtime 路径上的一个 native addon（`msgpackr-extract`，经由 `bullmq` → `msgpackr`）。

### API

`apps/api/src/main.ts` 删除 Redis 客户端与就绪探测；`readiness()` 只报告 PostgreSQL。

`apps/api/src/app.ts` 的 `ReadinessResult` 与 `ReadySchema.dependencies` 去掉 `redis` 字段。**这是一次已发布响应契约的变更**：`/readyz` 的 `dependencies` 从 `{ postgres, redis }` 变为 `{ postgres }`，需重新生成 OpenAPI 并更新 `apps/api/src/app.test.ts` 中的就绪用例。

取舍：不保留 `redis: "skipped"` 占位。仓库契约纪律要求生成的 OpenAPI 只暴露真实存在的东西，长期返回一个不存在的依赖项是不诚实的描述。

### 配置与基础设施

- `packages/config/src/index.ts` 删除 `REDIS_URL`，`.env.example` 同步删除。
- `docker-compose.yml` 删除 `redis` 服务、`REDIS_URL` 环境变量与 api/worker 的 `depends_on` 条目。
- 删除 `infra/Dockerfile.redis`。
- `infra/images.lock` 从三个 pinned image 减为两个。
- `.github/workflows/ci.yml` 删除 redis service 容器与 `REDIS_URL` 环境变量。
- `scripts/docker-stack.mjs` 的 `Internal only:` 提示去掉 `redis:6379`。
- `apps/desktop/frontend/index.html` 的说明文案去掉 Redis。

## 门禁影响清单

以下都是会直接导致检查失败的硬约束，实施时必须同批处理。全部由 grep 全仓核对得出，不是推测：

| 门禁                                                     | 影响                                                                                                                       | 处理                                                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/check-docs.mjs` image lock 断言                 | 要求 `infra/images.lock` 恰好三个 digest-pinned image，并逐一验证被四个消费者文件引用，其中之一是 `infra/Dockerfile.redis` | 改为两个；消费者列表移除 `Dockerfile.redis`（该文件将不存在，`readFile` 会直接抛错）                                           |
| `scripts/check-docs.mjs` baseline 版本断言               | `baselineVersions` 中有一条 `["apps/worker/package.json", "dependencies", "bullmq", "6.0.7"]`                              | 删除该条目                                                                                                                     |
| `scripts/check-compose.mjs`                              | 服务列表含 `redis`                                                                                                         | 移除该项                                                                                                                       |
| `docs/reference/configuration.md`                        | 每个 `packages/config` 配置键都必须出现在参考表中                                                                          | 删 `REDIS_URL` 行与末段的 `redis:6379` 说明                                                                                    |
| `apps/api/src/openapi.contract.test.ts` 与生成的 OpenAPI | `/readyz` 响应形状变更                                                                                                     | `pnpm schema:generate` 后提交                                                                                                  |
| `docs/operations/runbooks/queue-and-dlq.md`              | 属于 `docs:check` 的必需文件，不能删除                                                                                     | 重写为 PostgreSQL 作业表排障手册：`summary_jobs` 状态机、`next_attempt_at` 退避、5 分钟 `running` 收割、如何手工重置卡住的作业 |

### ADR 处理

三个已 Accepted 的 ADR 提到 Redis/BullMQ：[`0006`](../../decisions.md#adr-0006-postgresql-idempotency-and-outbox)（BullMQ 按 at-least-once 使用）、[`0008`](../../decisions.md#adr-0008-pnpm-typescript-monorepo)（组成中列出 BullMQ worker）、[`0009`](../../decisions.md#adr-0009-local-single-user-and-loopback)（Redis 只在私有 bridge 内可达）。按仓库规则「ADR 一旦 Accepted 不改写结论」，三者均不修改，由新建的 ADR 0014 统一 supersede 这三处与队列相关的条款，并明确保留 0006 的 PostgreSQL 幂等/outbox 结论与 0009 的 loopback 边界结论。

### 必须改写的规范文档

这些句子在改动后会变成对系统的错误描述：

| 文件                                            | 内容                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `docs/architecture/overview.md`                 | 「Redis/BullMQ 只做投递」与「Worker 消费 BullMQ 任务」                                  |
| `docs/architecture/invariants.md`               | 不变量 8「worker/Redis/provider 故障不破坏已入库 raw 查询」                             |
| `docs/architecture/data-flow-and-sequences.md`  | 语义链路末端的「BullMQ ack」                                                            |
| `docs/development/getting-started.md`           | 内部端口拓扑含 6379                                                                     |
| `docs/development/repository-guide.md`          | 「`infra` 保存 Compose、Redis 配置和 image lock」                                       |
| `docs/operations/deployment.md`                 | 服务拓扑，以及整段 Redis AOF / `protected-mode` 说明                                    |
| `docs/operations/observability.md`              | `/readyz`（PostgreSQL/Redis）与「Redis 故障不应把已入库 trace 标丢失」                  |
| `docs/operations/backup-restore.md`             | 「Redis/AOF 可不作为权威备份，但恢复后需从 DB commands/outbox 重建投递」                |
| `docs/operations/runbooks/datastore-failure.md` | 「Redis 失败只暂停异步投递」                                                            |
| `docs/testing/strategy.md`                      | integration 使用真实 Redis；Docker 环境执行 Redis outage                                |
| `docs/testing/acceptance-matrix.md`             | 「Redis/worker/provider outage」一行                                                    |
| `docs/testing/performance-methodology.md`       | 基准环境固定 Redis image digest                                                         |
| `docs/project/risk-register.md`                 | 风险 R6「Redis/worker/provider 故障阻断 raw」                                           |
| `README.md`                                     | 私有网络说明、架构图中的 `BullMQ worker`、目录树中的 `worker/ BullMQ semantic pipeline` |

### 明确不改写的文档

以下提到 Redis/BullMQ 但属于历史记录，改写等同于篡改证据：

- `docs/project/progress.md` 既有条目（Gate 3 的 BullMQ dispatch、「停止 Redis 和 worker 后 raw query 返回 200」等环境观测）。只在 Implemented / Automated verified / Environment verified 追加本轮新条目。
- `docs/project/construction-plan.md` 的 Gate 2/Gate 3 退出标准与达成记录。
- `docs/project/release-readiness.md` 的历史勾选项。
- `docs/design/source/**`：历史输入，且被 `docs:check` 的 normative 扫描显式排除。

`docs/contracts/event-ordering-idempotency.md` 中「`ingestSeq` 不能由 Redis 或进程内计数器承担」这条约束在改动后依然成立且更强，无需修改。

## 验证

- `pnpm docker:up` 与 `pnpm docker:url` 跑通，这本身即是 `docker:up` 修复的回归证据。
- `docker images` 记录改造前后体积；当前基线 1.18 GB。目标为显著下降，具体数值以实测为准，不预先承诺。
- `pnpm demo:load` 在无 Redis 的栈上导入固定 seed 的六 Agent fixture，确认 worker 仍能领取作业并提交 revision，最终 watermark 与节点数与既有环境证据一致。
- 针对性验证重试路径：构造一个会失败的作业，确认它按 `next_attempt_at` 被重新领取，而不是永久停滞。
- 复跑本轮的浏览器导入 smoke（`/import` 选择 fixture → 导入 → 重复导入幂等 → `View trace`），确认瘦身镜像下 Web 与 API 行为不变。
- 全套门禁：`format:check`、`lint`、`typecheck`、`test`、`test:contract`、`test:e2e`、`build`、`docs:check`、`schema:check`、`docker:check`。

## 风险与取舍

**放弃跨进程/跨主机 worker。** 移除队列后，worker 与 API 只能靠共享数据库协调，无法再把 worker 拆到独立主机水平扩展（见文首说明：此结论已被 ADR 0014 修订）。ADR 0009 明确首发为单主机单用户，这是可接受的 YAGNI 取舍；若将来需要，PostgreSQL 作业表本就支持多消费者（`claimSummaryJob` 是带条件的原子 `UPDATE`），届时可再引入队列或直接多进程竞争同一张表。

**轮询延迟。** 作业最长等待 2 秒才被发现。当前 BullMQ 路径同样受这个 2 秒轮询限制，因此不是回退。

**`/readyz` 契约变更。** 任何依赖 `dependencies.redis` 的外部消费者会受影响。当前仅本仓库 Web 状态页消费该端点（见文首说明：此结论已被 ADR 0014 修订），风险局限于仓库内。

**`--legacy` deploy。** 依赖一个 pnpm 兼容开关。若未来 pnpm 移除该 flag，替代方案是开启 `inject-workspace-packages=true` 或改用 `pnpm --filter --prod deploy` 的后继实现，属于可控的构建期问题，不影响运行时。

## 明确不做

- 不引入 PGlite 替换运行时数据库。实测其为单 backend：一个连接持有事务会阻塞其他所有连接（实测 1998 ms），事务内 await 另一连接会永久死锁且队列无超时，`fsync` 硬编码关闭。本仓库 `ingestTransaction` 使用 `select … for update`，正是会踩中的形状。PGlite 适合的位置是 CI 集成测试（已验证可跑通本仓库的四个 drizzle 迁移，Postgres 18.3），另行评估。
- 不引入 embedded-postgres 或 npx 分发。属于后续 tier，需独立设计与环境证据。
- 不做单文件二进制。理由见「目标与非目标」。
