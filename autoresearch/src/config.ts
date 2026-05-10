import { readFileSync } from "fs";
import { parse } from "yaml";

export interface Config {
  goal:            string;
  scope:           string[];
  remote:          string;
  workdir:         string;

  // ── 1. Skill 本体 ─────────────────────────────────────────────────────────
  // 优先使用 skillDir：框架自动调用 <skillDir>/run.sh
  // stdin = context (git log + TSV tail)，stdout = unified diff
  skillDir?:       string;
  // 若不设置 skillDir，直接写完整命令
  ideatePrompt:    string;
  // Dry-run mode: when the dashboard "Dry Run" toggle is ON, the loop
  // substitutes `cat <dryRunPatch>` for ideatePrompt — exercises Stage 2-5
  // (apply/build/verify/commit) without invoking the LLM. Path is on the
  // target host (i.e. inside cfg.workdir or absolute on the remote box).
  dryRunPatch?:    string;

  // Per-iteration context commands. Run before Stage 1 (ideate); their stdout
  // is concatenated and prepended to the heredoc piped into ideatePrompt.
  // Useful for tools that need a fresh per-iteration snapshot (e.g. pahole
  // layout reports, perf-record summaries, schema diffs).
  contextCmds?:    string[];

  // Extra environment variables exported into the PTY before each session.
  // Useful for skill-driven workflows that read AR_* or IDEATE_CLI from env.
  env?:            Record<string, string>;

  // ── 2. Terminal 初始化 ────────────────────────────────────────────────────
  // SSH/PTY 建立后依次执行；用于 gh auth、git config、env export 等
  setupCmds:       string[];

  // ── 3. 编译 / 测试脚本 ────────────────────────────────────────────────────
  guardCmd:        string;   // 编译检查；非零 → build-fail，revert
  verifyCmd:       string;   // 性能测试；stdout 末 token 必须是数字 metric

  // ── 4. 错误诊断 ───────────────────────────────────────────────────────────
  // 可选：在 guardCmd / verifyCmd 失败后运行，stderr/stdout 追加到 TSV desc
  diagCmd:         string;

  // ── 5. 性能比较 ───────────────────────────────────────────────────────────
  direction:       "lower" | "higher";  // lower=越小越好 (cycles/latency)
  metricLabel:     string;              // 人可读标签，写入 TSV 注释
  metricUnit:      string;              // e.g. "cpu-cycles", "ms", "bytes"

  iterations:      number;
  plateauPatience: number;
  memoryDepth:     number;
  tsvPath:         string;
}

const DEFAULTS: Partial<Config> = {
  iterations:      20,
  plateauPatience: 8,
  memoryDepth:     20,
  tsvPath:         "results.tsv",
  direction:       "lower",
  setupCmds:       [],
  contextCmds:     [],
  env:             {},
  diagCmd:         "",
  metricLabel:     "metric",
  metricUnit:      "",
};

export function load(path: string): Config {
  const raw = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const cfg = { ...DEFAULTS, ...raw } as Config;

  // skillDir takes priority over ideatePrompt
  if (cfg.skillDir && !cfg.ideatePrompt) {
    cfg.ideatePrompt = `${cfg.skillDir}/run.sh`;
  }
  if (typeof (cfg.scope as unknown) === "string") {
    cfg.scope = [cfg.scope as unknown as string];
  }
  if (!Array.isArray(cfg.scope)) cfg.scope = [];

  return cfg;
}
