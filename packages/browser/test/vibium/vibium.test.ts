import { describe, expect, it } from "vitest";

import { CheckStatus, dispatchWithBrowserAdapter, type BrowserAdapterCapabilities, type Check } from "@lemma/core";
import { VibiumBrowserAdapter, createVibiumBrowserAdapter } from "../../src/index.js";

function makeCheck(id: string): Check {
  return {
    id,
    title: id,
    domain: "functional",
    persona: "functional",
    kind: "browser",
    intent: "test",
    expected: "test",
    base_weight: 1,
    status: CheckStatus.PLANNED,
    weight: 1,
    actual: "",
    evidence: [],
    finding_ids: [],
    skip_reason: "",
    metadata: {},
  } as any;
}

describe("LEM-192 Vibium integration", () => {
  it("invokes native CLI with arguments preserved verbatim and records adapter/native versions in evidence metadata", async () => {
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const adapter = createVibiumBrowserAdapter({
      args: ["run", "--suite", "smoke", "--flag", "value with spaces"],
      cwd: "/tmp/project",
      runner: {
        async run(args, options) {
          calls.push({ args: [...args], cwd: options?.cwd });
          return {
            ok: true,
            exitCode: 0,
            stdout: JSON.stringify({
              native_version: "vibium-cli 2.3.4",
              checks: {
                "browser.load": {
                  status: "passed",
                  actual: "Vibium ok",
                  evidence_handles: { screenshot: "evidence/vibium/screen.png" },
                  artifacts: { console: "evidence/vibium/console.json", network: ["evidence/vibium/net.har"] },
                },
              },
            }),
            stderr: "",
          };
        },
        async version() { return "2.3.4"; },
        async isAvailable() { return { available: true }; },
      },
    });

    expect(adapter).toBeInstanceOf(VibiumBrowserAdapter);
    expect(adapter.id).toBe("vibium");
    expect(typeof adapter.version).toBe("string");

    const { outcomes } = await dispatchWithBrowserAdapter(adapter, { url: "https://example.test", checks: [makeCheck("browser.load")], options: {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["run", "--suite", "smoke", "--flag", "value with spaces"]); // preserved verbatim
    expect(calls[0]!.cwd).toBe("/tmp/project");

    const out = outcomes.get("browser.load") as any;
    expect(out.status).toBe(CheckStatus.PASSED);
    expect(out.actual).toBe("Vibium ok");
    expect(out.evidence).toEqual(expect.arrayContaining(["evidence/vibium/screen.png", "evidence/vibium/console.json", "evidence/vibium/net.har"]));
    // adapter/native CLI versions recorded in evidence/metadata
    expect(out.metadata?.vibium_adapter_version).toBe(adapter.version);
    expect(out.metadata?.adapter_version).toBe(adapter.version);
    expect(out.metadata?.vibium_cli_version === "2.3.4" || out.metadata?.vibium_cli_version === "vibium-cli 2.3.4").toBe(true);
    expect(out.metadata?.vibium_args).toEqual(["run", "--suite", "smoke", "--flag", "value with spaces"]);
  });

  it("translates Vibium results to CheckOutcome shape and handles failure/error payloads", async () => {
    const adapter = createVibiumBrowserAdapter({
      args: ["run"],
      runner: {
        async run() {
          return {
            ok: false,
            exitCode: 2,
            stdout: JSON.stringify({
              checks: {
                "browser.load": { status: "failed", actual: "boom", findings: [{ title: "x", severity: "high" }] },
              },
            }),
            stderr: "",
          };
        },
        async version() { return "1.0.0"; },
        async isAvailable() { return { available: true }; },
      },
    });

    const { outcomes } = await dispatchWithBrowserAdapter(adapter, { url: "https://example.test", checks: [makeCheck("browser.load")], options: {} });
    const out = outcomes.get("browser.load") as any;
    expect(out.status).toBe(CheckStatus.FAILED);
    expect(out.actual).toBe("boom");
    expect(Array.isArray(out.findings)).toBe(true);
    expect(out.metadata?.vibium_cli_version).toBe("1.0.0");
  });

  it("declares capabilities and re-plans unsupported/missing channels per LEM-191 (no fabricated pass)", async () => {
    const caps: BrowserAdapterCapabilities = {
      navigation: true, screenshots: true, console: false, network: false, storage: false, viewport: false, crawl: false,
    };
    let invoked = 0;
    const adapter = createVibiumBrowserAdapter({
      declaredCapabilities: caps,
      runner: {
        async run() { invoked++; return { ok: true, exitCode: 0, stdout: JSON.stringify({ checks: { "browser.load": { status: "passed", actual: "ok" } } }), stderr: "" }; },
        async version() { return "1.0.0"; },
        async isAvailable() { return { available: true }; },
      },
    });
    expect(adapter.capabilities().console).toBe(false);
    expect(adapter.capabilities().crawl).toBe(false);

    const checks = [makeCheck("browser.load"), makeCheck("browser.console")];
    const { outcomes } = await dispatchWithBrowserAdapter(adapter, { url: "https://example.test", checks, options: {} });
    expect(outcomes.get("browser.load")?.status).toBe(CheckStatus.PASSED);
    const consoleOut = outcomes.get("browser.console") as any;
    expect(consoleOut.status).toBe(CheckStatus.SKIPPED);
    expect(consoleOut.metadata?.replanned).toBe(true);
    expect(consoleOut.metadata?.not_a_pass).toBe(true);
    expect(consoleOut.metadata?.missing_channels).toContain("console");
    expect(invoked).toBe(1); // only dispatched checks run via CLI
  });

  it("blocks when Vibium is unavailable (mirrors LEM-050, no false pass)", async () => {
    const adapter = createVibiumBrowserAdapter({
      args: ["run"],
      runner: {
        async run() { return { ok: false, exitCode: null, stdout: "", stderr: "", error: "Vibium CLI not found: vibium" }; },
        async version() { return null; },
        async isAvailable() { return { available: false, reason: "Vibium CLI not found: vibium" }; },
      },
    });

    const { outcomes, result } = await dispatchWithBrowserAdapter(adapter, { url: "https://example.test", checks: [makeCheck("browser.load"), makeCheck("browser.console")], options: {} });
    expect(result.replanned_checks.length).toBe(0); // blocked at runtime, not channel re-plan
    for (const id of ["browser.load", "browser.console"]) {
      const out = outcomes.get(id) as any;
      expect(out.status).toBe(CheckStatus.BLOCKED);
      expect(out.findings ?? []).toEqual([]);
      expect(String(out.metadata?.limitation || out.blocker?.boundary || out.actual || "")).toMatch(/unavailable|not found|vibium/i);
    }
  });
});
