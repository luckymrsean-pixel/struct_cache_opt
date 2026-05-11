# struct_cache_opt 闭环使用指南

闭环把 **vk::ImageHelper 字段重排** 这件事自动化:每一轮由 LLM
(struct_cache_opt skill) 提议 diff → 自动构建 ANGLE → 跑 gfxbench
gl_5_normal,perf 抓 cycles / cache-misses / dTLB-load-misses → 把
counter 嵌入 commit body → cache-misses 低于历史最好 → 保留;否则
`git revert`。

> **角色分工**
> - **Web UI** (`Autoresearch Dashboard.html`):仅供人观察,所有可编辑框
>   都是默认值的提示,真正驱动循环的不是 UI。
> - **autoresearch 后端** (`autoresearch/src/loop.ts`):8 阶段管道执行者,
>   读 `vk-image-helper.yml`,生成 patch / build / verify / commit。
> - **Claude (你或主 Claude)**:监督者。读 `stage-N.log` / `build.log` /
>   `results.tsv` / `loop.log`,发现命令报错就改 yml(或 dashboard 框
>   里的 script),必要时 stop / restart / git reset 回到某个版本。
>   驱动方式见 [loop_control/SKILL.md](loop_control/SKILL.md) — 该
>   skill 是工具无关的,任何能加载 SKILL.md 的 agent(Claude / Copilot
>   / 其他)都可以用。

---

## 0. 一次性准备

| 项 | 命令 / 路径 | 说明 |
|---|---|---|
| target skill | `/mnt/f/code2/target_skill/struct_cache_opt` | SKILL.md + run.sh + lib/。**已 git init**,后续 prompt.tmpl / pahole helper 改动靠 `git -C /mnt/f/code2/target_skill commit` 留痕 |
| Angle 仓库 | `/home/fxy/angle` | 已有 `.git`、`out/Release` build dir。每轮迭代在这里 commit/revert |
| gfxbench | `/home/fxy/work/gfxbench/tfw-pkg` | `bin/testfw_app -t gl_5_normal` 是测试程序 |
| `perf` | `/usr/bin/perf` | **WSL2 注意**:stock perf 是 wrapper,需要 `linux-tools-standard-WSL2`,否则会 "perf not found for kernel ..."。在真 Linux 主机上跑则正常 |
| `jq` | 当前缺失 | `sudo apt install jq` 一次即可,fps 从 gfxbench JSON 里取需要它 |
| Node + tsx | `/home/fxy/.nvm/.../node v22`、`npx tsx` | autoresearch 后端用 |
| dryRunPatch | `/tmp/struct_cache_opt.fake.patch` | 已存在;Dashboard 勾 Dry Run 时 Stage 1 用 `cat <patch>` 取代 LLM |

```bash
# 一次性
sudo apt install -y jq linux-tools-standard-WSL2     # 后者按需
cd /mnt/f/code2/struct_cache_opt/autoresearch && pnpm install   # 或 npm
```

---

## 1. 启动服务器

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
npx tsx src/index.ts ../vk-image-helper.yml 2> ../loop.log &
echo $! > ../loop.pid
```

- 监听 `http://localhost:8080`(serve dashboard HTML + REST `/api/state`)
  以及 `ws://localhost:8080`(WebSocket 实时推送)。
- stderr 都重定向到 `loop.log`,用 `tail -f loop.log` 看实时状态。
- 关闭:`kill $(cat loop.pid)`。

直接在浏览器里打开 dashboard:`http://localhost:8080/`(server 会回 HTML)。
右上角 ws-dot 颜色:
- 绿色 + `已连接` = WebSocket 通,实时推
- 绿色 + `HTTP 轮询` = WS 被代理拦,自动 fallback 到 `/api/state` 每 2s 拉
- 黄色 + `demo` = WS 也死、polling 也死,演示数据,你看到的是假的

> **代理坑**:Windows / VS Code Simple Browser 通常走系统代理(Clash:7890)。
> Clash 默认拦 `localhost` 但放行内网 IP。**最稳的入口是 `http://<WSL IP>:8080/`**
> (`hostname -I` 拿 IP,这台是 192.168.1.3)。Dashboard 一旦发现 WS 连不上
> 会自动切到 polling,所以 terminal/状态依然能更新,只是延迟 ~2s。

Stage 0 是 `confirm` 状态。**通常情况下不需要手动 `claude login`** —
`~/.claude/.credentials.json` 一旦存在(任何之前的 claude 会话都会留),
autoresearch 的 PTY 直接继承 `HOME` 拿到。点 ✓ Confirm & Continue 就走
setupCmds(包括 target_skill `git init` 兜底)然后 baseline。

---

## 2. 8 阶段管道(每一轮)

| # | 阶段 | 实际命令来自 | 日志 | 失败时 |
|---|---|---|---|---|
| 0 | Init & Claude Login | 手动 + `setupCmds` | `stage-0.log` | 操作员重跑 |
| 1 | Generate Diff | `${skillDir}/run.sh` 走 stdin = pahole + git log + tsv tail | `stage-1.log` | TSV `discard / ideate-fail` |
| 2 | Apply Diff | `git apply --check .ar.patch && git apply .ar.patch` | `stage-2.log` | TSV `discard / apply-fail` 或 `out-of-scope` |
| 3 | Build | `guardCmd` (autoninja libGLESv2 libEGL) | `stage-3.log` + `build.log` | `git revert HEAD`,TSV `discard / build-fail` + `diagCmd` 第一行错误 |
| 4 | Verify | `verifyCmd` (perf stat + gfxbench gl_5_normal) | `stage-4.log` + `$AR_PERF_LOG` | `git revert HEAD`,TSV `crash / verify-bad` |
| 5 | Amend Commit & Decide | 内嵌在 verifyCmd:`git commit --amend` 把 fps/cycles/cache-misses/dTLB-load-misses 写到 commit subject + perf body 写到 commit body;loop.ts 比 metric 决定 keep / revert | `stage-5.log` | — |
| 6 | Schedule Next | loop.ts 自循环回 1 | `stage-6.log` | 达到 `iterations` 或 `plateauPatience` → session 结束 |

**关键设计**:perf 的三个 counter 不是单独的 log,而是被 amend 进
**Angle 仓库的 commit message body**。Dashboard 右栏的版本历史展示
`git log` subject + 文件列表;在 main terminal 里 `git -C
/home/fxy/angle log -1 --format=%B` 可以看到完整的 perf 文本。

> **WSL2 现状(2026-05-11 更新)**:
> - `perf`: 用 `/usr/lib/linux-tools/6.8.0-111-generic/perf`(generic
>   kernel 的 binary 在 WSL2 6.6 内核上跨内核兼容已实测可用,绕过
>   `linux-tools-standard-WSL2` 不在 noble 仓里的坑)。
> - `Vulkan/NVIDIA 1080`: 通过 Mesa-dzn 翻译层
>   (`-Dvulkan-drivers=microsoft-experimental`,编于
>   `/home/fxy/work/mesa-dzn/install`,ICD 注册在
>   `/usr/share/vulkan/icd.d/dzn_icd.x86_64.json`)。
>   `vulkaninfo --summary` 应看到 `Microsoft Direct3D12 (NVIDIA GeForce
>   GTX 1080)` / driverID=`DRIVER_ID_MESA_DOZEN`。
> - `gfxbench` 没用上:gl_5/gl_4/manhattan31 全要 ES 3.1,但
>   ANGLE-Vulkan-dzn 客户端 API 天花板是 ES 2.0(dzn 缺 Vulkan 1.2/1.3
>   扩展);ES 2 场景 (gl_trex_off) 又因 testfw_app 链 GLEW(桌面 GL only)
>   解析 ANGLE GLES 字符串崩溃。结构性约束,非配置问题。
> - `workload`: 换成 ANGLE 自带 `angle_perftests
>   DrawCallPerfBenchmark.Run/gl`,同样经 ANGLE-Vulkan-dzn-1080,每个
>   draw call 都过 vk::ImageHelper。每轮 25s,cv≈4.33% → verifyCmd
>   用 3-run-median(共 ~75s/iter)。详见
>   `docs/superpowers/specs/2026-05-11-gfxbench-angle-verify-design.md`
>   和 `docs/superpowers/plans/2026-05-11-gfxbench-angle-verify.md`。
> - `ANGLE 注入`: `LD_LIBRARY_PATH=/home/fxy/angle/out/Release` +
>   `ANGLE_DEFAULT_PLATFORM=vulkan`。verifyCmd 用 stdout 含
>   `Microsoft device id` 作 dzn-NVIDIA 链路存活的断言,缺即 exit 3。
> - `cv 决策`: baseline 4-run cv=4.33% → 选 3-run-median。

### per-stage stderr 日志(loop.log)

loop.ts 现在每个 stage 都打 begin/end 行。失败时还会打 5 行 stdout/stderr
预览 + (stage 2 失败) patch 头尾 + (stage 3/4 失败) diagCmd 第 1 行。
样例:

```
[autoresearch] ── iter 1 ──
[iter 1] stage 1: ideate (/mnt/f/code2/target_skill/struct_cache_opt/run.sh)
[iter 1] stage 1: ideate exit=0 stdout=845B stderr=0B (305240ms)
[iter 1] stage 2: git apply (845B patch)
[iter 1] stage 2: apply OK
[iter 1] stage 3: guardCmd (build)
[iter 1] stage 3: build exit=0 (118000ms)
[iter 1] stage 4: verifyCmd (metric)
[iter 1] stage 4: verify exit=0 metric=1119014 stdout="1119014" (5200ms)
[autoresearch] ✓ keep  metric=1119014  delta=-900
```

UI 看不到也能从 `tail -F loop.log | grep -E "iter|stage|FAIL"` 完整复现进度。

### REST 拉取 — `GET /api/state`

WebSocket 不通也行。返回 JSON 包含:
- `status` (iter / total / phase / best / alive)
- `git` (branch / lastCommit / changed files)
- `logs` (后端跟踪的几个文件 + size + exists)
- `history` (所有 `experiment: iter N` commits 列表 + 当前 head)
- `pty.main` / `pty.cli` (各 64KB 滚动缓冲,客户端只需写增量 tail 到 xterm)

dashboard JS 自动用这个做 fallback;命令行里也能直接拉:

```bash
curl -s --noproxy '*' http://127.0.0.1:8080/api/state | jq '.status'
```

### 提速:`AR_PROMPT_SCOPE`

vk_helpers.cpp ~540KB,把它整个塞进 claude 的 prompt 是 prompt token /
延迟的大头。现在 yml 用 `AR_PROMPT_SCOPE` env 指定**只发** vk_helpers.h
给 LLM(类声明已经够它做 layout 决策);AR_SCOPE 仍允许 diff 触及 .h+.cpp
两文件。从 ~600KB → ~75KB,延迟 ~10×。

---

## 3. 主指标 vs. 辅助指标

| 字段 | 用途 |
|---|---|
| **cache-misses** | 主指标,`direction: lower`。loop 用它决定 keep/discard。verifyCmd 最后 `echo "$misses"`,parseMetric 取最后一个 token |
| cycles | 辅助,写进 commit subject |
| dTLB-load-misses | 辅助,写进 commit subject |
| fps (gfxbench JSON) | 辅助,写进 commit subject;直观但波动较大,不适合做单一目标 |

想换成 cycles 主导 → 改 yml 末尾 `verifyCmd` 的 `echo "$misses"` 为
`echo "$cycles"`,无需改 `direction`(都 lower)。

想最大化 fps → `direction: higher`、`metricLabel: fps`、`echo "$fps"`。

---

## 4. Agent 控制循环的 4 个抓手

(细节见 [loop_control/SKILL.md](loop_control/SKILL.md);适用于任何
能加载 SKILL.md 的 agent,不限 Claude)

1. **看日志**:`tail -F /mnt/f/code2/struct_cache_opt/loop.log` 拿状态;
   `tail -50 /home/fxy/angle/build.log` / `tail -50 $AR_PERF_LOG`
   定位错误。`results.tsv` 是结构化历史。
2. **改 yml**:发现命令拼错 / 路径不对 / perf 不可用 / metric 解析失败,
   直接改 `vk-image-helper.yml`,然后 stop → start。loop.ts 每次
   `awaitStart()` 时重读不会(Config 在进程启动时载入),所以**修改
   yml 必须重启进程**。
3. **回到任意 commit**:Dashboard 右栏 "Apply this version" 等价于
   `git -C /home/fxy/angle reset --hard <hash>`。也可以让 Claude 直接发
   WS 消息 `{type:"apply", hash:"<hash>"}` 给 `ws://localhost:8080`。
4. **Dry Run**:勾 Dashboard 顶栏 Dry Run,或在启动前编辑
   `dryRunPatch` 内容,验证 Stage 2-5 管线本身没问题(不消耗 LLM 额度)。

---

## 5. 常见错误 → 处置

| TSV `desc` | 含义 | Claude 处置 |
|---|---|---|
| `ideate-fail` | skill 没吐 diff(LLM 报错 / 输出空 / claude CLI 超时) | 看 `stage-1.log`;若是 prompt 太大 → 改 `memoryDepth` / `contextCmds` |
| `apply-fail` | `git apply` 拒绝(行号漂移 / 旧基线) | 通常上一个 keep 漂移导致;手动 `git -C $workdir status`,需要时 `git reset --hard` 到 baseline |
| `out-of-scope` | LLM 改了 scope 之外的文件 | 检查 prompt.tmpl 是否清楚,或调 yml `scope:` |
| `build-fail` | autoninja 非零退出 | 看 `build.log` 末尾;`diagCmd` 已 grep `error:` 提示前 5 条 |
| `verify-bad` | gfxbench 崩溃 / perf 没数 / metric 不可解析 | 看 `$AR_PERF_LOG`、gfxbench `results/<latest>/`。本机 perf 不可用是常见原因 |
| `regress` | metric 比 best 差 | 正常,无需处置;LLM 下一轮看 git log 会知道这条没用 |
| `dry-run` | dry-run 模式记录的"如果不是 dry-run 会怎样" | 仅观测 |

---

## 6. 让 agent 接管

跟 agent(Claude / Copilot / 其他能加载 SKILL.md 的工具)说一句
"start the loop, watch it, fix breakages",它会 load
`loop_control/SKILL.md`,按里面的步骤启服务、tail 日志、修 yml、重启。

需要让 agent 完全脱手干预(不点 UI)时,操作员仍要先在 main terminal
里跑一次 `claude login`(或 `IDEATE_CLI` 对应的鉴权命令)完成 Stage 0,
之后 agent 可以全程通过 `ws://localhost:8080` 控制。
