import { describe, expect, it } from "vitest";

import { CheckStatus, type Check } from "@lemma/core";
import { runBrowserChecks } from "../src/index.js";

function makeCheck(id: string): Check {
  return {
    id,
    title: id,
    domain: "functional",
    persona: "functional",
    kind: "browser",
    intent: "test",
    expected: "ok",
    base_weight: 1,
    status: CheckStatus.PLANNED,
    weight: 1,
    actual: "",
    evidence: [],
    finding_ids: [],
    skip_reason: "",
    metadata: {},
  } as Check;
}

describe("LEM-144 browser screenshot capture behavior", () => {
  it("blocked/unavailable runs never fabricate screenshots", async () => {
    const outcomes: any[] = [];
    await runBrowserChecks({
      url: "https://example.test",
      checks: [makeCheck("browser.load"), makeCheck("browser.console")],
      options: { noBrowser: true },
      onOutcome: (_c, o) => outcomes.push(o),
    });
    expect(outcomes.length).toBe(2);
    for (const o of outcomes) {
      expect(o.status).toBe(CheckStatus.BLOCKED);
      expect((o.evidence ?? []).some((e: string) => /screenshot/i.test(e))).toBe(false);
    }
  });

  it("attaches per-check screenshot refs under check evidence directory when runtime provides captured screenshot", async () => {
    const stored: Array<{ name: string; checkId: string; kind: string; path: string; data: Buffer }> = [];
    const files = new Map<string, Buffer>();
    const evidence: any = {
      saveJson: async (name: string, payload: unknown, kind = "json", _desc = "", checkId = "") => {
        const ref = `.lemma/evidence/run_x/${name}.json`;
        const data = Buffer.from(JSON.stringify(payload));
        files.set(ref, data);
        stored.push({ name, checkId, kind, path: ref, data });
        return ref;
      },
      saveScreenshot: async (_name: string, data: Uint8Array | Buffer, _desc = "", checkId = "") => {
        const ref = `.lemma/evidence/run_x/${checkId}/screenshot-${(stored.filter(s => s.kind === "screenshot" && s.checkId === checkId).length + 1)}.png`;
        const buf = Buffer.from(data);
        files.set(ref, buf);
        stored.push({ name: "screenshot", checkId, kind: "screenshot", path: ref, data: buf });
        return ref;
      },
      readEvidenceArtifact: async (ref: string) => files.has(ref) ? { data: files.get(ref)!, contentType: "image/png" } : null,
    };

    // seed source screenshot and text artifacts
    files.set(".lemma/evidence/run_x/shared-screenshot.png", Buffer.from([137,80,78,71,13,10,26,10]));
    files.set(".lemma/evidence/run_x/snap.json", Buffer.from(JSON.stringify({ title: "T" })));
    files.set(".lemma/evidence/run_x/console.json", Buffer.from("[]"));
    files.set(".lemma/evidence/run_x/net.json", Buffer.from("[]"));

    const outcomes: Record<string, any> = {};
    await runBrowserChecks({
      url: "https://example.test",
      checks: [makeCheck("browser.load"), makeCheck("browser.console")],
      options: { noBrowser: false },
      evidence,
      pageViews: [{
        navigation: { url: "https://example.test", finalUrl: "https://example.test", status: 200 },
        snapshot: { title: "T", bodyTextLength: 100 },
        consoleMessages: [],
        pageErrors: [],
        networkEntries: [],
        evidenceRefs: { screenshot: ".lemma/evidence/run_x/shared-screenshot.png", snapshot: ".lemma/evidence/run_x/snap.json", console: ".lemma/evidence/run_x/console.json", network: ".lemma/evidence/run_x/net.json" },
      } as any],
      onOutcome: (c, o) => { outcomes[c.id] = o; },
    });

    for (const id of ["browser.load", "browser.console"]) {
      const o = outcomes[id];
      expect(o.status).not.toBe(CheckStatus.BLOCKED);
      expect((o.evidence ?? []).some((r: string) => r.includes(`/${id}/screenshot-1.png`))).toBe(true);
    }
  });
});
