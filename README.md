# struct_cache_opt

> **高校研究 / 教学项目** —— 探索"让 AI 自动进化一个优化 skill,再由 AI 用这个
> skill 去优化真实(闭源)C++ 项目的结构体内存布局"的完整闭环。
>
> 项目同时是一个可复现的**研究平台**和一个**教学案例**:它把"AI 自我改进"
> (meta-loop 进化 skill)与"AI 应用工具改进代码"(inner-loop 用 skill 优化
> C++ 结构体)这两层学习过程,做成了可观测、可度量、可回放的工程系统。

## 一句话概括

每一轮,一个 LLM(`struct_cache_opt` skill)针对 ANGLE 的热点结构体
`vk::ImageHelper` 提议一个**字段重排 diff** → 自动重建 ANGLE → 在真实 GPU
负载下用 `perf stat` 抓 `cycles` / `cache-misses` / `dTLB-load-misses` → 把这些
计数器写进 commit body → 若 `cache-misses` 优于历史最好则保留,否则 `git revert`。

外层再用一个 **meta-loop** 把"这个 skill 本身"当成被优化对象,自动进化它。

## 三个核心特点

### 1. AI 自动优化(进化)一个 skill
外层 meta-loop 把 skill 自身(`prompt.tmpl`、pahole 辅助脚本等)当作优化目标:
每个 meta-iteration 提议一处 skill 改动 → 跑 N 个 inner 迭代评估 → 按多指标打分
(`meta_results.tsv`:总下降量、apply 率、keep 率、结构覆盖率、cv)→ 仅当胜出
才把新版本晋升为 "champion"。这就是"AI 改进 AI 工具"的那一层。

### 2. AI 使用这个 skill 优化 C++ 项目结构体
内层 inner-loop 把 skill 当工具:AI 读取结构体的 `pahole` 布局 + 历史结果,
提议字段重排 diff,在真实工程(ANGLE / Vulkan 后端)上构建并基准测试,用 cache
命中表现决定取舍。优化的是**真实 C++ 代码的内存布局**,而非玩具示例。

### 3. skill 开发 与 闭源 C++ 项目 完全隔离 ★
这是本项目的关键工程贡献:**优化器(skill)的演化** 与 **被优化的闭源 C++
项目** 各自独立、互不污染——

| | 仓库 / 位置 | 谁来改 | 隔离收益 |
|---|---|---|---|
| skill | `target_skill/struct_cache_opt`(独立 git) | meta-loop 演化、可单独提交回滚 | 改优化器无需碰 C++ 源码树 |
| C++ 项目 | ANGLE 检出(独立 git) | 仅接收 skill 产出的 diff,逐轮 commit/revert | 闭源工程保持纯净,可随时整体还原 |
| 引擎 | `autoresearch/`(本仓) | 居中协调,不持有任何一方源码 | 三者解耦,可各自替换 |

因此优化器可以在自己的仓库里自由迭代,而闭源 C++ 项目始终只通过"喂 diff +
基准 + 取舍"这一受控接口被修改——**工具的研发过程与被优化对象彻底分离**。

## 工作原理

### Inner loop —— 优化结构体(8 阶段管道)

TypeScript 后端(`autoresearch/`)对目标 git 仓(ANGLE 检出)逐轮执行:

| 阶段 | 作用 |
|------:|------|
| 0 | 初始化与环境准备(鉴权、git 配置) |
| 1 | **生成 diff** —— 调用 skill 的 `run.sh`,上下文 = `pahole` 布局 + git log + 近期结果 |
| 2 | **应用 diff** —— `git apply`,对幻觉行号用 `recount_diff.py` + `patch --fuzz` 兜底 |
| 3 | **构建** —— 重建 ANGLE(`libGLESv2`、`libEGL`) |
| 4 | **验证** —— 在 `perf stat` 下跑负载,解析指标 |
| 5 | **决策** —— perf 计数器 amend 进 commit;更优则保留,否则 `git revert` |
| 6 | **调度下一轮** —— 直到达到 `iterations` 或 `plateauPatience` |

结果追加到 `results.tsv`;Web 仪表盘(`Autoresearch Dashboard.html`,
`http://localhost:8080`)经 WebSocket 实时展示各阶段状态(WS 断开自动降级为 HTTP 轮询)。

### Meta loop(Phase 2)—— 优化优化器
见上文"特点 1",驱动脚本为 `scripts/meta-driver.sh` 与 `meta_*.py`。

## 仓库结构

| 路径 | 用途 |
|------|------|
| `autoresearch/` | TypeScript 引擎(`src/loop.ts`、`src/web.ts` …)及测试套件 |
| `scripts/` | meta-loop 驱动 + Python 打分/决策/diff 辅助(`meta-driver.sh`、`meta_*.py`、`recount_diff.py`) |
| `vk-image-helper.yml` | inner-loop 配置(workdir、scope、build/verify/ideate 命令) |
| `Autoresearch Dashboard.html` | 实时监控 UI |
| `loop_control/SKILL.md` | 工具无关的 skill,描述 agent 如何监督循环 |
| `how-to.md` | 完整操作指南(中文)—— 环境准备、各阶段、排错 |
| `docs/superpowers/` | 设计文档与实现计划 |
| `results.tsv` / `meta_results.tsv` | inner-loop / meta-loop 结果日志 |

## 快速开始

```bash
# 1. 安装后端
cd autoresearch
npm install            # 或 pnpm install

# 2. 跑测试套件
npm test

# 3. 启动服务器(用仓库根的配置)
npx tsx src/index.ts ../vk-image-helper.yml 2> ../loop.log &
```

随后打开 `http://localhost:8080/` 点击 **Start**;
`http://localhost:8080/?demo=1` 可在无后端时预览仪表盘 UI。

> **说明:** 完整运行需要配置好的环境——一份 ANGLE 检出、`struct_cache_opt`
> 目标 skill、GPU 负载(`angle_perftests`)与 `perf`。主机相关细节(WSL2 注意
> 事项、代理等)见 [`how-to.md`](how-to.md)。

## 依赖

- Node.js 20+(开发于 v22),含 `tsx`
- Python 3(meta-loop 打分与 diff recount 辅助)
- `git`、`perf`,以及可构建的 ANGLE 检出(真实优化运行所需)
