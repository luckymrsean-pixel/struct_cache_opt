# gfxBench + ANGLE-Vulkan verifyCmd 设计

**Date**: 2026-05-11
**Status**: Draft → User review

## 背景

`vk-image-helper.yml` 当前 `verifyCmd` 退化为 `size vk_helpers.o → .text bytes`
代理指标 —— `results.tsv` 9 次迭代全 `discard`，说明 .text 字节对 vk 字段
重排不敏感，迭代无信号。

恢复 yml 原设计（cache-misses，direction=lower）的三个阻塞已厘清：

| 阻塞 | 现状 | 解法 |
|---|---|---|
| WSL2 `perf` 不可用 | `/usr/bin/perf` 是 wrapper，找不到匹配 6.6.114.1-microsoft kernel 的 tools 包；apt 仓里没有 `linux-tools-standard-WSL2` | 直接用 generic kernel 的 perf binary：`/usr/lib/linux-tools/6.8.0-111-generic/perf`，已实测可拿 cache-misses/cycles |
| Vulkan 看不到 NVIDIA 1080 | `vulkaninfo --summary` 只有 llvmpipe (CPU)；`/usr/lib/wsl/drivers/nv_dispig.../nv-vk64.json` 指向 Windows DLL，Linux loader 用不上 | 从源码编 Mesa-dzn (`-Dvulkan-drivers=microsoft-experimental`)，dzn 是 D3D12-Vulkan 翻译层，借 `/usr/lib/wsl/lib/libd3d12.so` 上 1080 |
| gfxbench 没经过 ANGLE | 之前 `gl_alu` 报 `"renderer":"D3D12 (NVIDIA 1080)" "vendor":"Microsoft"` —— 走 GL 直接被 WSLg Mesa-on-DX12 接管 | `LD_LIBRARY_PATH=$ANGLE/out/Release` 抢先 + `EGL_PLATFORM_ANGLE_TYPE_ANGLE=vulkan` 强制走 ANGLE-Vulkan 后端；用 result JSON 的 `renderer` 字段含 "ANGLE" 作为正确性 assert |

## 目标

- `verifyCmd` 跑 1 次 gfxbench `gl_5_normal_off` (1920×1080 离屏 FBO，~59s)
- 经 ANGLE-Vulkan 后端，到 dzn ICD，到 NVIDIA 1080
- 输出 cache-misses 作为 keep/discard metric（恢复 yml `direction: lower`、`metricLabel: cache-misses`）
- 把 fps / cycles / cache-misses / dTLB-load-misses 四项 amend 进 commit subject + perf 全文进 commit body
- 第一次 baseline 跑完后做 3-run 抖动评估，决定单轮还是 3-run-median

## 非目标

- 不解决 `gl_5_normal` 屏幕版的 X11 0×0 问题（用离屏版绕过）
- 不在本任务中切换主 metric（cache-misses 保持）
- 不动 Stage 1 LLM 输出（仪表板横向滚动已单独处理）

## Section 0 — Mesa-dzn 一次性装机

**前置依赖** (apt)：

```
meson ninja-build python3-mako python3-yaml
glslang-tools spirv-tools libspirv-tools-dev
libelf-dev bison flex byacc
libdrm-dev libwayland-dev libwayland-egl-backend-dev
libxcb1-dev libxcb-dri3-dev libxcb-present-dev libxcb-randr-dev
libxcb-shm0-dev libxcb-xfixes0-dev libxcb-sync-dev
libx11-xcb-dev libxshmfence-dev libxrandr-dev
pkg-config llvm-dev libllvm17
```

**源码 + 编译**：

```
git clone https://gitlab.freedesktop.org/mesa/mesa.git -b mesa-24.2 \
  /home/fxy/work/mesa-dzn
cd /home/fxy/work/mesa-dzn
meson setup build-dzn \
  -Dvulkan-drivers=microsoft-experimental \
  -Dgallium-drivers= \
  -Dplatforms=wayland,x11 \
  -Dprefix=/home/fxy/work/mesa-dzn/install \
  -Dbuildtype=release \
  -Dgles1=disabled -Dgles2=disabled -Dopengl=false
meson compile -C build-dzn
meson install -C build-dzn
```

注意：dzn 的 meson option 名是 **`microsoft-experimental`**（字面不是 `dzn`），
驱动名才是 dzn。`mesa-24.2` 是 LTS 分支，避免 main 飘。

**ICD 注册**：

```
sudo install -d /usr/share/vulkan/icd.d
sudo install -m 644 \
  /home/fxy/work/mesa-dzn/install/share/vulkan/icd.d/dzn_icd.x86_64.json \
  /usr/share/vulkan/icd.d/
# 编辑后者，把 library_path 改成绝对路径：
#   /home/fxy/work/mesa-dzn/install/lib/x86_64-linux-gnu/libvulkan_dzn.so
```

**验证**：

```
vulkaninfo --summary | sed -n '/Devices:/,/^$/p'
# 必须看到至少 2 个 Device：llvmpipe + dzn (deviceName 含 "D3D12" 或 NVIDIA)
```

**回滚**：直接 `sudo rm /usr/share/vulkan/icd.d/dzn_icd.x86_64.json`，
回到只有 llvmpipe。Mesa 装在隔离 prefix 下，不污染系统 Mesa。

**已知风险**：

- dzn 不支持的 Vulkan 扩展，导致 ANGLE 在某些 init 调用上 abort —— 第一次 baseline 跑就能暴露。退路是 spec Section 3 的 SwiftShader fallback。
- Mesa 24.2 与 Ubuntu 24.04 自带 Mesa 25.2 的 LLVM ABI 兼容性 —— 装在隔离 prefix 不会冲突，但 LD path 切回系统时不能漏。

## Section 1 — verifyCmd 改造

替换 yml 当前的 `verifyCmd:`（基于 size vk_helpers.o 的代理指标）：

```bash
set -o pipefail
PERF=/usr/lib/linux-tools/6.8.0-111-generic/perf
GFX=/home/fxy/work/gfxbench/tfw-pkg
ANGLE_LIB=/home/fxy/angle/out/Release

# (a) ANGLE 抢先：让 dlopen("libGLESv2.so"/"libEGL.so") 解析到 ANGLE 自己的
export LD_LIBRARY_PATH=$ANGLE_LIB:$LD_LIBRARY_PATH
# (b) ANGLE EGL 路径走 Vulkan 后端
export EGL_PLATFORM_ANGLE_TYPE_ANGLE=vulkan
# (c) Vulkan loader 只用 dzn（避开 llvmpipe）
export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/dzn_icd.x86_64.json
export DISPLAY=:0

PERF_OUT=$(mktemp)
RES_DIR=$GFX/results
PRE_LATEST=$(ls -t "$RES_DIR" 2>/dev/null | head -1)

cd "$GFX" && \
$PERF stat -e cache-misses,cycles,dTLB-load-misses --no-big-num -o "$PERF_OUT" -- \
  ./bin/testfw_app --gl_api=gles -t gl_5_normal_off 2>&1 | tail -20

POST_LATEST=$(ls -t "$RES_DIR" | head -1)
[ "$POST_LATEST" = "$PRE_LATEST" ] && { echo "ERR: no new result dir" >&2; exit 2; }
JSON="$RES_DIR/$POST_LATEST/gl_5_normal_off.json"
[ -s "$JSON" ] || { echo "ERR: no result json" >&2; exit 2; }

# 解析
fps=$(jq -r '.results[0].gfx_result.fps' "$JSON")
renderer=$(jq -r '.results[0].gfx_result.renderer' "$JSON")
misses=$(awk '/cache-misses/ {gsub(",", "", $1); print $1; exit}' "$PERF_OUT")
cycles=$(awk '/^[[:space:]]*[0-9].*cycles[[:space:]]*$/ {gsub(",", "", $1); print $1; exit}' "$PERF_OUT")
dtlb=$(awk '/dTLB-load-misses/ {gsub(",", "", $1); print $1; exit}' "$PERF_OUT")

# Assert: ANGLE 真的生效（renderer 字段必含 "ANGLE"）
[[ "$renderer" == *ANGLE* ]] || { echo "ERR: not ANGLE backend, renderer=$renderer" >&2; exit 3; }

# commit amend（沿用 yml 现有形态）
cd /home/fxy/angle && \
  if git log -1 --format=%s | grep -q '^experiment: iter '; then
    git commit --amend \
      -m "$(git log -1 --format=%s)  cache-misses=$misses cycles=$cycles dTLB=$dtlb fps=$fps" \
      -m "$(cat "$PERF_OUT")" \
      >/dev/null 2>&1 || true
  fi

echo "$misses"
```

**yml 字段同步改回**：

```yaml
direction:   lower
metricLabel: cache-misses
metricUnit:  events
```

**diagCmd** 保持现有 `grep error: build.log`，verify 失败时 loop.ts 已经会
revert HEAD —— Section 2 的抖动评估不引入新 diag 逻辑。

## Section 2 — 抖动评估

baseline 写入 results.tsv 后，**手动**做一次 3-run 抖动评估（不进自动循环）：

```bash
for i in 1 2 3; do
  bash -c "$(yq '.verifyCmd' vk-image-helper.yml)" | tail -1
done
```

记三个 cache-misses 值，算 cv = stdev/mean：

| cv | 决策 |
|---|---|
| <3% | 保持单轮 verifyCmd 不动 |
| 3–10% | 改 verifyCmd 跑 3 次 gfxbench，取 cache-misses **中位数**，约多 ~3min/iter |
| >10% | 抖动太大，回退 SwiftShader（fps 干净）或换更长 `play_time` 的场景 |

3-run-median 的实现草稿（落入 cv∈[3%,10%] 时替换 Section 1 verifyCmd 的单次 perf 调用为）：

```bash
M=()
for i in 1 2 3; do
  $PERF stat -e cache-misses,cycles,dTLB-load-misses --no-big-num -o "$PERF_OUT.$i" -- \
    ./bin/testfw_app --gl_api=gles -t gl_5_normal_off >/dev/null 2>&1
  M+=( "$(awk '/cache-misses/ {gsub(\",\",\"\",$1); print $1; exit}' "$PERF_OUT.$i")" )
done
misses=$(printf '%s\n' "${M[@]}" | sort -n | sed -n '2p')   # median of 3
PERF_OUT="$PERF_OUT.2"  # 用中位次的 perf 全文作 commit body
```

判定一次性做，结果记到 spec 附录"baseline 抖动"。

## Section 3 — 已知风险 + 兜底

1. **ANGLE 在 dzn 下 abort**（缺扩展）：
   - 兜底：在 verifyCmd 顶部用 `VK_ICD_FILENAMES` 切到 ANGLE 自带 SwiftShader (`/home/fxy/angle/out/Release/vk_swiftshader_icd.json`)
   - 切换代价：一行 env 改动，其他不动
   - 失去：fps 不再代表真 GPU；但 cache-misses 信号仍然有效（且实际上更干净）

2. **离屏 vs 屏幕**：`gl_5_normal_off` 是 FBO 渲染。ANGLE 的离屏路径里：
   - vk::ImageHelper 仍然管 color/depth attachment image —— 主线热路径覆盖
   - 不经过 swapchain/presentation 路径，但那部分跟 ImageHelper layout 关系不大
   - 若 baseline 跑出来 cache-misses 太小（< 1M），说明负载不够，换 `gl_manhattan31_off` 或 屏幕版 `gl_5_normal`

3. **testfw_app 是单进程**（待 baseline 第一次跑时确认）：
   - 现有 perf 命令默认跟随 fork。可能问题是 testfw_app 启动几个渲染线程 —— perf 默认会聚合所有线程
   - 不需要预先处理；baseline 跑通后再判定

4. **commit amend 在 dry-run 下**：dashboard Dry Run 模式跳过 Stage 4 的 verify，所以 verifyCmd 不会被调用，amend 也不会跑 —— 现有 loop.ts 的 dry-run 分支已经覆盖。

## 实施顺序（按 Approach B：先编 dzn 一次装齐）

1. 装 apt 依赖
2. clone Mesa 24.2 + meson setup + ninja build + install
3. 装 dzn ICD 到 /usr/share/vulkan/icd.d，调 library_path 绝对路径
4. 验证 `vulkaninfo --summary` 看到 NVIDIA 1080
5. 改 yml 四处：`verifyCmd` / `direction` / `metricLabel` / `metricUnit`
6. 跑一次 baseline，验证 ANGLE renderer 含 "ANGLE"、四项 metric 都能解析
7. 跑 3-run 抖动评估，按 Section 2 表决定是否改 3-run-median
8. 让 autoresearch 自动跑 1 轮 iter，验证 loop.ts 能正确比 metric 决定 keep/discard
9. 放出 20 轮迭代

## 附录 A — baseline 抖动（实施时填）

```
run 1: cache-misses=___
run 2: cache-misses=___
run 3: cache-misses=___
mean=___  stdev=___  cv=___
decision: ___（单轮 / 3-run-median / 回退 SwiftShader）
```
