# Autoresearch Loop

TypeScript 最小闭环框架 + 浏览器仪表盘。一个常驻 PTY，7 阶段管道，
通过 WebSocket 实时展示执行状态、版本历史和阶段日志。

---

## 目录

- [前置依赖](#前置依赖)
- [安装](#安装)
- [配置](#配置)
- [启动仪表盘](#启动仪表盘)
- [运行循环](#运行循环)
- [Skill 配置](#skill-配置)
- [7 阶段管道说明](#7-阶段管道说明)
- [测试](#测试)
- [常见问题](#常见问题)

---

## 前置依赖

| 工具 | 版本 | 用途 |
|------|------|------|
| Node.js | ≥ 20 | 运行时 |
| pnpm | ≥ 9 | 包管理（或用 npm） |
| git | ≥ 2.40 | 版本管理，必须 |
| Python 3 | ≥ 3.10 | 可选，skill 脚本 |
| `node-pty` 编译依赖 | — | 见下方 |

### node-pty 编译依赖

```bash
# macOS
xcode-select --install

# Ubuntu / Debian
sudo apt install -y build-essential python3 libnode-dev

# RHEL / Fedora
sudo dnf install -y gcc-c++ python3 nodejs-devel
```

---

## 安装

```bash
# 1. 进入项目目录
cd autoresearch

# 2. 安装依赖（含 node-pty native 编译，约 30 秒）
pnpm install
# 或
npm install

# 3. 类型检查（零错为通过）
pnpm build
```

---

## 配置

复制并编辑示例配置：

```bash
cp autoresearch.yml my-project.yml
```

`my-project.yml` 关键字段说明：

```yaml
# ── 必填 ──────────────────────────────────────────────────
goal:    最小化 angle_perftests 的 cpu-cycles   # 人可读目标
remote:  ssh -tt user@build-host                # 远程机器（本地测试填空 ""）
workdir: /home/sean/angle                       # 目标仓库根目录

scope:                                          # 允许修改的文件前缀
  - src/libANGLE/State.h

# ── Skill（见下方 Skill 配置）─────────────────────────────
skillDir: /home/sean/.claude/skills/autoresearch   # SKILL.md 所在目录
# 等价于 ideatePrompt: ${skillDir}/run.sh

# ── 编译 / 测试 ───────────────────────────────────────────
guardCmd:  autoninja -C out/Release angle_perftests 2>&1 | tee stage-3.log
verifyCmd: |
  perf stat -e cpu-cycles ./out/Release/angle_perftests \
    --gtest_filter='*DrawQuad*' --iterations=100 2>&1 \
    | grep cpu-cycles | awk '{print $1}' | tr -d ','

# ── 可选 ──────────────────────────────────────────────────
setupCmds:
  - gh auth login --with-token < ~/.gh-token
  - export CCACHE_DIR=/home/sean/.ccache

diagCmd: grep -E "error:" stage-3.log | head -5

direction:       lower    # lower=越小越好，higher=越大越好
metricLabel:     cpu-cycles
iterations:      20
plateauPatience: 8
```

### 本地测试配置（无远程机器）

```yaml
remote:  ""              # 空字符串 = 本地运行
workdir: /tmp/my-target  # 本地 git 仓库
```

---

## 启动仪表盘

仪表盘是独立的 HTML 文件，无需构建：

```bash
# 方式 A：直接用浏览器打开（无 WebSocket，自动进入 demo 模式）
open Autoresearch\ Dashboard.html

# 方式 B：配合后端运行（实时 PTY + WebSocket）
cd /mnt/f/code2/struct_cache_opt/autoresearch
npx tsx src/index.ts ../vk-image-helper.yml
# 然后打开 http://localhost:8080
```

WebSocket 地址默认 `ws://localhost:8080`，可在 `src/web.ts` 修改端口。

---

## 运行循环

```bash
# 前台运行，stderr 实时打印 PTY 输出
tsx src/index.ts my-project.yml

# 后台运行，所有日志重定向到文件
tsx src/index.ts my-project.yml 2>loop.log &
echo $! > loop.pid

# 停止
kill $(cat loop.pid)
```

`results.tsv` 会自动创建在 `tsvPath` 指定位置，记录每轮 metric。

---

## Skill 配置

### 安装 autoresearch skill

```bash
# 全局安装（推荐）
npx skills add uditgoenka/autoresearch

# 或手动安装
git clone https://github.com/uditgoenka/autoresearch.git
cp -r autoresearch/.claude/skills/autoresearch ~/.claude/skills/autoresearch
```

### 配置 skillDir

```yaml
# autoresearch.yml
skillDir: /home/$USER/.claude/skills/autoresearch
```

框架自动调用 `${skillDir}/run.sh`。如果该文件不存在，需自行创建：

```bash
cat > ~/.claude/skills/autoresearch/run.sh << 'EOF'
#!/usr/bin/env bash
# stdin = context (git log + TSV tail)
# stdout = unified diff
claude --skill ~/.claude/skills/autoresearch/SKILL.md \
  -p "/autoresearch\nIterations: 1\n$(cat)"
EOF
chmod +x ~/.claude/skills/autoresearch/run.sh
```

### Stage 1 CLI Prompt

仪表盘中的 prompt 格式：

```
claude --skill /path/to/SKILL.md \
  -p "use <skillName> <scope (natural language)>"
```

示例：

```
claude --skill ~/.claude/skills/autoresearch/SKILL.md \
  -p "use struct_cache_opt optimize struct layout and cache alignment in the ANGLE rendering pipeline"
```

---

## 7 阶段管道说明

| 阶段 | 名称 | 日志文件 | 说明 |
|------|------|---------|------|
| 0 | Init & Copilot Login | stage-0.log | 用户手动确认鉴权 |
| 1 | Generate Diff | stage-1.log | CLI 调用 skill，stdout = unified diff |
| 2 | Apply Diff | stage-2.log | `git apply .ar.patch` |
| 3 | Build & Health Test | stage-3.log | guardCmd，编译日志重定向到文件 |
| 4 | Benchmark | stage-4.log | verifyCmd，stdout 末 token = metric |
| 5 | Extract Perf & Commit | stage-5.log | 提取 metric，`git commit` 归档所有日志 |
| 6 | Auto Search Schedule | stage-6.log | **递归调用 skill**（见下方） |

### Stage 6 递归模式

Stage 6 是整个闭环的调度器，将 git 历史 + TSV context 传回给同一个 skill：

```bash
# .ar-context.txt = git log -20 + tail(results.tsv, 20)
claude --skill ${SKILL_PATH}/SKILL.md \
  -p "/autoresearch\nIterations: 1\n$(cat .ar-context.txt)" \
  > .ar.patch
# → 回到 Stage 2
```

Skill 负责 Review / Pick / 生成 diff（autoresearch 前 3 步）；
框架负责 Apply / Build / Bench / Commit / Decide（后 5 步）。

---

## 测试

```bash
# 全部套件（约 2 分钟）
pnpm test

# 单独运行
pnpm test:log     # M2 logger 单元测试（11 cases）
pnpm test:term    # M1 terminal 单元测试（9 cases，需要 node-pty）
pnpm test:errors  # M4 8 条错误路径集成测试
```

M4 集成测试会在 `/tmp/ar-test-*` 创建临时 git 沙箱，测试结束自动清理。

---

## 常见问题

**Q: `node-pty` 编译失败**
```bash
# 重建 native 模块
pnpm rebuild node-pty
# 或指定 Python 路径
npm_config_python=/usr/bin/python3 pnpm install
```

**Q: terminal-dead 后循环停止**
- 检查 SSH 连接的 `ServerAliveInterval` 设置
- 增大 `autoresearch.yml` 中的 `verifyCmd` 超时（默认 30 min）
- 查看 `loop.log` 中的 `[terminal dead]` 行

**Q: verifyCmd 输出无法解析为 metric**
- metric 必须是 stdout **最后一个 token**，且为纯数字
- 用 `awk '{print $NF}'` 或 `tr -d ','` 去除逗号

**Q: Dry Run 模式**
- 在仪表盘顶栏勾选 `Dry Run` → Stage 1（调用 Copilot/LLM）被替换为 `cat <dryRunPatch>`，其余 Stage 2-5（apply / build / verify / commit）正常运行
- 在 `autoresearch.yml` 中配置 `dryRunPatch: /path/to/fake.patch`（路径在目标主机/workdir 内），仓库自带 `scripts/fixtures/fake.patch` 可参考
- TSV 中 dry-run 迭代的 `status` 被记为 `dry-run`，原本的 keep/discard/build-fail 等结果保留在 `desc` 字段（如 `keep/would-keep`、`discard/build-fail`），不影响 `bestSoFar` 计算
- 每次 dry-run 迭代结束都会 `git revert --no-edit HEAD`，不污染 git 历史
- 用途：验证 guardCmd / verifyCmd 管线是否正常，不消耗 LLM 额度

**Q: 如何从指定版本重新开始迭代**
1. 仪表盘右栏版本历史中点击目标 commit 的 **Apply this version**
2. 确认 `git reset --hard <hash>` 执行成功
3. 重启循环：`tsx src/index.ts my-project.yml`

---

## 文件结构

```
autoresearch/
├── README.md               ← 本文件
├── autoresearch.yml        ← 示例配置
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts            入口
│   ├── config.ts           YAML → Config
│   ├── terminal.ts         PTY 封装
│   ├── logger.ts           TSV 读写
│   ├── loop.ts             8 阶段主循环
│   └── web.ts              WebSocket 服务端
├── scripts/
│   ├── test-term.ts        terminal 单元测试
│   ├── test-log.ts         logger 单元测试
│   ├── test-errors.ts      8 条错误路径集成测试
│   ├── run-all-tests.sh    测试汇总脚本
│   └── fixtures/
│       └── fake.patch      本地沙箱用假 patch
Autoresearch Dashboard.html ← 仪表盘（双 terminal + 阶段管道）
Autoresearch Loop.html      ← 配置指南（5 个扩展点）
```
