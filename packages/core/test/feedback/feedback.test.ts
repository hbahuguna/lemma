import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { StateError, createFeedbackRequest, ingestFeedback } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-feedback-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("LEM-169 feedback loop (core)", () => {
  it("creates feedback request under .lemma/feedback/<request_id>/ with scoped expiring invitations (token not persisted)", async () => {
    await withTempDir(async (root) => {
      const created = await createFeedbackRequest({
        runId: "run-1",
        scope: { findings: ["F-1"], checks: ["C-1"] },
        reviewers: [{ id: "rev-1", name: "Reviewer One" }],
        root,
        requestId: "req-1",
        now: "2026-11-16T00:00:00Z",
        ttlMs: 60_000,
      });

      expect(created.request.request_id).toBe("req-1");
      expect(created.request_path).toContain(path.join(".lemma", "feedback", "req-1", "request.json"));
      expect(created.invitations).toHaveLength(1);
      expect(created.invitations[0].token).toBeTruthy();
      expect(created.invitations[0].request_id).toBe("req-1");

      const reqRaw = await fs.readFile(path.join(root, ".lemma", "feedback", "req-1", "request.json"), "utf8");
      expect(reqRaw).not.toContain(created.invitations[0].token); // token never persisted
      const req = JSON.parse(reqRaw);
      expect(req.invitations[0].token_hash).toBeTruthy();
      expect(req.invitations[0].expires_at).toBeTruthy();
    });
  });

  it("validates response schema and ingests idempotently by response id", async () => {
    await withTempDir(async (root) => {
      const created = await createFeedbackRequest({
        runId: "run-2",
        scope: { findings: ["F-2"] },
        reviewers: [{ id: "rev-2" }],
        root,
        requestId: "req-2",
        now: "2026-11-16T00:00:00Z",
        ttlMs: 60_000,
      });

      const bad = {
        schema_version: "lemma.feedback.response/v1",
        request_id: "req-2",
        response_id: "resp-1",
        reviewer: { id: "rev-2" },
        submitted_at: "2026-11-16T00:01:00Z",
        items: [{ target: { kind: "finding", id: "F-2" } }], // missing comment
      };
      await expect(ingestFeedback({ requestId: "req-2", response: bad, root, invitationToken: created.invitations[0].token, now: "2026-11-16T00:00:30Z" })).rejects.toBeInstanceOf(StateError);

      const ok = {
        schema_version: "lemma.feedback.response/v1",
        request_id: "req-2",
        response_id: "resp-1",
        reviewer: { id: "rev-2", name: "R2" },
        submitted_at: "2026-11-16T00:01:00Z",
        items: [{ target: { kind: "finding", id: "F-2" }, comment: "looks good" }],
      };
      const first = await ingestFeedback({ requestId: "req-2", response: ok, root, invitationToken: created.invitations[0].token, now: "2026-11-16T00:00:30Z" });
      expect(first.idempotent).toBe(false);
      expect(first.attached.length).toBe(1);
      const second = await ingestFeedback({ requestId: "req-2", response: ok, root, invitationToken: created.invitations[0].token, now: "2026-11-16T00:00:40Z" });
      expect(second.idempotent).toBe(true);
      expect(second.response_id).toBe("resp-1");
    });
  });

  it("rejects expired invitation tokens and attaches redacted local context to findings/checks", async () => {
    await withTempDir(async (root) => {
      const created = await createFeedbackRequest({
        runId: "run-3",
        scope: { checks: ["C-3"] },
        reviewers: [{ id: "rev-3" }],
        root,
        requestId: "req-3",
        now: "2026-11-16T00:00:00Z",
        ttlMs: 1_000,
      });
      const resp = {
        schema_version: "lemma.feedback.response/v1",
        request_id: "req-3",
        response_id: "resp-3",
        reviewer: { id: "rev-3" },
        submitted_at: "2026-11-16T00:01:00Z",
        items: [{ target: { kind: "check", id: "C-3" }, comment: "token=sk-SECRET12345678901234567890" }],
      };
      await expect(ingestFeedback({ requestId: "req-3", response: resp, root, invitationToken: created.invitations[0].token, now: "2026-11-16T00:00:05Z" })).rejects.toSatisfy((e: any) => /expired/i.test(String(e?.message || e)));

      // ingest within expiry and ensure redaction
      const ing = await ingestFeedback({ requestId: "req-3", response: resp, root, invitationToken: created.invitations[0].token, now: "2026-11-16T00:00:00Z" });
      const attachmentRaw = await fs.readFile(ing.attached[0].path, "utf8");
      expect(attachmentRaw).not.toContain("SECRET12345678901234567890");
      expect(attachmentRaw).toContain("C-3");
      expect(attachmentRaw).toContain("redacted");
    });
  });

  it("treats feedback as free-tier supported per ADR 0006 (LEM-156, no explicit Pro classification) and performs no entitlement gate", async () => {
    await withTempDir(async (root) => {
      // no license/entitlement provided; should succeed
      const created = await createFeedbackRequest({ runId: "run-4", scope: {}, reviewers: [{ id: "rev" }], root, requestId: "req-4" });
      expect(created.request.request_id).toBe("req-4");
    });
  });
});
