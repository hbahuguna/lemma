#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const COMMENT_MARKER = "<!-- lemma-pr-comment -->";
export const COMMENT_MARKER_ID = "lemma-pr-comment";

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function severityCounts(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of asArray(findings)) {
    const sev = String(f?.severity ?? "").toLowerCase();
    if (sev in counts) counts[sev] += 1;
  }
  return counts;
}

function fmtCounts(counts) {
  return `critical ${counts.critical}, high ${counts.high}, medium ${counts.medium}, low ${counts.low}, info ${counts.info}`;
}

export function renderPrComment(report, opts = {}) {
  const marker = opts.marker ?? COMMENT_MARKER;
  const decision = report?.decision?.decision ?? report?.decision?.status ?? report?.decision ?? "unknown";
  const status = report?.status ?? "unknown";
  const score = report?.confidence?.score ?? report?.score ?? null;
  const band = report?.confidence?.band ?? report?.band ?? null;
  const runId = report?.run_id ?? report?.runId ?? "unknown";
  const target = report?.target?.raw ?? report?.target?.path ?? report?.target ?? "unknown";
  const counts = severityCounts(report?.findings);
  const blockers = asArray(report?.blockers).length;
  const evidenceCount = report?.evidence?.count ?? report?.evidence_summary?.count ?? null;
  const generatedAt = report?.generated_at ?? report?.completed_at ?? report?.updated_at ?? null;
  const reportPath = opts.reportPath ? String(opts.reportPath) : null;

  const lines = [
    marker,
    "## Lemma Release Confidence",
    "",
    `- **Decision:** ${String(decision)}`,
    `- **Status:** ${String(status)}`,
    `- **Confidence:** ${score == null ? "n/a" : `${score}${band ? ` (${band})` : ""}`}`,
    `- **Target:** ${String(target)}`,
    `- **Run:** \`${String(runId)}\``,
    `- **Findings:** ${fmtCounts(counts)}`,
    `- **Blockers:** ${blockers}`,
  ];
  if (evidenceCount != null) lines.push(`- **Evidence artifacts:** ${evidenceCount}`);
  if (generatedAt) lines.push(`- **Generated:** ${String(generatedAt)}`);
  if (reportPath) lines.push(`- **Report:** \`${reportPath}\``);
  lines.push("", "_Maintained automatically by lemma PR automation (single marker-based comment)._");
  return lines.join("\n");
}

export function findMarkedComment(comments, marker = COMMENT_MARKER) {
  const list = asArray(comments);
  for (const c of list) {
    const body = typeof c?.body === "string" ? c.body : "";
    if (body.includes(marker)) return c;
  }
  return null;
}

export function planCommentUpsert(comments, body, marker = COMMENT_MARKER) {
  const existing = findMarkedComment(comments, marker);
  if (existing && (existing.id != null || existing.databaseId != null)) {
    return { action: "update", commentId: existing.id ?? existing.databaseId, body };
  }
  return { action: "create", commentId: null, body };
}

export async function readJsonFile(filePath) {
  const raw = await fs.promises.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function ghRequest(url, { token, method = "GET", body } = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(url, {
    method,
    headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`GitHub API ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.response = json;
    throw err;
  }
  return json;
}

export async function upsertPullRequestComment({ repo, issueNumber, body, token, apiBase = "https://api.github.com", marker = COMMENT_MARKER }) {
  if (!repo || !issueNumber) throw new Error("repo and issueNumber are required");
  if (!token) throw new Error("token is required");
  const commentsUrl = `${apiBase}/repos/${repo}/issues/${issueNumber}/comments?per_page=100`;
  const comments = await ghRequest(commentsUrl, { token });
  const plan = planCommentUpsert(comments, body, marker);
  if (plan.action === "update") {
    const url = `${apiBase}/repos/${repo}/issues/comments/${plan.commentId}`;
    const updated = await ghRequest(url, { token, method: "PATCH", body: { body } });
    return { action: "update", commentId: plan.commentId, response: updated };
  }
  const created = await ghRequest(`${apiBase}/repos/${repo}/issues/${issueNumber}/comments`, { token, method: "POST", body: { body } });
  return { action: "create", commentId: created?.id ?? null, response: created };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    out[key] = val;
  }
  return out;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args["render-only"] === "true" || args.render) {
    const reportPath = args.report || args["report-path"];
    if (!reportPath) throw new Error("--report is required for --render-only");
    const report = await readJsonFile(reportPath);
    const body = renderPrComment(report, { reportPath });
    if (args.output) await fs.promises.writeFile(args.output, body, "utf8");
    else process.stdout.write(body);
    return 0;
  }
  if (args.upsert === "true") {
    const reportPath = args.report || args["report-path"];
    if (!reportPath) throw new Error("--report is required for --upsert");
    const repo = args.repo || process.env.GITHUB_REPOSITORY;
    const issueNumber = Number(args.issue || args["issue-number"] || process.env.PR_NUMBER || process.env.ISSUE_NUMBER);
    const token = args.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!repo || !Number.isFinite(issueNumber)) throw new Error("repo and issue/PR number are required");
    if (!token) {
      console.error("No token available; skipping PR comment upsert (fork-safe degradation).");
      return 0;
    }
    const report = await readJsonFile(reportPath);
    const body = renderPrComment(report, { reportPath });
    try {
      const result = await upsertPullRequestComment({ repo, issueNumber, body, token });
      console.log(JSON.stringify({ ok: true, ...result }));
      return 0;
    } catch (err) {
      if (err && (err.status === 403 || err.status === 404)) {
        console.error(`PR comment upsert unavailable (${err.status}); skipping (fork-safe degradation).`);
        return 0;
      }
      throw err;
    }
  }
  throw new Error("Usage: --render-only --report <path> [--output <path>] | --upsert --report <path> --repo <o/r> --issue <n>");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exitCode = 1;
  });
}
