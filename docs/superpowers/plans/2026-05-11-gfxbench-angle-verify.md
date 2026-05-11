# gfxBench + ANGLE-Vulkan verifyCmd Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 autoresearch 闭环用 gfxbench gl_5_normal_off 作 benchmark，经 ANGLE-Vulkan→Mesa dzn→NVIDIA 1080，用 perf 抓 cache-misses 作主 metric 替换当前 .text-bytes 代理。

**Architecture:** 装 Mesa-dzn (Vulkan-over-D3D12) 桥接 → 改 vk-image-helper.yml 的 verifyCmd 跑 gfxbench + perf + ANGLE 抢先注入 → 跑 baseline 评估抖动 → 必要时升 3-run-median → 启 20 轮 loop。

**Tech Stack:** Mesa 24.2 (`-Dvulkan-drivers=microsoft-experimental`), Linux generic-kernel perf 6.8.0-111, gfxbench testfw_app 4.0, ANGLE (libGLESv2/libEGL @ /home/fxy/angle/out/Release), Vulkan loader 1.3.275

**Spec:** `docs/superpowers/specs/2026-05-11-gfxbench-angle-verify-design.md` (commit fffc1a8)

---

## File Structure

| Path | Role | In git? |
|---|---|---|
| `/home/fxy/work/mesa-dzn/` | Mesa 24.2 源码 clone | 否（外部） |
| `/home/fxy/work/mesa-dzn/build-dzn/` | meson build dir | 否 |
| `/home/fxy/work/mesa-dzn/install/` | Mesa 隔离 prefix（lib+share） | 否 |
| `/usr/share/vulkan/icd.d/dzn_icd.x86_64.json` | dzn ICD manifest（系统） | 否 |
| `/mnt/f/code2/struct_cache_opt/vk-image-helper.yml` | autoresearch 配置（改 4 处） | **是** |
| `/mnt/f/code2/struct_cache_opt/how-to.md` | 文档（追加 dzn/perf 现状） | **是** |

每个修改的 yml 字段在 Task 6 里以完整新值替换。how-to.md 在 Task 8 末尾追加 "perf+dzn 现状" 小节。

---

## Task 1: 装 apt 编译依赖 + jq

**Files:** 无（系统包）

- [ ] **Step 1: 装 Mesa-dzn 编译需要的开发包 + 缺失的 jq**

```bash
sudo apt update
sudo apt install -y \
  meson ninja-build python3-mako python3-yaml \
  glslang-tools spirv-tools libspirv-tools-dev \
  libelf-dev bison flex byacc \
  libdrm-dev libwayland-dev libwayland-egl-backend-dev \
  libxcb1-dev libxcb-dri3-dev libxcb-present-dev libxcb-randr-dev \
  libxcb-shm0-dev libxcb-xfixes0-dev libxcb-sync-dev \
  libx11-xcb-dev libxshmfence-dev libxrandr-dev \
  pkg-config llvm-dev libllvm17 \
  jq
```

- [ ] **Step 2: 验证关键工具就位**

```bash
meson --version && ninja --version && jq --version && pkg-config --modversion libdrm
```

Expected: 四行版本号都打印；meson ≥ 0.63，ninja ≥ 1.10，jq ≥ 1.6，libdrm ≥ 2.4.114。任意一行报错就 apt 找补丁包。

- [ ] **Step 3: 无需 commit**（系统包改动，不进 git）

---

## Task 2: Clone Mesa 24.2 源码

**Files:** Create: `/home/fxy/work/mesa-dzn/`

- [ ] **Step 1: 确保目标目录的父级存在并干净**

```bash
mkdir -p /home/fxy/work
[ -d /home/fxy/work/mesa-dzn ] && { echo "ERR: /home/fxy/work/mesa-dzn already exists; rename or remove first" >&2; exit 1; }
```

Expected: 命令静默退出 0，否则停下让用户处理已有目录。

- [ ] **Step 2: clone Mesa 仓库 24.2 分支**

```bash
git clone --depth 1 --branch mesa-24.2 \
  https://gitlab.freedesktop.org/mesa/mesa.git \
  /home/fxy/work/mesa-dzn
```

注：`--depth 1` 避免拉 ~1.5GB 历史。

- [ ] **Step 3: 验证 tag 锁定**

```bash
cd /home/fxy/work/mesa-dzn && git describe --tags
```

Expected: 输出形如 `mesa-24.2.X` 或 `mesa-24.2`。如果是 `mesa-25.x` 就 clone 错分支了。

- [ ] **Step 4: 无需 commit**（Mesa 仓库不在我们的 repo 里）

---

## Task 3: 编译并安装 Mesa-dzn 到隔离 prefix

**Files:** Create: `/home/fxy/work/mesa-dzn/build-dzn/`, `/home/fxy/work/mesa-dzn/install/`

- [ ] **Step 1: meson setup**

```bash
cd /home/fxy/work/mesa-dzn && \
meson setup build-dzn \
  -Dvulkan-drivers=microsoft-experimental \
  -Dgallium-drivers= \
  -Dplatforms=wayland,x11 \
  -Dprefix=/home/fxy/work/mesa-dzn/install \
  -Dbuildtype=release \
  -Dgles1=disabled -Dgles2=disabled -Dopengl=false \
  -Dglx=disabled -Degl=disabled
```

注：`microsoft-experimental` 是 dzn 在 Mesa 的 meson option 名（字面如此，不是 `dzn`）。`-Dgallium-drivers=` 留空跳过所有 gallium 后端节省时间。

Expected: meson 输出末尾 "Found ninja-X.X at /usr/bin/ninja"，无红色 error。常见报错：
- `Run-time dependency 'DirectX-Headers' not found` → `sudo apt install directx-headers-dev` 或下载头文件
- `LLVM dev not found` → 确认 `apt-get install llvm-17-dev` 装上了
- `program 'mako' not found` → `apt-get install python3-mako`

- [ ] **Step 2: 编译**

```bash
meson compile -C /home/fxy/work/mesa-dzn/build-dzn
```

Expected: 5-15min（取决于核心数），末尾 "ninja: build stopped" 不应出现。报错时 meson 会指明哪个 .c 文件挂了。

- [ ] **Step 3: 安装到 prefix**

```bash
meson install -C /home/fxy/work/mesa-dzn/build-dzn
```

Expected: 在 `/home/fxy/work/mesa-dzn/install/` 下生成 `lib/x86_64-linux-gnu/libvulkan_dzn.so` 和 `share/vulkan/icd.d/dzn_icd.x86_64.json`。

- [ ] **Step 4: 验证产物存在**

```bash
ls -la /home/fxy/work/mesa-dzn/install/lib/x86_64-linux-gnu/libvulkan_dzn.so
ls -la /home/fxy/work/mesa-dzn/install/share/vulkan/icd.d/dzn_icd.x86_64.json
```

Expected: 两行都是 ls 的正常输出（文件大小、权限），不是 "No such file"。

- [ ] **Step 5: 无需 commit**（构建产物不进 git）

---

## Task 4: 注册 dzn ICD 到系统 Vulkan loader 路径

**Files:** Create: `/usr/share/vulkan/icd.d/dzn_icd.x86_64.json`

- [ ] **Step 1: 复制 ICD manifest 到系统位置**

```bash
sudo install -d /usr/share/vulkan/icd.d
sudo install -m 644 \
  /home/fxy/work/mesa-dzn/install/share/vulkan/icd.d/dzn_icd.x86_64.json \
  /usr/share/vulkan/icd.d/dzn_icd.x86_64.json
```

- [ ] **Step 2: 把 library_path 改成绝对路径**

manifest 原内容里的 `library_path` 是相对路径（基于 manifest 自身所在目录）。装到 /usr/share/vulkan/icd.d 后相对路径解析就找不到 .so。改成绝对：

```bash
sudo jq '.ICD.library_path = "/home/fxy/work/mesa-dzn/install/lib/x86_64-linux-gnu/libvulkan_dzn.so"' \
  /usr/share/vulkan/icd.d/dzn_icd.x86_64.json | sudo tee /usr/share/vulkan/icd.d/dzn_icd.x86_64.json.new >/dev/null
sudo mv /usr/share/vulkan/icd.d/dzn_icd.x86_64.json.new /usr/share/vulkan/icd.d/dzn_icd.x86_64.json
```

- [ ] **Step 3: 验证 manifest 合法 + 路径绝对**

```bash
cat /usr/share/vulkan/icd.d/dzn_icd.x86_64.json | jq .
```

Expected JSON 大致：

```json
{
  "file_format_version": "1.0.0",
  "ICD": {
    "library_path": "/home/fxy/work/mesa-dzn/install/lib/x86_64-linux-gnu/libvulkan_dzn.so",
    "api_version": "1.X.X"
  }
}
```

`library_path` 必须是绝对路径（以 `/` 开头），不能是 `.\\` 或 `./`。

- [ ] **Step 4: 无需 commit**

---

## Task 5: 验证 Vulkan 通过 dzn 看见 NVIDIA 1080

**Files:** 无（纯验证）

- [ ] **Step 1: 运行 vulkaninfo 看 Devices 段**

```bash
vulkaninfo --summary 2>&1 | sed -n '/Devices:/,$p'
```

Expected: 至少 2 个 GPU 条目，其中**至少一个**满足以下任一：
- `deviceName` 含 "D3D12" 或 "NVIDIA" 或 "GeForce"
- `driverID` 是 `DRIVER_ID_MESA_DOZEN` 或类似 dzn 标识
- `deviceType` 是 `PHYSICAL_DEVICE_TYPE_DISCRETE_GPU`（区别于 llvmpipe 的 `_CPU`）

样例（仅作识别用）：
```
GPU1:
  deviceName = Microsoft Direct3D12 (NVIDIA GeForce GTX 1080)
  driverID   = DRIVER_ID_MESA_DOZEN
  deviceType = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU
```

- [ ] **Step 2: 若 dzn 没出现，回退诊断**

```bash
# 检查 vulkan loader 看到的所有 ICD
VK_LOADER_DEBUG=all vulkaninfo --summary 2>&1 | grep -E "ICD|dzn|nvoglv|llvmpipe" | head -30
```

如果 loader 加载了 dzn .so 但物理设备没出来，常见原因：
1. `/usr/lib/wsl/lib/libd3d12.so` ldconfig 没生效 → 跑 `sudo ldconfig` 后重试
2. WSL host 没装/启用 GPU → Windows 侧 `dxdiag` 看 NVIDIA driver 状态
3. dzn 与 Mesa 24.2 这个 commit 有 bug → 切到 mesa-24.3 或 main 试

回退 fallback：在 Task 6 verifyCmd 里把 `VK_ICD_FILENAMES` 暂时指向 ANGLE 自带 SwiftShader（`/home/fxy/angle/out/Release/vk_swiftshader_icd.json`），让 cache-misses 信号先跑起来，dzn 问题留作下一个 task 解。

- [ ] **Step 3: 无需 commit**

---

## Task 6: 改 vk-image-helper.yml 的 verifyCmd 和 metric 字段

**Files:** Modify: `/mnt/f/code2/struct_cache_opt/vk-image-helper.yml`

- [ ] **Step 1: 备份当前 yml**

```bash
cd /mnt/f/code2/struct_cache_opt
cp vk-image-helper.yml vk-image-helper.yml.pre-gfxbench.bak
```

(.bak 不进 git；只作回滚保险)

- [ ] **Step 2: 替换 verifyCmd 整块**

把 yml 当前 `verifyCmd: |-` 到下一个顶层 key（`diagCmd:`）之前的整块，替换为：

```yaml
verifyCmd: |-
  set -o pipefail
  PERF=/usr/lib/linux-tools/6.8.0-111-generic/perf
  GFX=/home/fxy/work/gfxbench/tfw-pkg
  ANGLE_LIB=/home/fxy/angle/out/Release

  # ANGLE 抢先：让 dlopen("libGLESv2.so"/"libEGL.so") 解析到 ANGLE 自己的
  export LD_LIBRARY_PATH=$ANGLE_LIB:$LD_LIBRARY_PATH
  # ANGLE 默认平台走 Vulkan 后端（ANGLE 源码 Display::Create 读的 env）
  export ANGLE_DEFAULT_PLATFORM=vulkan
  # Vulkan loader 只用 dzn（避开 llvmpipe）
  export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/dzn_icd.x86_64.json
  export DISPLAY=:0

  PERF_OUT=$(mktemp)
  RES_DIR=$GFX/results
  PRE_LATEST=$(ls -t "$RES_DIR" 2>/dev/null | head -1)

  cd "$GFX" && \
    $PERF stat -e cache-misses,cycles,dTLB-load-misses -x , -o "$PERF_OUT" -- \
      ./bin/testfw_app --gl_api=gles -t gl_5_normal_off 2>&1 | tail -20

  POST_LATEST=$(ls -t "$RES_DIR" | head -1)
  [ "$POST_LATEST" = "$PRE_LATEST" ] && { echo "ERR: no new result dir" >&2; exit 2; }
  JSON="$RES_DIR/$POST_LATEST/gl_5_normal_off.json"
  [ -s "$JSON" ] || { echo "ERR: no result json" >&2; exit 2; }

  fps=$(jq -r '.results[0].gfx_result.fps' "$JSON")
  renderer=$(jq -r '.results[0].gfx_result.renderer' "$JSON")
  misses=$(awk -F, '$3 ~ /^cache-misses/ {print $1; exit}' "$PERF_OUT")
  cycles=$(awk -F, '$3 ~ /^cycles/ {print $1; exit}' "$PERF_OUT")
  dtlb=$(awk -F, '$3 ~ /^dTLB-load-misses/ {print $1; exit}' "$PERF_OUT")

  # 断言：renderer 必须含 "ANGLE"，否则说明 LD_LIBRARY_PATH/ANGLE_DEFAULT_PLATFORM
  # 没起作用，落到了 WSLg Mesa-on-DX12，这次测量无效
  [[ "$renderer" == *ANGLE* ]] || { echo "ERR: not ANGLE backend, renderer=$renderer" >&2; exit 3; }

  cd /home/fxy/angle && \
    if git log -1 --format=%s | grep -q '^experiment: iter '; then \
      git commit --amend \
        -m "$(git log -1 --format=%s)  cache-misses=$misses cycles=$cycles dTLB=$dtlb fps=$fps" \
        -m "$(cat "$PERF_OUT")" \
        >/dev/null 2>&1 || true; \
    fi

  echo "$misses"
```

注 1：用 `perf stat -x ,` 输出 CSV，避免按列位置 awk 时被千分位逗号坑。
注 2：commit body 是 CSV 全文，dashboard 把 commit body 也展示，CSV 短小不影响可读。

- [ ] **Step 3: 改 metric 三个字段（恢复 yml 原 cache-misses 设计）**

找到现有：

```yaml
direction:   lower
metricLabel: text-bytes
metricUnit:  bytes
```

改为：

```yaml
direction:   lower
metricLabel: cache-misses
metricUnit:  events
```

- [ ] **Step 4: 静态自查**

```bash
cd /mnt/f/code2/struct_cache_opt && python3 -c "import yaml; print(yaml.safe_load(open('vk-image-helper.yml')))" >/dev/null && echo "yml OK"
```

Expected: 打印 "yml OK"。yml 语法挂了会报 ScannerError。

- [ ] **Step 5: commit**

```bash
cd /mnt/f/code2/struct_cache_opt
git add vk-image-helper.yml
git commit -m "$(cat <<'EOF'
feat(yml): switch verifyCmd to gfxbench gl_5_normal_off via ANGLE-Vulkan/dzn

替代 .text-bytes 代理指标，恢复 cache-misses 主 metric。
perf 用 /usr/lib/linux-tools/6.8.0-111-generic/perf 绕过
WSL2 缺包；LD_LIBRARY_PATH+ANGLE_DEFAULT_PLATFORM 注入；
VK_ICD_FILENAMES=dzn 走 NVIDIA 1080；renderer assert 拒绝
落到非 ANGLE 后端的无效测量。

Plan: docs/superpowers/plans/2026-05-11-gfxbench-angle-verify.md
EOF
)"
```

---

## Task 7: 手动跑一次 baseline，验证管道全通

**Files:** 无（执行验证）

- [ ] **Step 1: 抽出 verifyCmd 单独跑**

```bash
cd /mnt/f/code2/struct_cache_opt
# yq 提取 verifyCmd 字段；如无 yq 改用 python
python3 -c "import yaml; print(yaml.safe_load(open('vk-image-helper.yml'))['verifyCmd'])" > /tmp/verify.sh
bash /tmp/verify.sh ; echo "exit=$?"
```

Expected: 末尾打印一个**正整数**（cache-misses 值）+ `exit=0`。

- [ ] **Step 2: 检查 testfw_app 实际用了 ANGLE 后端**

```bash
LATEST=$(ls -t /home/fxy/work/gfxbench/tfw-pkg/results | head -1)
jq '.results[0].gfx_result | {renderer, vendor, graphics_version}' \
  /home/fxy/work/gfxbench/tfw-pkg/results/$LATEST/gl_5_normal_off.json
```

Expected:
```json
{
  "renderer": "ANGLE (...) Vulkan ...",
  "vendor": "Google Inc. (ANGLE)" 或 类似含 "ANGLE",
  "graphics_version": "OpenGL ES 3.X (ANGLE ...)"
}
```

**失败诊断分支：**

| renderer 字段 | 含义 | 怎么修 |
|---|---|---|
| 含 `D3D12` 但不含 `ANGLE` | LD_LIBRARY_PATH 没生效，testfw_app 链了系统 libGLESv2 | 检查 `ldd ./bin/testfw_app` 看 libGLESv2.so 路径；用 `LD_DEBUG=libs ./bin/testfw_app -t gl_5_normal_off 2>&1 | grep -i gles` 看解析过程 |
| 含 `ANGLE` 但 `Vulkan` 缺 | ANGLE_DEFAULT_PLATFORM 未生效，落 OpenGL 后端 | grep ANGLE 源码确认 env 名；试 `ANGLE_DEFAULT_PLATFORM=vulkan EGL_PLATFORM=angle ...` |
| 含 `ANGLE Vulkan llvmpipe` | VK_ICD_FILENAMES 没 override，loader 仍枚举 llvmpipe | 确认 Task 4 的 manifest 存在；试 `unset VK_LAYER_PATH; VK_ICD_FILENAMES=...` |
| `ANGLE Vulkan D3D12 (NVIDIA 1080)` | ✓ 完整链路通了 | 进 Step 3 |

- [ ] **Step 3: 检查 cache-misses 量级**

baseline 跑出的 cache-misses 数字预期 `> 10M`（gl_5_normal_off 跑 ~59s，CPU 应该有亿级 cache 引用）。如果 `< 1M`，说明负载太轻或 perf 只采到了启动阶段，需要：
- 确认 perf 跟随了 testfw_app 的所有线程（perf stat 默认会）
- 确认场景真的跑完了（look at results JSON 的 `frame_count` ≥ 几千）

- [ ] **Step 4: 无需 commit**（baseline 数据通过 autoresearch 写 results.tsv 时会自动 record；本步只是手动验证）

---

## Task 8: 3-run 抖动评估 + 升 3-run-median（条件性）

**Files:** Modify (conditional): `/mnt/f/code2/struct_cache_opt/vk-image-helper.yml`
**Files:** Modify (always): `/mnt/f/code2/struct_cache_opt/how-to.md`

- [ ] **Step 1: 同 baseline 跑 3 次，记三个 cache-misses 值**

```bash
for i in 1 2 3; do
  bash /tmp/verify.sh 2>/dev/null | tail -1
done > /tmp/baseline-3run.txt
cat /tmp/baseline-3run.txt
```

Expected: 三行整数，例如 `45123456 / 44892111 / 45567809`。

- [ ] **Step 2: 算 cv = stdev/mean**

```bash
python3 - <<'EOF' < /tmp/baseline-3run.txt
import sys, statistics
v = [int(x.strip()) for x in sys.stdin if x.strip().isdigit()]
m = statistics.mean(v); s = statistics.stdev(v)
print(f"mean={m:.0f}  stdev={s:.0f}  cv={s/m*100:.2f}%")
EOF
```

- [ ] **Step 3: 按 cv 决定是否升 3-run-median**

| cv | 决策 |
|---|---|
| <3% | 单轮 verifyCmd 不动；进 Step 5 直接更新 how-to.md |
| 3-10% | 进 Step 4 升 verifyCmd 为 3-run-median |
| >10% | 停下，告诉用户：dzn 路径太抖，建议切 SwiftShader（`VK_ICD_FILENAMES=/home/fxy/angle/out/Release/vk_swiftshader_icd.json`）；不进 autoresearch 全循环 |

- [ ] **Step 4 (条件 cv∈[3%,10%]): 升 verifyCmd 为 3-run-median**

把 Task 6 verifyCmd 里 `cd "$GFX" && $PERF stat ...` 那一行替换为：

```bash
  M=(); declare -a PERF_FILES
  cd "$GFX" && for i in 1 2 3; do
    PF="$PERF_OUT.$i"; PERF_FILES+=("$PF")
    $PERF stat -e cache-misses,cycles,dTLB-load-misses -x , -o "$PF" -- \
      ./bin/testfw_app --gl_api=gles -t gl_5_normal_off >/dev/null 2>&1
    M+=( "$(awk -F, '$3 ~ /^cache-misses/ {print $1; exit}' "$PF")" )
  done
  # 取中位次的 perf file 作 commit body
  IDX=$(printf '%s\n' "${!M[@]}" | while read i; do echo "$i:${M[$i]}"; done | sort -t: -k2 -n | sed -n '2p' | cut -d: -f1)
  PERF_OUT="${PERF_FILES[$IDX]}"
```

然后下方 `misses=$(awk -F, ...)` 改为：

```bash
  misses=$(printf '%s\n' "${M[@]}" | sort -n | sed -n '2p')   # median
```

cycles / dtlb / fps 仍从中位次的 PERF_OUT/JSON 读（已通过上面的 IDX 选定）。

- [ ] **Step 5: 把 perf+dzn 现状记到 how-to.md**

把 how-to.md 第 91-94 行那段过期 WSL2 注释（"perf 与 gfxbench 在本机均不工作"）替换为：

```markdown
> **WSL2 现状（2026-05-11 更新）**：
> - `perf`: 用 `/usr/lib/linux-tools/6.8.0-111-generic/perf`（generic kernel 的
>   binary 在 WSL2 6.6 上跨内核兼容，已实测 cache-misses/cycles/dTLB 都拿得到）。
> - `gfxbench`: 离屏版 `gl_5_normal_off` 跑通；屏幕版 `gl_5_normal` 仍有 X11
>   0×0 风险。
> - `Vulkan/NVIDIA 1080`: 通过 Mesa-dzn (`-Dvulkan-drivers=microsoft-experimental`)
>   编译至 `/home/fxy/work/mesa-dzn/install`，ICD 装在
>   `/usr/share/vulkan/icd.d/dzn_icd.x86_64.json`。
> - `ANGLE 注入`: `LD_LIBRARY_PATH=/home/fxy/angle/out/Release` +
>   `ANGLE_DEFAULT_PLATFORM=vulkan`。result JSON 的 `renderer` 字段必须含
>   "ANGLE"，否则 verifyCmd exit 3 拒绝该次测量。
> - `cv 决策`: baseline 3-run cv=___% → 选 ___ （单轮 / 3-run-median）。
```

把 `___` 填上 Step 2 的真实数字和 Step 3 的真实决策。

- [ ] **Step 6: commit**

```bash
cd /mnt/f/code2/struct_cache_opt
git add vk-image-helper.yml how-to.md
git commit -m "$(cat <<'EOF'
chore: baseline jitter eval + WSL2-current notes

baseline 3-run cv=...%，verifyCmd ...（单轮 / 升 3-run-median）。
how-to.md 同步当前 perf/dzn/ANGLE 路径，替代过期的 "perf 不工作" 注释。
EOF
)"
```

(commit message 里的 cv 和决策替换为真实值；不留省略号)

---

## Task 9: 触发 1 轮 autoresearch loop，验证 keep/discard 管道

**Files:** 无（运行验证）

- [ ] **Step 1: 启 autoresearch 后端**

```bash
cd /mnt/f/code2/struct_cache_opt
[ -f loop.pid ] && kill $(cat loop.pid) 2>/dev/null; rm -f loop.pid
cd autoresearch && npx tsx src/index.ts ../vk-image-helper.yml 2> ../loop.log &
echo $! > ../loop.pid
sleep 2 && head -20 ../loop.log
```

Expected: loop.log 头部显示 "listening on http://localhost:8080"，无 stack trace。

- [ ] **Step 2: 浏览器或 curl 触发 Stage 0 confirm**

```bash
curl -s --noproxy '*' -XPOST http://127.0.0.1:8080/api/start 2>&1
# 或 dashboard 点 "✓ Confirm & Continue"
```

(如果没有 /api/start endpoint，从 dashboard UI 操作)

- [ ] **Step 3: 等 baseline + 1 iter 完成**

```bash
tail -F ../loop.log &
TAIL_PID=$!
# 等 results.tsv 出现 iter=1 行（最多 8min）
for i in $(seq 1 96); do
  grep -q "^1[[:space:]]" results.tsv 2>/dev/null && break
  sleep 5
done
kill $TAIL_PID
tail -5 results.tsv
```

Expected: results.tsv 末尾有一行 `1   keep|discard   <number>   <delta>   ...`。`<number>` 是 cache-misses（百万级以上整数）。

- [ ] **Step 4: 看 autoresearch 在 angle repo 里 amend 了 perf 信息**

```bash
git -C /home/fxy/angle log -1 --format=%B
```

Expected: subject 含 `cache-misses=`/`cycles=`/`dTLB=`/`fps=` 四项；body 是 CSV 形式 perf stat 全文。

失败诊断分支：

| 现象 | 处理 |
|---|---|
| iter 1 直接 `apply-fail` | LLM 的 diff 飘了或 baseline 漂移 → `git -C /home/fxy/angle reset --hard <baseline-commit>` 后重试 |
| iter 1 `verify-bad` | verifyCmd 失败，看 stage-4.log；最常见是 renderer 不含 ANGLE → 重做 Task 7 诊断 |
| commit subject 缺字段 | awk 解析挂了，看 verifyCmd 在 stage-4.log 的全输出 |

- [ ] **Step 5: 无需 commit**（autoresearch 自己产 commit 在 angle repo）

---

## Task 10: 放出 20 轮 iter 全跑

**Files:** 无

- [ ] **Step 1: 确认 yml `iterations: 20` `plateauPatience: 6` 不变**

```bash
grep -E "iterations:|plateauPatience:" /mnt/f/code2/struct_cache_opt/vk-image-helper.yml
```

Expected: `iterations: 20` 和 `plateauPatience: 6`（spec 没动这两个）。

- [ ] **Step 2: 让 autoresearch 继续跑**

如果 Task 9 是单 iter run 完已停，重新点 dashboard 的 Continue 按钮；或者 `curl -XPOST http://127.0.0.1:8080/api/continue`。

总耗时估算：每 iter ≈ build 2min + verify 1.5min + ideate 5min ≈ ~9min；20 轮 ≈ 3h。如果升了 3-run-median 多 ~3min/iter，总 4h。

- [ ] **Step 3: 监控**

```bash
watch -n 30 'tail -3 /mnt/f/code2/struct_cache_opt/results.tsv; echo ---; tail -5 /mnt/f/code2/struct_cache_opt/loop.log'
```

- [ ] **Step 4: 跑完后看 winner**

```bash
sort -t$'\t' -k3 -n /mnt/f/code2/struct_cache_opt/results.tsv | head -3
git -C /home/fxy/angle log --grep='^experiment: iter ' --format='%h %s' | head -10
```

最低 cache-misses 的那次 iter 即 winner；`git show <hash>` 看具体 layout diff。

- [ ] **Step 5: 无需 commit**（实验数据由 autoresearch 累计到 results.tsv 和 angle commit 历史）

---

## Self-Review

**Spec coverage**:
- Section 0 装机 → Tasks 1-5 ✓
- Section 1 verifyCmd → Task 6 ✓
- Section 2 抖动评估 → Task 8 ✓
- Section 3 风险点 1（ANGLE-dzn 兼容） → Task 5 Step 2 fallback / Task 7 Step 2 诊断表 ✓
- Section 3 风险点 2（离屏 vs 屏幕） → Task 7 Step 3 量级检查 + 切换提示 ✓
- Section 3 风险点 3（perf fork） → Task 7 Step 3 ✓
- Section 3 风险点 4（dry-run amend） → 现有 loop.ts dry-run 已处理，无需新 task ✓
- 实施顺序 1-9 → Tasks 1-10 一一对应 ✓
- 附录 A baseline 抖动表 → Task 8 Step 1-5 填入 how-to.md ✓

**Placeholder scan**: Step 4 (cv∈[3%,10%]) 和 Step 5 都用 `___` —— 但这些是**实施时填入实际数据**的位置，且代码示例已经完整。Task 6 Step 5 commit message 末尾"cv=...%"也是实施时填，但前文有完整的 verifyCmd 代码。可以保留，因为指令明确（"替换为真实值；不留省略号"）。

**Type consistency**: `cache-misses` 在所有 task 里拼写一致；awk CSV 解析 `$3 ~ /^cache-misses/` 与 perf -x , 的输出列对齐（perf 第 3 列是 event 名）；`PERF_FILES` / `PERF_OUT` / `M` 在 Step 4 一致定义；renderer assert `*ANGLE*` 模式一致。

无内部矛盾。

---

## 执行选择

**Plan complete and saved to `docs/superpowers/plans/2026-05-11-gfxbench-angle-verify.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - 每个 task 起新 subagent，task 间 review，最快迭代

**2. Inline Execution** - 在本会话连贯跑 task，配 checkpoint 给你回顾

**Which approach?**
