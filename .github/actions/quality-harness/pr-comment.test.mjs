import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMENT_MARKER,
  findMarkedComment,
  planCommentUpsert,
  renderPrComment,
} from "./pr-comment.mjs";

const sampleReport = {
  schema_version: "quality-harness.report/v1",
  run_id: "run_abc123",
  status: "completed",
  target: { raw: ".", kind: "directory" },
  decision: { decision: "ship" },
  confidence: { score: 87.5, band: "high" },
  findings: [
    { severity: "high" },
    { severity: "low" },
    { severity: "low" },
  ],
  blockers: [{ check_id: "static.tests" }],
  evidence: { count: 12 },
  generated_at: "2026-11-16T00:00:00Z",
};

test("renderPrComment includes stable marker and key report fields", () => {
  const body = renderPrComment(sampleReport, { reportPath: ".lemma/report.json" });
  assert.ok(body.includes(COMMENT_MARKER));
  assert.match(body, /## Lemma Release Confidence/);
  assert.match(body, /\*\*Decision:\*\* ship/);
  assert.match(body, /\*\*Status:\*\* completed/);
  assert.match(body, /\*\*Confidence:\*\* 87.5 \(high\)/);
  assert.match(body, /run_abc123/);
  assert.match(body, /critical 0, high 1, medium 0, low 2, info 0/);
  assert.match(body, /\*\*Blockers:\*\* 1/);
  assert.match(body, /\*\*Evidence artifacts:\*\* 12/);
  assert.match(body, /\.lemma\/report\.json/);
});

test("findMarkedComment locates existing marker-based comment", () => {
  const comments = [
    { id: 1, body: "hello" },
    { id: 2, body: `note\n${COMMENT_MARKER}\nbody` },
  ];
  const found = findMarkedComment(comments);
  assert.equal(found?.id, 2);
  assert.equal(findMarkedComment([{ id: 3, body: "nope" }]), null);
});

test("planCommentUpsert updates existing marked comment and creates when missing", () => {
  const body = `${COMMENT_MARKER}\nupdated`;
  const update = planCommentUpsert([{ id: 42, body: `${COMMENT_MARKER}\nold` }], body);
  assert.deepEqual(update, { action: "update", commentId: 42, body });

  const create = planCommentUpsert([{ id: 1, body: "other" }], body);
  assert.deepEqual(create, { action: "create", commentId: null, body });
});

test("renderPrComment is deterministic for same input", () => {
  const a = renderPrComment(sampleReport, { reportPath: ".lemma/report.json" });
  const b = renderPrComment(sampleReport, { reportPath: ".lemma/report.json" });
  assert.equal(a, b);
});
