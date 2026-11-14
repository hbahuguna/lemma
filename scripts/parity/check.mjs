#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const assayRoot = path.resolve(repoRoot, "../assay");
const defaultManifestPath = path.join(repoRoot, "docs/parity/assay.manifest.json");
const inventoryPath = path.join(repoRoot, "docs/parity/assay-feature-inventory.md");
const boardPath = path.join(repoRoot, "BOARD.md");

function getArgValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args[i + 1] ?? null;
}

function readText(p) {
  return fs.readFileSync(p, "utf8");
}

function exists(p) {
  return fs.existsSync(p);
}

function listFiles(dir, predicate = () => true) {
  if (!exists(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(assayRoot, full).replaceAll(path.sep, "/");
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      // skip pycache and node_modules noise in scan; handled specially
      if (name === "__pycache__" || name === "node_modules" || name === "quality_harness.egg-info" || name === "build" || name === ".git") continue;
      out.push(...listFiles(full, predicate));
    } else if (predicate(rel, name, full)) {
      out.push(rel);
    }
  }
  return out.sort();
}

function uniqSorted(arr) {
  return [...new Set(arr)].sort((a, b) => a.localeCompare(b));
}

function parseBoardTaskIds() {
  const text = readText(boardPath);
  const ids = new Set();
  for (const m of text.matchAll(/\bLEM-\d{3}\b/g)) ids.add(m[0]);
  // only real task ids (cards/backlog rows). BOARD has many refs; filter to defined tasks by table/card presence
  const defined = new Set();
  for (const m of text.matchAll(/^\|\s*(LEM-\d{3})\s*\|/gm)) defined.add(m[1]);
  for (const m of text.matchAll(/^###\s*(LEM-\d{3})\s+/gm)) defined.add(m[1]);
  // include any referenced in ranges? not as tasks
  return defined.size ? defined : ids;
}

// ---- ownership mappings (from inventory / board) ----
const moduleOwners = {
  "harness/__init__.py": ["LEM-001"],
  "harness/__main__.py": ["LEM-001", "LEM-083"],
  "harness/cli.py": ["LEM-083", "LEM-084", "LEM-085"],
  "harness/orchestrator.py": ["LEM-015", "LEM-026"],
  "harness/determinism.py": ["LEM-006"],
  "harness/workflows.py": ["LEM-012"],
  "harness/checks.py": ["LEM-014"],
  "harness/plugins.py": ["LEM-075", "LEM-076", "LEM-077", "LEM-078", "LEM-079", "LEM-080", "LEM-081", "LEM-082"],
  "harness/personas.py": ["LEM-041", "LEM-042", "LEM-043", "LEM-044", "LEM-045", "LEM-046", "LEM-047", "LEM-048", "LEM-049"],
  "harness/static_analysis.py": ["LEM-027", "LEM-028", "LEM-029", "LEM-030", "LEM-031", "LEM-032", "LEM-033", "LEM-034", "LEM-035", "LEM-036", "LEM-037", "LEM-038", "LEM-039", "LEM-040"],
  "harness/browser.py": ["LEM-050", "LEM-051", "LEM-052", "LEM-053", "LEM-054", "LEM-055", "LEM-056", "LEM-057", "LEM-058", "LEM-059", "LEM-060", "LEM-061", "LEM-062", "LEM-063", "LEM-064"],
  "harness/scoring.py": ["LEM-018", "LEM-019"],
  "harness/evidence.py": ["LEM-016", "LEM-017"],
  "harness/state.py": ["LEM-010", "LEM-011", "LEM-023"],
  "harness/report.py": ["LEM-020"],
  "harness/models.py": ["LEM-004", "LEM-013"],
  "harness/errors.py": ["LEM-007"],
  "harness/outcomes.py": ["LEM-013", "LEM-046"],
  "harness/risk.py": ["LEM-024", "LEM-036"],
  "harness/redact.py": ["LEM-008", "LEM-123"],
  "harness/exports.py": ["LEM-065", "LEM-066"],
  "harness/calibration.py": ["LEM-070", "LEM-074"],
  "harness/ssrf.py": ["LEM-059", "LEM-125"],
  "harness/step_planner.py": ["LEM-025"],
  "harness/step_runner.py": ["LEM-025"],
  "harness/metering.py": ["LEM-113"],
  "harness/auth.py": ["LEM-114"],
  "harness/quota.py": ["LEM-115"],
  "harness/ledger.py": ["LEM-116"],
  "harness/signup.py": ["LEM-117"],
  "harness/entitlements.py": ["LEM-117"],
  "harness/billing.py": ["LEM-118", "LEM-121"],
  "harness/queue.py": ["LEM-119"],
  "harness/retention.py": ["LEM-120"],
  "harness/py.typed": ["LEM-001"],
};

const cliOwners = {
  "run": ["LEM-084"],
  "status": ["LEM-084", "LEM-023"],
  "report": ["LEM-084"],
  "abort": ["LEM-084"],
  "prune": ["LEM-084", "LEM-023"],
  "personas": ["LEM-085"],
  "personas lint": ["LEM-047"],
  "personas scaffold": ["LEM-048"],
  "sarif": ["LEM-065"],
  "junit": ["LEM-066"],
  "sign-report": ["LEM-067"],
  "verify-report": ["LEM-067"],
  "verify-evidence": ["LEM-071"],
  "suppress add": ["LEM-069"],
  "suppress list": ["LEM-069"],
  "suppress remove": ["LEM-069"],
  "auth create-workspace": ["LEM-114"],
  "auth list-workspaces": ["LEM-114"],
  "auth create-key": ["LEM-114"],
  "auth list-keys": ["LEM-114"],
  "auth revoke-key": ["LEM-114"],
  "auth rotate-key": ["LEM-114"],
  "auth authenticate": ["LEM-114"],
  "auth claim-run": ["LEM-114"],
  "auth authorize-run": ["LEM-114"],
  "quota show": ["LEM-115"],
  "quota consume": ["LEM-115"],
  "ledger ingest": ["LEM-116"],
  "ledger entries": ["LEM-116"],
  "ledger periods": ["LEM-116"],
  "ledger close": ["LEM-116"],
  "ledger adjust": ["LEM-116"],
  "ledger invoice": ["LEM-116"],
  "ledger verify": ["LEM-116"],
  "ledger reconcile": ["LEM-116"],
  "signup create": ["LEM-117"],
  "signup select-plan": ["LEM-117"],
  "signup usage": ["LEM-117"],
  "signup verify": ["LEM-117"],
  "billing status": ["LEM-118"],
  "billing sync": ["LEM-118"],
  "billing disable": ["LEM-118"],
  "billing enable": ["LEM-118"],
  "calibrate": ["LEM-070"],
};

const schemaOwners = {
  "schemas/report/report.v1.schema.json": ["LEM-020", "LEM-073"],
  "schemas/report/index.json": ["LEM-004", "LEM-020"],
  "schemas/metering/envelope.v1.schema.json": ["LEM-113"],
  "schemas/metering/run_started.v1.schema.json": ["LEM-113"],
  "schemas/metering/check_executed.v1.schema.json": ["LEM-113"],
  "schemas/metering/browser_minute_consumed.v1.schema.json": ["LEM-113"],
  "schemas/metering/evidence_byte_stored.v1.schema.json": ["LEM-113"],
  "schemas/metering/export_generated.v1.schema.json": ["LEM-113"],
  "schemas/metering/index.json": ["LEM-004", "LEM-113"],
};

const personaOwners = {
  "personas/functional.md": ["LEM-043"],
  "personas/security.md": ["LEM-043"],
  "personas/accessibility.md": ["LEM-043"],
  "personas/README.md": ["LEM-043", "LEM-047"],
};

const pluginModuleOwners = {
  ".opencode/plugins/assay/index.ts": ["LEM-101"],
  ".opencode/plugins/assay/agent.ts": ["LEM-086", "LEM-087", "LEM-091"],
  ".opencode/plugins/assay/command-args.ts": ["LEM-088", "LEM-089"],
  ".opencode/plugins/assay/runner.ts": ["LEM-083"],
  ".opencode/plugins/assay/jira-context.ts": ["LEM-092"],
  ".opencode/plugins/assay/browser-agent-prompt.ts": ["LEM-090", "LEM-091"],
  ".opencode/plugins/assay/package.json": ["LEM-108"],
  ".opencode/plugins/assay/tsconfig.json": ["LEM-001"],
};

const pluginCommandFileOwners = (rel) => {
  if (rel === ".opencode/commands/assay-browser.md") return ["LEM-090", "LEM-106"];
  if (rel.startsWith(".opencode/commands/_assay_backup/")) return ["LEM-106", "LEM-108"];
  if (rel.startsWith(".opencode/commands/")) return ["LEM-106"];
  return ["LEM-089"];
};

const testOwners = {
  "tests/test_orchestrator_cli.py": ["LEM-026", "LEM-084"],
  "tests/test_workflows.py": ["LEM-012"],
  "tests/test_resume.py": ["LEM-021", "LEM-022"],
  "tests/test_resume_registry.py": ["LEM-021", "LEM-022"],
  "tests/test_seeded_resume.py": ["LEM-021", "LEM-022"],
  "tests/test_determinism.py": ["LEM-006"],
  "tests/test_history.py": ["LEM-023"],
  "tests/test_evidence_state.py": ["LEM-016", "LEM-017", "LEM-124"],
  "tests/test_evidence_signing.py": ["LEM-016", "LEM-017", "LEM-124"],
  "tests/test_scoring.py": ["LEM-018"],
  "tests/test_policy.py": ["LEM-019", "LEM-074"],
  "tests/test_report_schema.py": ["LEM-020", "LEM-073"],
  "tests/test_personas.py": ["LEM-041", "LEM-047", "LEM-048"],
  "tests/test_persona_tools.py": ["LEM-041", "LEM-047", "LEM-048"],
  "tests/test_ownership.py": ["LEM-044"],
  "tests/test_invalid_findings.py": ["LEM-045"],
  "tests/test_blockers.py": ["LEM-046"],
  "tests/test_plugins.py": ["LEM-075", "LEM-076", "LEM-077", "LEM-078", "LEM-079", "LEM-080", "LEM-081", "LEM-082"],
  "tests/test_browser_smoke.py": ["LEM-051", "LEM-054", "LEM-057", "LEM-060"],
  "tests/test_browser_capture.py": ["LEM-051", "LEM-054", "LEM-057", "LEM-060"],
  "tests/test_browser_crawl.py": ["LEM-051", "LEM-054", "LEM-057", "LEM-060"],
  "tests/test_authenticated_browser.py": ["LEM-056"],
  "tests/test_mobile_browser.py": ["LEM-055"],
  "tests/test_browser_category.py": ["LEM-033"],
  "tests/test_test_category.py": ["LEM-033", "LEM-034", "LEM-038"],
  "tests/test_functionality_category.py": ["LEM-033", "LEM-034", "LEM-038"],
  "tests/test_issues_category.py": ["LEM-033", "LEM-034", "LEM-038"],
  "tests/test_demo_category.py": ["LEM-033", "LEM-034", "LEM-038"],
  "tests/test_more_category.py": ["LEM-033", "LEM-034", "LEM-038"],
  "tests/test_full_category.py": ["LEM-033", "LEM-034", "LEM-038"],
  "tests/test_static_precision.py": ["LEM-031", "LEM-032", "LEM-035", "LEM-036", "LEM-039"],
  "tests/test_scope_and_tracking.py": ["LEM-031", "LEM-032", "LEM-035", "LEM-036", "LEM-039"],
  "tests/test_exports.py": ["LEM-065", "LEM-066"],
  "tests/test_suppression.py": ["LEM-069"],
  "tests/test_trend.py": ["LEM-068"],
  "tests/test_calibration.py": ["LEM-070"],
  "tests/test_ssrf.py": ["LEM-059", "LEM-125"],
  "tests/test_redaction_corpus.py": ["LEM-008", "LEM-123"],
  "tests/test_failure_injection.py": ["LEM-126"],
  "tests/test_metering.py": ["LEM-113"],
  "tests/test_auth.py": ["LEM-114"],
  "tests/test_quota.py": ["LEM-115"],
  "tests/test_ledger.py": ["LEM-116"],
  "tests/test_signup.py": ["LEM-117"],
  "tests/test_billing.py": ["LEM-118", "LEM-121"],
  "tests/test_billing_regression.py": ["LEM-118", "LEM-121"],
  "tests/test_queue.py": ["LEM-119"],
  "tests/test_retention.py": ["LEM-120"],
  "tests/test_packaging.py": ["LEM-134"],
  "tests/test_github_action.py": ["LEM-136"],
  "tests/test_assay_command_contract.py": ["LEM-095"],
  "tests/plugin/agent-loop.test.mjs": ["LEM-096"],
  "tests/plugin/browser-agent-prompt.test.mjs": ["LEM-096"],
  "tests/plugin/command-args.test.mjs": ["LEM-095"],
  "tests/plugin/jira-context.test.mjs": ["LEM-092"],
};

function ownerForTest(rel) {
  if (testOwners[rel]) return testOwners[rel];
  // plugin js tests
  if (rel.startsWith("tests/plugin/") && rel.endsWith(".test.mjs")) return ["LEM-095"];
  // fallback by prefix heuristics
  return ["LEM-139"];
}

function fixtureOwners(rel) {
  if (rel.startsWith("examples/sample-repo/")) return ["LEM-038"];
  if (rel.startsWith("examples/demo-web/")) return ["LEM-060"];
  if (rel.startsWith("examples/plugins/")) return ["LEM-080"];
  if (rel.startsWith("calibration/fixtures/")) return ["LEM-070"];
  if (rel === "calibration/report.json") return ["LEM-070"];
  if (rel === "policies/advisory-v1.json") return ["LEM-019"];
  return ["LEM-139"];
}

function releaseAssetOwners(rel) {
  const map = {
    "Dockerfile": ["LEM-135"],
    "Dockerfile.browser": ["LEM-135"],
    "pyproject.toml": ["LEM-009", "LEM-134"],
    "requirements.txt": ["LEM-001"],
    ".github/workflows/ci.yml": ["LEM-132", "LEM-133"],
    ".github/workflows/release.yml": ["LEM-134"],
    ".github/workflows/billing-coverage.yml": ["LEM-121"],
    ".github/workflows/pr.yml": ["LEM-136"],
    ".github/actions/quality-harness/action.yml": ["LEM-136"],
  };
  return map[rel] ?? ["LEM-139"];
}

function assayAvailable() {
  return exists(assayRoot) && exists(path.join(assayRoot, "harness"));
}

function buildExpectedManifest() {
  if (!assayAvailable()) {
    throw new Error(`Assay source not found at ${assayRoot}; required for parity manifest generation/check`);
  }
  const entries = [];

  // modules
  for (const rel of listFiles(path.join(assayRoot, "harness"), (r) => r.startsWith("harness/"))) {
    if (!/^harness\/[^/]+$/.test(rel)) continue; // only top-level module files
    const owners = moduleOwners[rel];
    entries.push({ source: rel, kind: "module", owner_tasks: uniqSorted(owners ?? []), status: owners ? "planned" : "unmapped" });
  }

  // CLI commands (from inventory/assay behavior)
  for (const [cmd, owners] of Object.entries(cliOwners)) {
    entries.push({ source: `cli:${cmd}`, kind: "cli_command", owner_tasks: uniqSorted(owners), status: "planned" });
  }

  // plugin command files + generic entry
  const pluginCmdFiles = [
    ...listFiles(path.join(assayRoot, ".opencode/commands"), (r) => r.endsWith(".md")),
  ].sort();
  for (const rel of pluginCmdFiles) {
    entries.push({ source: rel, kind: "plugin_command", owner_tasks: uniqSorted(pluginCommandFileOwners(rel)), status: "planned" });
  }
  entries.push({ source: "plugin:/assay", kind: "plugin_command", owner_tasks: ["LEM-086", "LEM-087", "LEM-088", "LEM-089", "LEM-090", "LEM-091", "LEM-092", "LEM-093", "LEM-094"], status: "planned" });

  // plugin modules (assets)
  for (const rel of Object.keys(pluginModuleOwners)) {
    if (!exists(path.join(assayRoot, rel))) {
      // keep manifest complete if asset exists in inventory; but scan drives it
    }
    entries.push({ source: rel, kind: "plugin_module", owner_tasks: uniqSorted(pluginModuleOwners[rel]), status: exists(path.join(assayRoot, rel)) ? "planned" : "missing" });
  }

  // personas
  for (const rel of listFiles(path.join(assayRoot, "personas"), (r) => r.startsWith("personas/"))) {
    if (path.dirname(rel) !== "personas") continue;
    entries.push({ source: rel, kind: "persona", owner_tasks: uniqSorted(personaOwners[rel] ?? ["LEM-043"]), status: "planned" });
  }

  // check ids
  const checksText = readText(path.join(assayRoot, "harness/checks.py"));
  const checkIds = uniqSorted([...checksText.matchAll(/id\s*=\s*["']([^"']+)["']/g)].map(m => m[1]));
  for (const id of checkIds) {
    entries.push({ source: `check:${id}`, kind: "check_id", owner_tasks: ["LEM-014", "LEM-037"], status: "planned" });
  }

  // schemas
  for (const rel of listFiles(path.join(assayRoot, "schemas"), (r) => r.endsWith(".json"))) {
    entries.push({ source: rel, kind: "schema", owner_tasks: uniqSorted(schemaOwners[rel] ?? ["LEM-004"]), status: "planned" });
  }

  // fixtures (examples, calibration fixtures/report, policies)
  const fixtureRoots = ["examples", "calibration", "policies"];
  for (const root of fixtureRoots) {
    const abs = path.join(assayRoot, root);
    for (const rel of listFiles(abs, (r) => !r.includes("/__pycache__/") && !r.endsWith(".pyc"))) {
      entries.push({ source: rel, kind: "fixture", owner_tasks: uniqSorted(fixtureOwners(rel)), status: "planned" });
    }
  }

  // test files
  const testFiles = listFiles(path.join(assayRoot, "tests"), (r) => !r.includes("/__pycache__/") && (r.endsWith(".py") || r.endsWith(".mjs") || r.endsWith(".js")));
  for (const rel of testFiles) {
    entries.push({ source: rel, kind: "test_file", owner_tasks: uniqSorted(ownerForTest(rel)), status: "planned" });
  }

  // release assets
  const releaseAssets = [
    "Dockerfile",
    "Dockerfile.browser",
    "pyproject.toml",
    "requirements.txt",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    ".github/workflows/billing-coverage.yml",
    ".github/workflows/pr.yml",
    ".github/actions/quality-harness/action.yml",
  ];
  for (const rel of releaseAssets) {
    entries.push({ source: rel, kind: "release_asset", owner_tasks: uniqSorted(releaseAssetOwners(rel)), status: exists(path.join(assayRoot, rel)) ? "planned" : "missing" });
  }

  // dedupe by (kind,source)
  const map = new Map();
  for (const e of entries) {
    const key = `${e.kind}::${e.source}`;
    if (!map.has(key)) map.set(key, e);
  }
  return [...map.values()].sort((a, b) => (a.kind + "\0" + a.source).localeCompare(b.kind + "\0" + b.source));
}

function loadManifest(manifestPath) {
  return JSON.parse(readText(manifestPath));
}

function printSummary(entries, label) {
  const counts = new Map();
  for (const e of entries) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  console.log(`${label} coverage summary by asset kind:`);
  for (const kind of [...counts.keys()].sort()) {
    console.log(`  - ${kind}: ${counts.get(kind)}`);
  }
  console.log(`  total: ${entries.length}`);
}

function check(args) {
  const manifestPath = path.resolve(repoRoot, getArgValue(args, "--manifest") ?? defaultManifestPath);
  const noScan = args.includes("--no-scan") || !assayAvailable() || manifestPath !== defaultManifestPath;
  if (!assayAvailable() && !args.includes("--no-scan") && manifestPath === defaultManifestPath) {
    console.log(`note: assay source not found at ${assayRoot}; running manifest validation without source scan`);
  }
  if (manifestPath !== defaultManifestPath) {
    console.log(`note: custom manifest ${path.relative(repoRoot, manifestPath)}; source scan comparison skipped`);
  }
  const expected = noScan ? null : buildExpectedManifest();
  const manifest = loadManifest(manifestPath);
  const boardTasks = parseBoardTaskIds();
  let ok = true;

  if (!Array.isArray(manifest.entries)) {
    console.error("FAIL: manifest.entries must be an array");
    process.exit(1);
  }
  const entries = manifest.entries;
  printSummary(entries, "manifest");

  const key = (e) => `${e.kind}::${e.source}`;
  const manifestKeys = new Set(entries.map(key));

  for (const e of entries) {
    if (!e.source || !e.kind || !Array.isArray(e.owner_tasks) || typeof e.status !== "string") {
      console.error(`FAIL: invalid entry shape: ${JSON.stringify(e)}`);
      ok = false;
      continue;
    }
    if (e.owner_tasks.length === 0) {
      console.error(`FAIL: missing owner task for ${e.kind} ${e.source}`);
      ok = false;
    }
    if (e.status === "unmapped") {
      console.error(`FAIL: unmapped source asset (${e.kind}): ${e.source}`);
      ok = false;
    }
    for (const t of e.owner_tasks) {
      if (!boardTasks.has(t)) {
        console.error(`FAIL: unknown task id ${t} on ${e.kind} ${e.source}`);
        ok = false;
      }
    }
  }

  if (expected) {
    const expectedKeys = new Set(expected.map(key));
    for (const k of expectedKeys) {
      if (!manifestKeys.has(k)) {
        const [kind, source] = k.split("::");
        console.error(`FAIL: unmapped source asset (${kind}): ${source}`);
        ok = false;
      }
    }
    for (const k of manifestKeys) {
      if (!expectedKeys.has(k)) {
        const [kind, source] = k.split("::");
        console.error(`FAIL: manifest has extra/stale asset not in assay source scan (${kind}): ${source}`);
        ok = false;
      }
    }
    // owner/status drift against expected (keeps manifest honest)
    const expectedByKey = new Map(expected.map(e => [key(e), e]));
    for (const e of entries) {
      const ex = expectedByKey.get(key(e));
      if (!ex) continue;
      const a = uniqSorted(e.owner_tasks).join(",");
      const b = uniqSorted(ex.owner_tasks).join(",");
      if (a !== b) {
        console.error(`FAIL: owner_tasks drift for ${e.kind} ${e.source}: manifest=[${a}] expected=[${b}]`);
        ok = false;
      }
      if (e.status !== ex.status) {
        console.error(`FAIL: status drift for ${e.kind} ${e.source}: manifest=${e.status} expected=${ex.status}`);
        ok = false;
      }
    }
  } else {
    console.log("source scan: skipped (assay oracle unavailable or --no-scan)");
  }

  if (!ok) process.exit(1);
  console.log("parity:check PASS");
}

function write(args) {
  const manifestPath = path.resolve(repoRoot, getArgValue(args, "--manifest") ?? defaultManifestPath);
  const expected = buildExpectedManifest();
  const payload = {
    $schema: "https://lemma.dev/schemas/parity-manifest.v0.json",
    version: 1,
    generated_from: {
      assay_root: path.relative(repoRoot, assayRoot),
      inventory: path.relative(repoRoot, inventoryPath),
      board: path.relative(repoRoot, boardPath),
    },
    entries: expected,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(payload, null, 2) + "\n");
  printSummary(expected, "written manifest");
}

const args = process.argv.slice(2);
if (args.includes("--write")) {
  write(args);
} else {
  check(args);
}
