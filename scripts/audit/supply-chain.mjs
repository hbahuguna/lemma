#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function exists(p) {
  return fs.existsSync(p);
}

function listWorkspacePackageJsons() {
  const dirs = ["packages", path.join("packages", "adapters")];
  const out = [];
  for (const dir of dirs) {
    const absDir = path.join(repoRoot, dir);
    if (!exists(absDir)) continue;
    for (const name of fs.readdirSync(absDir)) {
      const pj = path.join(absDir, name, "package.json");
      if (exists(pj)) out.push(pj);
    }
  }
  return out.sort();
}

function isPublishable(manifest) {
  return manifest && manifest.private === false;
}

function depSpecs(manifest) {
  const out = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = manifest[field] || {};
    for (const [name, spec] of Object.entries(deps)) out.push({ field, name, spec: String(spec) });
  }
  return out;
}

function addCheck(checks, id, ok, details) {
  checks.push({ id, status: ok ? "pass" : "fail", ...details });
}

function main() {
  const args = process.argv.slice(2);
  let writePath = null;
  let reportPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--write") writePath = args[++i];
    else if (args[i] === "--report") reportPath = args[++i];
  }

  const checks = [];
  const risks = [];
  const rootManifest = readJson(path.join(repoRoot, "package.json"));
  const lockPath = path.join(repoRoot, "pnpm-lock.yaml");
  const npmrcPath = path.join(repoRoot, ".npmrc");
  const ciPath = path.join(repoRoot, ".github/workflows/ci.yml");
  const releaseDryRunPath = path.join(repoRoot, ".github/workflows/release-dry-run.yml");

  addCheck(checks, "lockfile.committed", exists(lockPath), {
    path: "pnpm-lock.yaml",
    detail: exists(lockPath) ? "pnpm-lock.yaml is committed" : "pnpm-lock.yaml is missing",
  });
  addCheck(checks, "root.packageManager.pinned", typeof rootManifest.packageManager === "string" && /^pnpm@/.test(rootManifest.packageManager), {
    value: rootManifest.packageManager ?? null,
  });
  addCheck(checks, "root.engines.node", rootManifest.engines?.node === ">=20", {
    value: rootManifest.engines ?? null,
  });
  const npmrc = exists(npmrcPath) ? fs.readFileSync(npmrcPath, "utf8") : "";
  addCheck(checks, "npmrc.present", exists(npmrcPath) && npmrc.includes("engine-strict=true"), {
    path: ".npmrc",
    detail: npmrc.trim().split(/\n+/),
  });

  const ci = exists(ciPath) ? fs.readFileSync(ciPath, "utf8") : "";
  const release = exists(releaseDryRunPath) ? fs.readFileSync(releaseDryRunPath, "utf8") : "";
  addCheck(checks, "ci.frozen-lockfile", ci.includes("--frozen-lockfile"), { path: ".github/workflows/ci.yml" });
  addCheck(checks, "release-dry-run.frozen-lockfile", release.includes("--frozen-lockfile"), { path: ".github/workflows/release-dry-run.yml" });
  addCheck(checks, "release-dry-run.provenance", release.includes("--provenance") || release.includes("NPM_CONFIG_PROVENANCE"), {
    path: ".github/workflows/release-dry-run.yml",
  });
  if (ci.includes("\n  state-primitives:") && ci.includes("\n    steps:") && ci.split("\n    steps:").length > 2) {
    risks.push({
      id: "ci.workflow.structure",
      severity: "medium",
      detail: "CI workflow appears structurally malformed/duplicated (multiple steps blocks observed around verify/state-primitives jobs); frozen-lockfile checks passed textually but workflow execution should be validated by CI repair task (LEM-132 scope).",
      path: ".github/workflows/ci.yml",
    });
  }

  const pkgJsons = listWorkspacePackageJsons();
  const badSpecs = [];
  const publishableIssues = [];
  for (const pj of pkgJsons) {
    const rel = path.relative(repoRoot, pj);
    const manifest = readJson(pj);
    for (const dep of depSpecs(manifest)) {
      if (/^(git\+|git:|github:|http:|https:|file:.*\.tgz|.*\.tgz$)/.test(dep.spec) || dep.spec.includes("github.com/")) {
        badSpecs.push({ package: manifest.name, path: rel, ...dep });
      }
    }
    if (isPublishable(manifest)) {
      const pc = manifest.publishConfig || {};
      if (pc.access !== "public" || pc.provenance !== true) {
        publishableIssues.push({ package: manifest.name, path: rel, publishConfig: pc });
      }
      if (!manifest.repository || manifest.repository.url !== "https://github.com/hbahuguna/lemma.git") {
        publishableIssues.push({ package: manifest.name, path: rel, repository: manifest.repository ?? null });
      }
      if (manifest.engines?.node !== ">=20") {
        publishableIssues.push({ package: manifest.name, path: rel, engines: manifest.engines ?? null });
      }
    }
  }
  addCheck(checks, "manifests.no-git-or-tarball-deps", badSpecs.length === 0, {
    count: badSpecs.length,
    issues: badSpecs,
  });
  addCheck(checks, "publishable.metadata-provenance", publishableIssues.length === 0, {
    publishableCount: pkgJsons.map((p) => readJson(p)).filter(isPublishable).length,
    issueCount: publishableIssues.length,
    issues: publishableIssues,
  });

  const core = readJson(path.join(repoRoot, "packages/core/package.json"));
  const coreRuntimeDeps = Object.keys(core.dependencies || {}).sort();
  const forbiddenCore = coreRuntimeDeps.filter((d) => d !== "zod");
  addCheck(checks, "core.runtime-deps-constrained", forbiddenCore.length === 0 && coreRuntimeDeps.includes("zod"), {
    dependencies: coreRuntimeDeps,
    forbidden: forbiddenCore,
    policy: "runtime dependencies limited to schema/parsing primitives; no host SDKs (zod allowed)",
  });
  addCheck(checks, "core.no-host-sdk-runtime-deps", !coreRuntimeDeps.some((d) => /opencode|claude|codex|cursor|antigravity|playwright/.test(d)), {
    dependencies: coreRuntimeDeps,
  });

  const lock = exists(lockPath) ? fs.readFileSync(lockPath, "utf8") : "";
  const lockHasGit = /\b(git\+ssh|git\+https|github:|tarball:)\b/.test(lock);
  addCheck(checks, "lockfile.no-git-tarball-protocols", !lockHasGit, { detail: "scanned for git+ssh/git+https/github:/tarball: tokens" });

  const failed = checks.filter((c) => c.status !== "pass");
  const result = {
    schema: "lemma.supply-chain-audit/v1",
    task: "LEM-130",
    generated_at: new Date().toISOString(),
    ok: failed.length === 0,
    summary: {
      checks: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
      risks: risks.length,
    },
    checks,
    risks,
  };

  const json = JSON.stringify(result, null, 2) + "\n";
  if (writePath) {
    const abs = path.resolve(repoRoot, writePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, json, "utf8");
  }

  const md = [
    "# LEM-130 Dependency and Supply-Chain Audit",
    "",
    `- Generated: ${result.generated_at}`,
    `- Result: ${result.ok ? "PASS" : "FAIL"}`,
    `- Checks: ${result.summary.passed}/${result.summary.checks} passed`,
    `- Risks noted: ${result.summary.risks}`,
    "",
    "## Checks",
    "",
    "| Check | Status | Details |",
    "| --- | --- | --- |",
    ...checks.map((c) => `| \`${c.id}\` | ${c.status.toUpperCase()} | ${JSON.stringify({ ...c, id: undefined, status: undefined }).replace(/\|/g, "\\|")} |`),
    "",
    "## Risks / Notes",
    "",
    ...(risks.length ? risks.map((r) => `- **${r.id}** (${r.severity}, \`${r.path || "repo"}\`): ${r.detail}`) : ["- None recorded."]),
    "",
    "## Scope",
    "",
    "- Audited workspace manifests, lockfile presence/protocol hints, .npmrc, CI/release install+provenance posture, and publish metadata.",
    "- No dependency upgrades were performed; this is a posture audit with deterministic checks and recorded evidence.",
    "",
  ].join("\n");

  if (reportPath) {
    const abs = path.resolve(repoRoot, reportPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, md, "utf8");
  }

  process.stdout.write(json);
  if (!result.ok) process.exit(1);
}

main();
