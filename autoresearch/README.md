# Autoresearch Loop

TypeScript 最小闭环框架 + 浏览器仪表盘。两个 PTY,7 阶段管道,
通过 WebSocket 实时展示执行状态、版本历史和阶段日志。

**Dashboard 双终端布局**(2026-05 起):

- **Loop / Stage 1 LLM 输出 (read-only)** — 顶部面板,镜像所有 stderr
  (loopTerm 的 PTY 字节 + `[iter N] stage M: …` 等 console.error 行),
  内容跟 `loop.log` 完全一致,无需另开 `tail -F`。
- **CLI** — 底部面板,真正的交互式 bash,用于 `claude login`、调试命令、
  手动 `gh auth` 等。Loop 自动化跑在隐藏的 `loopTerm`,不会跟用户
  键入冲突。

---

## 目录

- [新机器部署](#新机器部署)
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

## 新机器部署

把整个目录复制到新机器后,从 0 跑通需要的最小步骤。本节假设你已经
拿到 `struct_cache_opt.tar.gz` 这种归档(node_modules / out / loop.log
都被排除掉了)。

```bash
# 1. 解压到工作目录
tar -xzf struct_cache_opt.tar.gz -C ~/workspace
cd ~/workspace/struct_cache_opt

# 2. 系统依赖 (Ubuntu / WSL2)
sudo apt update
sudo apt install -y nodejs npm git build-essential python3 \
                    libnode-dev curl
# Node 必须 ≥ 20。如系统仓库版本过旧,装 nvm:
#   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
#   nvm install 22 && nvm use 22

# 3. 安装项目依赖 (含 node-pty 原生编译,约 30 秒)
cd autoresearch
npm install      # 或 pnpm install

# 4. 类型检查 (零错通过即可启动)
npx tsc --noEmit

# 5. 准备目标仓库 (示例: ANGLE)
git clone https://chromium.googlesource.com/angle/angle ~/angle
cd ~/angle && python3 scripts/bootstrap.py
gn gen out/Release --args='is_debug=false'
gn gen out/Debug-pahole --args='is_debug=true symbol_level=2'

# 6. 准备 target_skill (LLM-driven diff generator)
git clone <skill-repo> /path/to/target_skill
# 或解压同捆的 target_skill/ 目录到任意位置

# 7. 配置 yml (修改 workdir / skillDir / paths)
cp ../vk-image-helper.yml.example ../my-project.yml
$EDITOR ../my-project.yml

# 8. (可选) 鉴权 LLM CLI — 在 dashboard 启动后,通过 CLI 终端跑
#    `claude login`;loop 会等你点 Start 才开始
```

### 路径假设(可按需修改 yml)

| 用途 | 默认路径 | 说明 |
|---|---|---|
| 目标仓库 (workdir) | `/home/$USER/angle` | yml 里 `workdir` 字段 |
| target skill | `/mnt/f/code2/target_skill/struct_cache_opt` | yml 里 `skillDir` |
| gfxbench (可选) | `/home/$USER/work/gfxbench/tfw-pkg` | 真实指标用 |
| ccache | `$HOME/.ccache` | `setupCmds` 里导出 |
| depot_tools | `/home/$USER/depot_tools` | yml 里 `AR_DEPOT_TOOLS` env |

### WSL2 已知坑

- **`perf`**:stock 包是 wrapper,装 `linux-tools-standard-WSL2`
  否则报 `perf not found for kernel x.y`
- **gfxbench `testfw_app`**:WSLg 下 X11 窗口尺寸可能 0x0,在真 Linux
  桌面或带显示的容器内跑才稳
- **`pahole`**:1.31 版本对 ANGLE 的某些 class-type DIE 解析不完整,
  目前用 `size vk_helpers.o` 的 `.text` 字节数做 proxy 指标(见
  `vk-image-helper.yml:65-82` 的注释)

### 端口

Dashboard 默认 `http://localhost:8080`,环境变量 `AR_PORT=8181 npx tsx …`
可改。WebSocket 跟 HTTP 共用同一端口。

---

## 运维速查 — 启停 / 状态 / 日志 / diff

> 路径假定:repo 根 = `/mnt/f/code2/struct_cache_opt`(下文用 `$REPO`),
> `workdir` = `/home/$USER/angle`(yml 里设)。换机器了请整体替换。

### 启动 (后台)

```bash
cd "$REPO/autoresearch"
nohup node node_modules/tsx/dist/cli.mjs src/index.ts ../vk-image-helper.yml \
  > /dev/null 2>> "$REPO/loop.log" < /dev/null & disown
echo $! > "$REPO/loop.pid"

# 4 秒后验端口
sleep 4 && ss -tlnp 2>/dev/null | grep 8080 && echo "✓ up" || echo "✗ down"
```

### 检测服务器状态

```bash
# 1. 进程是否还在
ps -p "$(cat "$REPO/loop.pid")" -o pid,etime,stat,cmd 2>/dev/null \
  || echo "loop.pid 已死"

# 2. 端口是否监听
ss -tlnp 2>/dev/null | grep 8080 || echo "port 8080 free"

# 3. /api/state — 单次 JSON 快照,内含 iter / phase / stages / pty
curl -s --noproxy '*' http://127.0.0.1:8080/api/state \
  | python3 -c "import json,sys; s=json.load(sys.stdin)['status']; \
                print('iter:',s['iter'],'phase:',s['phase'],\
                      'best:',s['best'],'alive:',s['alive'])"

# 4. Dashboard 顶栏左侧的 ws-dot:绿=WS 直连,黄=HTTP 轮询/demo
```

### 停止

```bash
# 优雅:loop 跑完当前 iter 再退
# 也可在 dashboard 顶栏点 ⏹ Stop(等同 stopRequested 信号)
kill "$(cat "$REPO/loop.pid")"

# 强制(端口仍占住时):
fuser -k 8080/tcp     # 杀任何监听 8080 的进程

# 一键 kill all + 清掉 pid/log
kill "$(cat "$REPO/loop.pid")" 2>/dev/null
fuser -k 8080/tcp 2>/dev/null
rm -f "$REPO/loop.pid" "$REPO/loop.log"
```

### 文件位置一览

| 文件 | 路径 | 内容 |
|---|---|---|
| 当前 diff | `$workdir/.ar.patch` | Stage 1 输出的 unified diff,Stage 2 `git apply` 直接读这个文件。每 iter 覆盖。 |
| Loop 日志 | `$REPO/loop.log` | 后端 stderr 全量(loopTerm PTY 字节 + `[iter N] stage M:` 等 console.error 行)。Dashboard 顶部"Loop"面板逐字节同源,无须 `tail -F`。 |
| LLM 输出 | 同上,在 stage 1 的 `__OUT__diff …` 行里。Stage 1 LLM 的"思考日志"(claude -p 的 stderr)被前缀成 `__ERR__` 行,也在 loop.log 里。 | 没有单独 stage-1.log;dashboard 左栏 stage 列表里的 `stage-N.log` 是 UI 占位,实际文件不存在(除 build.log 外)。 |
| Build 日志 | `$workdir/build.log` | guardCmd 里 `tee build.log` 留下的编译输出(autoninja 全文)。 |
| Metric 历史 | `$REPO/results.tsv` | 每 iter 一行 TSV(iter / status / metric / delta / desc / ts)。session 间累积,不会因重启被 truncate。 |
| 进程 PID | `$REPO/loop.pid` | 启动脚本 echo 进去的 nohup 子进程 PID。 |

### Stage 1 LLM 鉴权

每个 LLM CLI 都需要一次性鉴权,在 dashboard 启动后、点 Start 前,在
**底部 CLI 面板**里执行(loop 进程会等 Start 信号才进入 Stage 1):

```bash
# Anthropic Claude (官方 CLI)
claude login                     # 浏览器跳转 OAuth

# GitHub Copilot CLI
gh auth login                    # gh 主鉴权(交互式)
gh extension install github/gh-copilot   # 装 copilot 子命令
gh copilot --version             # 验证

# 切换 Stage 1 调用的 CLI(默认 claude -p):
# 在 yml 的 env 段里改 IDEATE_CLI,例如:
#   env:
#     IDEATE_CLI: "gh copilot suggest -t shell"
```

鉴权 token 存在用户 home(`~/.config/claude/`、`~/.config/gh/`),
不会随 tarball 打包。新机器需重新登录一次。

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

仪表盘是独立的 HTML 文件 (`../Autoresearch Dashboard.html`),无需构建:

```bash
# 方式 A:直接用浏览器打开 (无 WebSocket,自动进入 demo 模式)
open ../Autoresearch\ Dashboard.html

# 方式 B:配合后端运行 (实时 PTY + WebSocket + 自动化)
cd autoresearch
npx tsx src/index.ts ../vk-image-helper.yml
# 然后打开 http://localhost:8080
```

WebSocket 跟 HTTP 走同一端口 (默认 8080,改用 `AR_PORT=...`)。
HTTP 路径包含:

- `/`            — Dashboard HTML
- `/api/state`   — 单次 JSON 拉取 (代理屏蔽 WebSocket Upgrade 时
                   dashboard 自动降级为 2 s 轮询)
- `ws://…`       — 实时帧 (`pty` / `status` / `git` / `log` / `history`
                   / `toast` / `dead` / `restarted` / …)

**面板语义**:

| 面板 | 数据源 | 可写? |
|---|---|---|
| Loop (顶部) | 镜像 `process.stderr`:loopTerm PTY 字节 + 所有 console.error | 只读 |
| CLI  (底部) | `InteractivePty` 实例 (`bash --noprofile --norc`) | 用户可输入 |

dashboard 顶部"Loop"面板的内容跟 `loop.log` 文件完全一致 — 后端在
`startWebServer` 里 patch 了 `process.stderr.write`,既写文件也广播
给所有 WebSocket 客户端。

---

## 运行循环

启动后,后端先就绪等 dashboard 点击 **Start** 才真正进入 Stage 1。
这样可以让操作员先在 CLI 面板里跑一次 `claude login` 之类的人工
鉴权步骤,再让 loop 接管。

```bash
# 前台运行 (stderr 同时显示在终端 + dashboard "Loop" 面板)
cd autoresearch
npx tsx src/index.ts ../vk-image-helper.yml

# 后台运行 (推荐 — dashboard 自己就是 stderr 的实时镜像)
nohup npx tsx src/index.ts ../vk-image-helper.yml \
  > /dev/null 2>> ../loop.log < /dev/null & disown
echo $! > ../loop.pid

# 停止
kill $(cat ../loop.pid)        # 优雅退出 (loop 先完成当前 iter)
# 或 dashboard 顶栏点 ⏹ Stop  (设置 stopRequested,下个 iter 边界退出)
```

- `results.tsv` 自动创建在 yml 的 `tsvPath`,记录每轮 metric/status。
- `loop.log` 在 yml 的 workdir 旁,包含 stderr 全量(loopTerm 字节 +
  日志行)。dashboard "Loop" 面板的内容跟它逐字节一致。
- 重启 loop 进程会 truncate `loop.log` 但 **不会** 清 `results.tsv` —
  iter 计数从 TSV 历史里恢复。

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
