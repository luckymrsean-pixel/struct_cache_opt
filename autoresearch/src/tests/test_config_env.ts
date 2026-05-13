import { load } from "../config";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import assert from "node:assert";

const dir = mkdtempSync(join(tmpdir(), "ar-cfg-"));
const yml = join(dir, "test.yml");
writeFileSync(yml, `
goal:     test
workdir:  /tmp
guardCmd: "true"
verifyCmd: "echo 42"
diagCmd:  ""
direction: lower
metricLabel: t
metricUnit:  e
ideatePrompt: "true"
tsvPath:    /tmp/baseline-results.tsv
iterations: 20
plateauPatience: 6
memoryDepth: 5
`);

// Case 1: no env vars set → defaults from yml hold
delete process.env.AR_TSV;
delete process.env.AR_ITERS;
let cfg = load(yml);
assert.strictEqual(cfg.tsvPath, "/tmp/baseline-results.tsv", "no env should use yml value");
assert.strictEqual(cfg.iterations, 20, "no env should use yml iterations");

// Case 2: AR_TSV overrides
process.env.AR_TSV = "/tmp/override.tsv";
cfg = load(yml);
assert.strictEqual(cfg.tsvPath, "/tmp/override.tsv", "AR_TSV should override");

// Case 3: AR_ITERS overrides
process.env.AR_ITERS = "5";
cfg = load(yml);
assert.strictEqual(cfg.iterations, 5, "AR_ITERS should override");

// Case 4: AR_ITERS=0 should fall back (treat as "not set")
process.env.AR_ITERS = "0";
cfg = load(yml);
assert.strictEqual(cfg.iterations, 20, "AR_ITERS=0 should fall back to yml");

delete process.env.AR_TSV;
delete process.env.AR_ITERS;
console.log("OK: test_config_env passed");
