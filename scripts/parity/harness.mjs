#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const oracleCfgPath = join(repoRoot, "docs/parity/oracle.json");
const baselinesDir = join(repoRoot, "docs/parity/baselines");

const VOLATILE_PATHS = new Set([
  "generated_at",
  "run_id",
  "started_at",
  "completed_at",
  "determinism.clock",
  "evidence.directory",
  "evidence.summary.manifest",
  "evidence.summary.root",
  "evidence.summary.path",
  "report_path",
  "options.root",
  "options.output",
  "options.personas_dir",
  "target.resolved",
  "target.raw",
  "inventory.root",
  "inventory.path",
  "workflow.source",
  "metering.sink",
  "metering.workspace",
  "phases.*.started_at",
  "phases.*.completed_at",
  "phases.*.duration_ms",
  "phases.*.details.manifest_sha256",
  "phases.*.details.manifest_path",
  "phases.*.details.evidence_path",
  "checks.*.started_at",
  "checks.*.completed_at",
  "checks.*.duration_ms",
  "checks.*.evidence",
  "findings.*.id",
  "findings.*.created_at",
  "findings.*.evidence",
  "blockers.*.id",
  "blockers.*.created_at",
  "blockers.*.evidence",
  "invalid_findings.*.id",
  "personas.*.started_at",
  "personas.*.completed_at",
  "kill_switch.triggered_at",
]);

const PROTECTED_PATHS = [
  "status",
  "decision",
  "decision.decision",
  "decision.rationale",
  "confidence.score",
  "confidence.band",
  "confidence.breakdown",
  "confidence.penalties",
  "coverage",
  "coverage.total_checks",
  "coverage.executed",
  "coverage.passed",
  "coverage.failed",
  "coverage.blocked",
  "coverage.skipped",
  "coverage.error",
  "coverage.planned_not_run",
  "coverage.executed_pct",
  "findings",
  "findings.*.severity",
  "findings.*.status",
  "findings.*.check_id",
  "findings.*.title",
  "findings.*.fingerprint",
  "findings.*.category",
  "findings.*.persona",
  "findings.*.domain",
  "findings.*.evidence_count",
  "checks",
  "checks.*.id",
  "checks.*.status",
  "checks.*.domain",
  "checks.*.persona",
  "checks.*.weight",
  "checks.*.kind",
  "checks.*.severity",
  "blockers",
  "blockers.*.check_id",
  "blockers.*.reason",
  "blockers.*.persona",
  "workflow.phases",
  "schema_version",
  "halted_reason",
];

function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function writeJson(p, v) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + "\n"); }
function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }

function pathMatches(pattern, path) {
  const a = pattern.split(".");
  const b = path.split(".");
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "*") continue;
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isVolatile(path) {
  if (VOLATILE_PATHS.has(path)) return true;
  for (const p of VOLATILE_PATHS) if (p.includes("*") && pathMatches(p, path)) return true;
  // common volatile leaves
  if (/(^|\.)(generated_at|run_id|started_at|completed_at|duration_ms|created_at|triggered_at|recorded_at)$/.test(path)) return true;
  if (/manifest_sha256$/.test(path) || /(^|\.)sha256$/.test(path) && /manifest|artifact|evidence/i.test(path)) return true;
  if (/\.evidence\.\d+$/.test(path) || /\.evidence$/.test(path)) return true; // paths/hashes vary by run dir; keep counts via evidence_count if present
  const leaf = path.split(".").slice(-1)[0] || "";
  if (/absolute|resolved|directory|root$/i.test(leaf)) return true;
  if (leaf === "source" && (path.startsWith("options.") || path.startsWith("target."))) return true;
  return false;
}

function normalizeValue(value, path = "") {
  if (Array.isArray(value)) {
    const arr = value.map((v, i) => normalizeValue(v, `${path}.${i}`)).filter((v) => v !== "__VOLATILE__");
    // stabilize ordering for comparable collections where order is not semantically protected
    if (path.endsWith("limitations") || path.endsWith("personas") || path.endsWith("risks")) {
      return [...arr].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return arr;
  }
  if (isObj(value)) {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const p = path ? `${path}.${k}` : k;
      if (isVolatile(p)) continue;
      const nv = normalizeValue(value[k], p);
      if (nv === "__VOLATILE__") continue;
      out[k] = nv;
    }
    return out;
  }
  if (typeof value === "string") {
    // normalize path separators and strip temp/absolute prefixes
    let s = value.replaceAll("\\\\", "/");
    s = s.replace(/\/private\/tmp\//g, "/tmp/");
    s = s.replace(/\/var\/folders\/[^\s]+\/T\//g, "/tmp/");
    s = s.replace(/lemma-parity-[a-z-]+-[A-Za-z0-9_-]+\//g, "lemma-parity-work/");
    if (/^\/(Users|home|tmp|private)\//.test(s) || /^[A-Za-z]:\//.test(s)) {
      const parts = s.split("/").filter(Boolean);
      s = parts.slice(-2).join("/");
    }
    return s;
  }
  return value;
}

function flatten(value, path = "", out = new Map()) {
  if (Array.isArray(value)) {
    out.set(path, `array[len=${value.length}]`);
    value.forEach((v, i) => flatten(v, `${path}.${i}`, out));
    return out;
  }
  if (isObj(value)) {
    out.set(path || "$", "object");
    for (const k of Object.keys(value).sort()) flatten(value[k], path ? `${path}.${k}` : k, out);
    return out;
  }
  out.set(path || "$", value);
  return out;
}

function diff(a, b) {
  const fa = flatten(a);
  const fb = flatten(b);
  const keys = [...new Set([...fa.keys(), ...fb.keys()])].sort();
  const diffs = [];
  for (const k of keys) {
    const va = fa.has(k) ? fa.get(k) : "<missing>";
    const vb = fb.has(k) ? fb.get(k) : "<missing>";
    if (JSON.stringify(va) !== JSON.stringify(vb)) diffs.push({ path: k, expected: va, actual: vb });
  }
  return diffs;
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, ...opts });
  return res;
}

function ensureAssay(oracle) {
  const assayDir = resolve(repoRoot, oracle.assay_repo);
  if (!existsSync(join(assayDir, "harness"))) throw new Error(`assay repo not found at ${assayDir}`);
  const head = run("git", ["rev-parse", "HEAD"], { cwd: assayDir });
  if (head.status !== 0) throw new Error(`cannot read assay HEAD: ${head.stderr || head.stdout}`);
  const actual = (head.stdout || "").trim();
  if (actual !== oracle.assay_commit) {
    throw new Error(`assay commit mismatch: expected ${oracle.assay_commit} got ${actual} (pin docs/parity/oracle.json)`);
  }
  return assayDir;
}

function scenarioDefs(oracle, assayDir) {
  const personas = join(assayDir, "personas");
  const base = ["-m", "harness", "run", "--seed", String(oracle.determinism.seed), "--clock-mode", oracle.determinism.clock_mode, "--frozen-clock", oracle.determinism.frozen_clock, "--personas-dir", personas];
  return {
    completed: {
      kind: "completed",
      prepare: (work) => {
        const target = join(work, "sample-repo");
        cpSync(join(repoRoot, oracle.fixture), target, { recursive: true });
        // copy personas reference not needed; passed via flag
        return { cwd: target, args: [...base, "--target", ".", "--root", ".", "--no-browser", "--generated-at", oracle.determinism.frozen_clock], env: { PYTHONPATH: assayDir } };
      },
    },
    halted: {
      kind: "halted",
      prepare: (work) => {
        const target = join(work, "sample-repo");
        cpSync(join(repoRoot, oracle.fixture), target, { recursive: true });
        return { cwd: target, args: [...base, "--target", ".", "--root", ".", "--no-browser", "--kill-on", "high", "--generated-at", oracle.determinism.frozen_clock], env: { PYTHONPATH: assayDir } };
      },
    },
    "browser-blocked": {
      kind: "browser-blocked",
      prepare: (work) => {
        const target = join(work, "url-target");
        mkdirSync(target, { recursive: true });
        const stub = join(work, "noplaywright");
        mkdirSync(join(stub, "playwright"), { recursive: true });
        writeFileSync(join(stub, "playwright", "__init__.py"), "raise ImportError('playwright unavailable')\n");
        return {
          cwd: target,
          args: [...base, "--target", "https://example.com", "--root", ".", "--generated-at", oracle.determinism.frozen_clock],
          env: { PYTHONPATH: `${stub}${process.platform === "win32" ? ";" : ":"}${assayDir}` },
        };
      },
    },
  };
}

function runOracle(oracle, assayDir, name) {
  const defs = scenarioDefs(oracle, assayDir);
  const def = defs[name];
  if (!def) throw new Error(`unknown scenario ${name}`);
  const base = join(tmpdir(), "lemma-parity-work");
  mkdirSync(base, { recursive: true });
  const work = join(base, name);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const spec = def.prepare(work);
    const py = oracle.python || "python3.11";
    const res = run(py, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env } });
    if (!res.stdout || !res.stdout.trim()) {
      throw new Error(`oracle ${name} produced no stdout (rc=${res.status}): ${res.stderr}`);
    }
    let report;
    try { report = JSON.parse(res.stdout); } catch (e) { throw new Error(`oracle ${name} stdout not JSON: ${e}\n${res.stdout.slice(0,500)}`); }
    return { report, rc: res.status, stderr: res.stderr || "" };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function runLemma(name) {
  // Integration point: run lemma implementation when available.
  // Env: LEMMA_PARITY_CMD="node packages/cli/dist/index.js" or similar; receives scenario via LEMMA_PARITY_SCENARIO.
  const cmd = process.env.LEMMA_PARITY_CMD;
  if (!cmd) return null;
  const oracle = readJson(oracleCfgPath);
  const work = mkdtempSync(join(tmpdir(), `lemma-parity-impl-${name}-`));
  try {
    const res = run("bash", ["-lc", cmd], { cwd: work, env: { ...process.env, LEMMA_PARITY_SCENARIO: name, LEMMA_PARITY_ORACLE: JSON.stringify(oracle) } });
    if (!res.stdout) return { error: `lemma command produced no stdout: ${res.stderr}`, rc: res.status };
    try { return { report: JSON.parse(res.stdout), rc: res.status }; } catch (e) { return { error: `lemma stdout not JSON: ${e}`, rc: res.status }; }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function printDiffs(diffs, limit = 80) {
  console.error(`field-level diff: ${diffs.length} difference(s)`);
  for (const d of diffs.slice(0, limit)) {
    console.error(`  - ${d.path}`);
    console.error(`      expected: ${JSON.stringify(d.expected)}`);
    console.error(`      actual:   ${JSON.stringify(d.actual)}`);
  }
  if (diffs.length > limit) console.error(`  ... ${diffs.length - limit} more`);
}

function cmdWriteBaselines() {
  const oracle = readJson(oracleCfgPath);
  const assayDir = ensureAssay(oracle);
  mkdirSync(baselinesDir, { recursive: true });
  for (const name of ["completed", "halted", "browser-blocked"]) {
    console.log(`generating oracle baseline: ${name}`);
    const { report, rc } = runOracle(oracle, assayDir, name);
    const normalized = normalizeValue(report);
    const out = { scenario: name, oracle_rc: rc, oracle_commit: oracle.assay_commit, normalized };
    writeJson(join(baselinesDir, `${name}.json`), out);
    console.log(`  status=${report.status} rc=${rc} findings=${(report.findings||[]).length} blocked=${report.coverage?.blocked}`);
  }
  console.log(`wrote baselines to ${relative(repoRoot, baselinesDir)}`);
}

function cmdTest() {
  const oracle = readJson(oracleCfgPath);
  const assayDir = ensureAssay(oracle);
  let ok = true;

  for (const name of ["completed", "halted", "browser-blocked"]) {
    const basePath = join(baselinesDir, `${name}.json`);
    if (!existsSync(basePath)) {
      console.error(`FAIL: missing baseline ${relative(repoRoot, basePath)}`);
      ok = false;
      continue;
    }
    const baseline = readJson(basePath);
    console.log(`\n== ${name} ==`);

    // Oracle vs baseline (pinned oracle must reproduce baseline)
    const { report: oracleReport } = runOracle(oracle, assayDir, name);
    const nOracle = normalizeValue(oracleReport);
    const dOracle = diff(baseline.normalized, nOracle);
    if (dOracle.length) {
      console.error(`FAIL: oracle does not match committed baseline for ${name}`);
      printDiffs(dOracle);
      ok = false;
    } else {
      console.log(`oracle vs baseline: OK`);
    }

    // Seeded/frozen deterministic pair: two oracle runs must produce zero diff
    const { report: oracleReport2 } = runOracle(oracle, assayDir, name);
    const nOracle2 = normalizeValue(oracleReport2);
    const dDet = diff(nOracle, nOracle2);
    if (dDet.length) {
      console.error(`FAIL: seeded/frozen deterministic pair not identical for ${name}`);
      printDiffs(dDet);
      ok = false;
    } else {
      console.log(`seeded/frozen pair zero-diff: OK`);
    }

    // Lemma vs baseline (when implementation available)
    const lemma = runLemma(name);
    if (!lemma) {
      console.log(`lemma run: SKIPPED (set LEMMA_PARITY_CMD when lemma runner is available)`);
    } else if (lemma.error) {
      console.error(`FAIL: lemma run error for ${name}: ${lemma.error}`);
      ok = false;
    } else {
      const nLemma = normalizeValue(lemma.report);
      const dLemma = diff(baseline.normalized, nLemma);
      if (dLemma.length) {
        console.error(`FAIL: lemma report differs from baseline for ${name}`);
        printDiffs(dLemma);
        ok = false;
      } else {
        console.log(`lemma vs baseline: OK`);
      }
    }
  }

  // Demonstrate field-level diff reporting and nonzero exit on drift
  const driftProbe = JSON.parse(JSON.stringify(readJson(join(baselinesDir, "completed.json")).normalized));
  if (driftProbe.decision) driftProbe.decision.decision = "__drift_probe__";
  const probeDiff = diff(readJson(join(baselinesDir, "completed.json")).normalized, driftProbe);
  if (probeDiff.length === 0) { console.error("FAIL: diff engine did not detect injected drift"); ok = false; }
  else console.log(`\ndiff engine self-check: detected ${probeDiff.length} injected difference(s)`);

  // verify normalization preserves protected semantics
  const completedRaw = runOracle(oracle, assayDir, "completed").report;
  const completedNorm = normalizeValue(completedRaw);
  const mustKeep = [
    ["status", completedRaw.status, completedNorm.status],
    ["decision.decision", completedRaw.decision?.decision, completedNorm.decision?.decision],
    ["confidence.score", completedRaw.confidence?.score, completedNorm.confidence?.score],
    ["coverage.total_checks", completedRaw.coverage?.total_checks, completedNorm.coverage?.total_checks],
    ["findings.length", (completedRaw.findings||[]).length, (completedNorm.findings||[]).length],
    ["blockers.length", (completedRaw.blockers||[]).length, (completedNorm.blockers||[]).length],
  ];
  for (const [label, raw, norm] of mustKeep) {
    if (JSON.stringify(raw) !== JSON.stringify(norm)) {
      console.error(`FAIL: normalization altered protected field ${label}`);
      ok = false;
    }
  }
  console.log(`normalization protection check: ${ok ? "OK so far" : "FAILED"}`);

  if (!ok) process.exit(1);
  console.log("\nparity harness: PASS");
}

const args = process.argv.slice(2);
if (args.includes("--write-baselines")) cmdWriteBaselines();
else if (args.includes("--test") || args.length === 0) cmdTest();
else { console.error("usage: node scripts/parity/harness.mjs [--test|--write-baselines]"); process.exit(2); }
