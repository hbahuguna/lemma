import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProUnavailableError, ingestExpertReview, requestExpertReview } from "../../src/index.js";

const dirs: string[] = [];
async function mk(prefix: string) { const d = await mkdtemp(path.join(tmpdir(), prefix)); dirs.push(d); return d; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

const licensed = { verification: true };

function makeMetering() {
  const calls: any[] = [];
  return {
    calls,
    emit: (eventType: string, quantity = 1, unit = "unit", options: any = {}) => {
      calls.push({ eventType, quantity, unit, options });
      return { ok: true };
    },
  };
}

function makeQuota() {
  const calls: any[] = [];
  return {
    calls,
    consume: (resource: string, quantity = 1, opts: any = {}) => {
      calls.push({ resource, quantity, opts });
      return { allowed: true };
    },
  };
}

describe("LEM-206 enterprise human-expert review tier", () => {
  it("license gate: unlicensed request/ingest returns ProUnavailableError", async () => {
    const root = await mk("lemma-er-lic-");
    await expect(requestExpertReview({ root, runId: "run-1", findings: [], license: null })).rejects.toBeInstanceOf(ProUnavailableError);
    await expect(ingestExpertReview({ root, reviewId: "er-1", response: { notes: [] }, license: null })).rejects.toBeInstanceOf(ProUnavailableError);
  });

  it("request/ingest flow writes to .lemma/pro/expert-reviews/<id>/ via atomic writes and is attributable", async () => {
    const root = await mk("lemma-er-flow-");
    const metering = makeMetering();
    const quota = makeQuota();

    const req = await requestExpertReview({
      root,
      runId: "run-123",
      findings: [{ id: "f1", title: "Bug", severity: "high" }],
      license: licensed,
      metering,
      quota,
      reviewId: "er-abc123",
    });
    expect(req.review.review_id).toBe("er-abc123");
    expect(req.review.status).toBe("requested");
    const reqPath = path.join(root, ".lemma", "pro", "expert-reviews", "er-abc123", "request.json");
    const storedReq = JSON.parse(await readFile(reqPath, "utf8"));
    expect(storedReq.run_id).toBe("run-123");
    expect(storedReq.findings_count).toBe(1);

    const ing = await ingestExpertReview({
      root,
      reviewId: "er-abc123",
      license: licensed,
      metering,
      quota,
      response: {
        reviewer: { name: "Dr. Expert" },
        notes: [{ finding_id: "f1", note: "Confirmed issue", severity: "high" }],
        report: { run_id: "run-123", decision: { decision: "hold", rationale: "original" }, review_notes: [] },
      },
    });

    expect(ing.review.status).toBe("completed");
    expect(ing.review.reviewer.attribution).toBe("Dr. Expert");
    expect(ing.review.reviewer.type).toBe("named");
    const reviewPath = path.join(root, ".lemma", "pro", "expert-reviews", "er-abc123", "review.json");
    const notesPath = path.join(root, ".lemma", "pro", "expert-reviews", "er-abc123", "report-notes.json");
    const storedReview = JSON.parse(await readFile(reviewPath, "utf8"));
    const storedNotes = JSON.parse(await readFile(notesPath, "utf8"));
    expect(storedReview.explicit_review_notes[0].reviewer).toBe("Dr. Expert");
    expect(storedNotes.decision_annotation.overridden).toBe(false);

    // scoped anonymous attribution supported
    const anon = await ingestExpertReview({
      root,
      reviewId: "er-anon",
      license: licensed,
      response: { reviewer: { anonymous_id: "anon-xyz" }, note: "looks ok" },
    });
    expect(anon.review.reviewer.type).toBe("scoped_anonymous");
    expect(anon.review.reviewer.attribution).toBe("anon-xyz");

    // metered and quota-checked for every expert review action
    expect(metering.calls.length).toBeGreaterThanOrEqual(2);
    expect(metering.calls.some((c) => c.eventType === "export_generated" && c.options?.metadata?.action === "request")).toBe(true);
    expect(metering.calls.some((c) => c.options?.metadata?.action === "ingest")).toBe(true);
    expect(quota.calls.length).toBeGreaterThanOrEqual(2);
    expect(quota.calls.every((c) => c.quantity === 1)).toBe(true);
  });

  it("non-override semantics: run decision annotated, not silently overridden", async () => {
    const root = await mk("lemma-er-annot-");
    const ing = await ingestExpertReview({
      root,
      reviewId: "er-decision",
      license: licensed,
      response: {
        reviewer: "Reviewer A",
        notes: [{ note: "Ship with caution" }],
        report: { run_id: "run-9", decision: { decision: "hold", rationale: "baseline" }, confidence: { score: 42 } },
      },
    });

    expect(ing.review.decision_annotation.overridden).toBe(false);
    expect(ing.review.decision_annotation.original_decision).toEqual({ decision: "hold", rationale: "baseline" });
    expect(ing.reportAnnotation.decision_annotation.annotation).toMatch(/not silently overridden/i);

    const annotated = (ing.reportAnnotation as any).annotated_report;
    expect(annotated.decision).toEqual({ decision: "hold", rationale: "baseline" });
    expect(annotated.review_notes.some((n: any) => n.type === "expert_review_note")).toBe(true);
    expect(Array.isArray(annotated.decision_annotations)).toBe(true);
  });

  it("redacts expert input before persistence (no raw credentials/secrets stored)", async () => {
    const root = await mk("lemma-er-redact-");
    const secretToken = "sk_live_SUPERSECRET123456";
    const ing = await ingestExpertReview({
      root,
      reviewId: "er-redact",
      license: licensed,
      response: {
        reviewer: { name: "Expert", note: `token=${secretToken}` } as any,
        notes: [{ note: `Authorization: Bearer ${secretToken}`, recommendation: `api_key=${secretToken}` }],
        annotations: { cookie: `session=${secretToken}` },
      },
    });

    const file = path.join(root, ".lemma", "pro", "expert-reviews", "er-redact", "review.json");
    const stored = await readFile(file, "utf8");
    expect(stored).not.toContain(secretToken);
    expect(stored).not.toContain("SUPERSECRET123456");
    expect(ing.review.redacted).toBe(true);
  });
});
