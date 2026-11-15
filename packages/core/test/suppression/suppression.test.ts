import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  Severity,
  StateError,
  SuppressionStore,
  SUPPRESSION_SCHEMA,
  applySuppressionsToFindings,
  makeExpiredSuppressionFinding,
  scoreConfidence,
  type Check,
  type Finding,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-suppress-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function future(days = 30): string {
  return new Date(Date.now() + days * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function past(): string {
  return "2000-01-01T00:00:00Z";
}

function finding(fp: string, severity: string = Severity.HIGH): Finding {
  return {
    id: `f-${fp}`,
    title: fp,
    severity,
    domain: "security",
    persona: "security",
    strength: "observed",
    consequence: "",
    location: "",
    reproduction: "",
    evidence: [],
    remediation: "",
    verification: "",
    check_id: "c1",
    created_at: "2026-11-15T00:00:00Z",
    tags: [],
    fingerprint: fp,
    suppressed: false,
    suppression_owner: "",
    suppression_reason: "",
    suppression_ticket: "",
    suppression_expires_at: "",
  };
}

describe("LEM-069 baseline suppression with owner and expiry", () => {
  it("persists versioned suppressions with required fields and validates add/remove", async () => {
    await withTempDir(async (root) => {
      const store = new SuppressionStore(root);
      await expect(store.add("fp", "", "reason", "", future())).rejects.toBeInstanceOf(StateError);
      await expect(store.add("fp", "owner", "", "", future())).rejects.toBeInstanceOf(StateError);
      await expect(store.add("", "owner", "reason", "", future())).rejects.toBeInstanceOf(StateError);
      await expect(store.add("fp", "owner", "reason", "", past())).rejects.toBeInstanceOf(StateError);
      await expect(store.add("fp", "owner", "reason", "", "not-a-date")).rejects.toBeInstanceOf(StateError);

      const record = await store.add("fp1", "alice", "accepted risk", "T-1", future(10));
      expect(record.fingerprint).toBe("fp1");
      expect(record.owner).toBe("alice");
      expect(record.reason).toBe("accepted risk");
      expect(record.ticket).toBe("T-1");
      expect(record.expires_at).toMatch(/Z$/);

      const docPath = path.join(root, ".lemma", "suppressions.json");
      expect(existsSync(docPath)).toBe(true);
      const doc = JSON.parse(await readFile(docPath, "utf8")) as { schema_version: string; suppressions: Array<Record<string, unknown>> };
      expect(doc.schema_version).toBe(SUPPRESSION_SCHEMA);
      expect(doc.suppressions).toHaveLength(1);

      const loaded = await store.load();
      expect(loaded.map((r) => r.fingerprint)).toEqual(["fp1"]);

      await expect(store.remove("missing")).rejects.toBeInstanceOf(StateError);
      const removed = await store.remove("fp1");
      expect(removed.fingerprint).toBe("fp1");
      expect(await store.load()).toEqual([]);
    });
  });

  it("classifies active and expired suppressions and treats invalid expiry as expired", async () => {
    await withTempDir(async (root) => {
      const store = new SuppressionStore(root);
      await mkdir(path.join(root, ".lemma"), { recursive: true });
      await writeFile(
        path.join(root, ".lemma", "suppressions.json"),
        JSON.stringify({
          schema_version: SUPPRESSION_SCHEMA,
          suppressions: [
            { fingerprint: "active", owner: "a", reason: "r", ticket: "", expires_at: future(5), created_at: "2026-11-15T00:00:00Z" },
            { fingerprint: "expired", owner: "a", reason: "r", ticket: "", expires_at: past(), created_at: "2026-11-15T00:00:00Z" },
            { fingerprint: "invalid", owner: "a", reason: "r", ticket: "", expires_at: "nope", created_at: "2026-11-15T00:00:00Z" },
          ],
        }),
        "utf8",
      );

      const { active, expired } = await store.activeAndExpired(new Date("2026-11-15T12:00:00Z"));
      expect(Object.keys(active).sort()).toEqual(["active"]);
      expect(active.active?.owner).toBe("a");
      expect(expired.sort()).toEqual(["expired", "invalid"]);
    });
  });

  it("appends audit events for add/remove and applies suppressions with expired-suppression findings", async () => {
    await withTempDir(async (root) => {
      const store = new SuppressionStore(root);
      await store.add("fp-a", "alice", "known", "T-2", future(30));
      await store.add("fp-b", "bob", "temp", "", future(30));
      await store.remove("fp-b");

      const eventsPath = path.join(root, ".lemma", "events.jsonl");
      expect(existsSync(eventsPath)).toBe(true);
      const events = (await readFile(eventsPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events.some((e) => e.event === "suppression_added" && e.fingerprint === "fp-a")).toBe(true);
      expect(events.some((e) => e.event === "suppression_added" && e.fingerprint === "fp-b")).toBe(true);
      expect(events.some((e) => e.event === "suppression_removed" && e.fingerprint === "fp-b")).toBe(true);

      const active = {
        "fp-a": { fingerprint: "fp-a", owner: "alice", reason: "known", ticket: "T-2", expires_at: future(1), created_at: "2026-11-15T00:00:00Z" },
      };
      const f1 = finding("fp-a", Severity.HIGH);
      const f2 = finding("fp-c", Severity.MEDIUM);
      const applied1 = applySuppressionsToFindings([f1, f2], active, ["fp-exp"], { createdAt: "2026-11-15T01:00:00Z" });
      const suppressed = applied1.findings.find((f) => f.fingerprint === "fp-a");
      expect(suppressed?.suppressed).toBe(true);
      expect(suppressed?.suppression_owner).toBe("alice");
      expect(suppressed?.suppression_reason).toBe("known");
      expect(suppressed?.suppression_ticket).toBe("T-2");
      expect(applied1.findings.find((f) => f.fingerprint === "fp-c")?.suppressed).toBe(false);

      const expiredFindings = applied1.findings.filter((f) => f.fingerprint === "suppression-expired:fp-exp");
      expect(expiredFindings).toHaveLength(1);
      expect(expiredFindings[0]?.severity).toBe(Severity.LOW);
      expect(expiredFindings[0]?.title).toBe("Expired suppression: fp-exp");
      expect(expiredFindings[0]?.location).toBe("suppression:fp-exp");
      expect(expiredFindings[0]?.tags).toContain("suppression");
      expect(expiredFindings[0]?.tags).toContain("expired");

      const applied2 = applySuppressionsToFindings(applied1.findings, active, ["fp-exp"], { createdAt: "2026-11-15T01:00:00Z" });
      expect(applied2.findings.filter((f) => f.fingerprint === "suppression-expired:fp-exp")).toHaveLength(1);
    });
  });

  it("keeps suppressed findings visible but excluded from scoring penalties", () => {
    const baseFinding = finding("fp-score", Severity.HIGH);
    const checks = [{ status: "passed", weight: 1, domain: "security" }] as unknown as Check[];

    const unsuppressed = scoreConfidence(checks, [baseFinding]);
    const suppressedApplied = applySuppressionsToFindings([baseFinding], {
      "fp-score": { fingerprint: "fp-score", owner: "o", reason: "r", ticket: "", expires_at: future(), created_at: "" },
    }, []);
    const suppressedScore = scoreConfidence(checks, suppressedApplied.findings);
    expect(suppressedApplied.findings[0]?.suppressed).toBe(true);
    expect(Number(suppressedScore.score)).toBeGreaterThan(Number(unsuppressed.score));
    expect(Number(suppressedScore.penalties.severity_total)).toBeLessThan(Number(unsuppressed.penalties.severity_total));

    const expired = makeExpiredSuppressionFinding("fp-exp", "2026-11-15T00:00:00Z");
    expect(expired.fingerprint).toBe("suppression-expired:fp-exp");
    expect(expired.severity).toBe(Severity.LOW);
  });
});
