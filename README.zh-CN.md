# HumanRL

HumanRL 给用 Codex 或 Claude Code 的人看自己的 prompt 写得怎么样。把一个 session（或自带的 demo）导进去，它按 trace 列出：每次 tool call 干了什么、agent 在哪里 spawn 了子 agent、每次 spawn 值不值那些 token，以及 prompt 里哪句话造成了浪费。界面是英文的。

它建在 [IntentTrace](https://github.com/chivier/IntentTrace) 上，保留 IntentTrace 的全部功能（只追加的 raw event、Intent Graph、Agent Gantt、回放滑块、Evidence Inspector），数据不出本机。

![HumanRL 打开自带的九 lane IMO demo：左边 Execution story，右边带证据的 Prompt review](docs/assets/humanrl-demo.png)

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/SecretSettler/HumanRL/main/install.sh | bash
```

这一行把仓库 clone 到 `~/HumanRL`、装依赖、把 `humanrl` 命令放进 PATH、启动 PostgreSQL、api、worker、web，导入 demo trace，然后在浏览器里打开。事先只需要 `git` 和 Node.js（推荐 24，22 能跑）；缺哪个，脚本会说。

## 用法

```bash
humanrl codex        # 导入你最近一次 Codex session 并打开
humanrl claude       # 最近一次 Claude Code session
humanrl claude 3     # 最近三次
humanrl              # 打开 demo（没起的话先起）
humanrl status       # 在不在跑，以及你有哪些 trace
humanrl stop
```

`humanrl import <文件或目录>` 导入任意 session。来源按路径猜，猜不到就加 `--source codex|claude|opencode|omp|grok`。Codex 从 `~/.codex/sessions` 读，Claude Code 从 `~/.claude/projects` 读，`HUMANRL_CODEX_DIR` / `HUMANRL_CLAUDE_DIR` 可以改。超过 64 MiB 的 session 会跳过并提示。导入时会去掉隐藏推理、加密内容和主机路径，再写库。

在仓库目录里同样的命令是 `pnpm humanrl codex`、`pnpm humanrl stop` 等。PostgreSQL 依次尝试 Docker Compose、`docker run`、Homebrew 的 `postgresql@17`、已有的 `DATABASE_URL`。日志在 `.intenttrace/logs/`。`HUMANRL_DIR` 改 clone 位置，`HUMANRL_NO_OPEN=1` 不开浏览器。

## 页面怎么看

**Execution story**（左）是一条从上往下读的运行记录：

- `▸ User request` 是你的 prompt，`… Agent said` 是 agent 在动作之间跟你说的话。
- `✓ read ×4 · Reading parallel dispatch skill +3` 是一个 agent 连续用同一个工具四次。点一下展开四次调用，再点单次调用，右边 Evidence Inspector 打开它的原始事件和 sanitized payload。`!` 表示失败。
- `⑂ spawn · Orchestrator → 3 child agents · Paid off` 是一次派发子 agent，带结论。
- `⇤ ImoBruteForce finished, joined by Orchestrator` 是子 agent 回来了。
- 左边框颜色是 agent 的 lane，和下面 Gantt 同色。

**Prompt review**（右上）显示你发的 prompt 和它造成的每一件事。`Fix` 是实际浪费了 token 的问题，`Improve` 是可以改的写法，`Note` 是背景信息。每条都有 **Show evidence**，直接打开背后的原始事件。

**Prompt optimizer** 回答“在当前回放位置，根 agent 现在该不该 spawn”，**spawn ledger** 给已经发生的每次 spawn 打分。拖面板下面的 watermark 滑块，整个面板跟着回放：第一次 spawn 之前是 Hold（没信号），中途是 Hold（子 agent 还没回来），结束后是复盘。

## 两个真实的例子

**自带的 demo** 是一次录下来的运行：orchestrator 用八个并行子 agent 解 IMO 2025 P1（691 事件，9 个 lane）。prompt 只有一句中文：“帮我使用 subagent 解决一个 IMO bench 中的数学题，注意一定要使用 skill + subagent 并发，让 trace 真实且复杂。” review 给出：

|         | 发现                                                                            | 对 prompt 意味着什么                                                                                          |
| ------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Fix     | agent 去调了 3 个不存在的工具：`eval`、`write`、`bash`（2 个 lane 里 5 次失败） | prompt 暗示要机器验证，环境里没有代码运行器。写清楚有哪些工具。                                               |
| Improve | prompt 约 69 token，orchestrator 自己写了约 2400 token 的任务分配来补它没说的   | Show evidence 打开 #29：交付路径、切片、约束、停止条件都是 orchestrator 自己写的。那段文字才是该发的 prompt。 |
| Note    | 78% 的委派工作给了 "Scouting UI, ingest, docs conventions"                      | prompt 第一句关于截图的话把八个 agent 里的三个拉去看仓库而不是做数学。支线该单独开一个 prompt。               |
| Improve | 4 个动作在多个 lane 重复                                                        | 两个 scout 都读了截图脚本，切片有重叠。                                                                       |
| Note    | 最后一个子 agent 回来后 orchestrator 又跑了 14 轮                               | 组装发生在它最重的上下文里。                                                                                  |
| Note    | 委派划算：3 波、8 个 agent，净省 ≥41k token 没进 orchestrator 上下文            | 并行结构本身是对的。                                                                                          |

**一次单 agent 的 Codex session**（搭这个仓库的那次，用 `humanrl codex` 导入）是另一种运行：单 agent、没有子 agent、45 次 `exec`。记录压成“用户提问 → agent 说打算怎么做 → 8 条命令 → agent 汇报 → 14 条命令 → …”，每次 `exec` 显示它跑的 shell 命令，而不是 Codex 记录的 JavaScript 外壳。review 只有一条 note：_Everything ran in one context: 45 tool calls, 48 turns, no subagent_，指出两个仓库的阅读是独立的，一个仓库一个 scout 就能把那些输出挡在主上下文外。

## 判断规则

Prompt review 的八条检查规则见英文 README 里的表格，代码在 [`apps/web/lib/workbench/prompt-review.ts`](apps/web/lib/workbench/prompt-review.ts)。优化器的两条规则在 [`apps/web/lib/workbench/prompt-optimizer.ts`](apps/web/lib/workbench/prompt-optimizer.ts)：

**现在 spawn 还是 hold（前瞻）。** 只有根 lane 出现证据缺口或上下文压力时，子 Agent 的新上下文才划算：工具失败（把排查隔离出去）、重复的相同工具调用（根 Agent 在打转）、或者已经累计超过六轮 model call。这些信号折算的预计节省，和一个子 Agent 的成本（固定开销加一段任务复述）比大小。只要还有子 Agent 没 join，或者 trace 已经结束，结论一律是 `Hold`，不重复派发。

**那次 spawn 值不值（回顾）。** 对每个 `agent_handoff`，子 lane 里的 tool result 和 model 轮次就是没进父 Agent 上下文的量，算作节省；子 Agent 的固定上下文加任务分配算作成本。净值 ≥ 成本是 Paid off，≥ 0 是 Marginal，负数是 Wasted，还没有子 Agent 启动的是 Pending。

所有 token 数都是按事件数、名字长度和 payload 大小估的下限（中文按一字一 token），用来比大小，不是账单。没有 `model_call` 事件的 adapter（Codex）用 agent 的叙述加 tool call 数当轮数。记录本身的推导在 [`apps/web/lib/workbench/execution-story.ts`](apps/web/lib/workbench/execution-story.ts)，界面在 [`apps/web/components/workbench/ExecutionStoryPanel.tsx`](apps/web/components/workbench/ExecutionStoryPanel.tsx)。

## 手动跑

`pnpm humanrl:up` 就是下面这些的合集。IntentTrace 的 Docker 路径（`pnpm docker:up`、`pnpm demo:load`）没有变；宿主机路径：

```bash
corepack pnpm --filter './packages/*' build
set -a; source .env.example; set +a          # DATABASE_URL 指向 127.0.0.1:15432
corepack pnpm --filter @intenttrace/db migrate
corepack pnpm --filter @intenttrace/api dev &
corepack pnpm --filter @intenttrace/worker dev &
corepack pnpm --filter @intenttrace/web dev --hostname 127.0.0.1 --port 3000 &
INTENTTRACE_WEB_ORIGIN=http://127.0.0.1:3000 corepack pnpm demo:load
```

## 致谢

HumanRL 建立在 **[Chivier Humber](https://github.com/chivier)** 的 **[IntentTrace](https://github.com/chivier/IntentTrace)** 之上。只追加的事件模型、Codex/Claude/OpenCode/OMP/Grok 各个 adapter、Intent Graph 背后的确定性 reducer、Agent Gantt、回放 watermark 和 Evidence Inspector 都是 IntentTrace 的工作，这里从 commit [`5de3e42`](https://github.com/chivier/IntentTrace/commit/5de3e428e36c3b1286bd069edd32ac75742aed7a) 原样搬入。HumanRL 只在上面加了 Execution story、prompt review 和 spawn 核算。

IntentTrace © 2026 Chivier Humber，以 GNU Affero General Public License v3.0 only 发布；HumanRL 作为衍生作品沿用同一许可证（见 [`LICENSE`](LICENSE) 和 [`NOTICE`](NOTICE)）。IntentTrace 自己的 README 原样保存在 [`UPSTREAM-README.zh-CN.md`](UPSTREAM-README.zh-CN.md)（[English](UPSTREAM-README.md)），里面的快速开始、架构、导入、安全和贡献说明在这里同样适用。觉得这套 trace 模型有用，请给上游项目加星和引用。上面这几块面板的 bug 报到这里，adapter、reducer、API 的 bug 报到上游。
