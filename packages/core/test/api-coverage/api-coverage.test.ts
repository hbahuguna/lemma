import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { runApiCoverage, type ApiCoverageReport } from "../../src/index.js";
import { SsrfError } from "../../src/errors.js";

function loadSchema() {
  return JSON.parse(readFileSync(new URL("../../../../schemas/api/coverage_report.v1.json", import.meta.url), "utf8"));
}

function validateAgainstSchema(report: ApiCoverageReport, schema: any): string[] {
  const errs: string[] = [];
  if (report.schema_version !== schema.properties.schema_version.const) errs.push("schema_version");
  for (const k of schema.required || []) if (!(k in report)) errs.push(`missing:${k}`);
  for (const c of report.cases || []) {
    if (!schema.properties.cases.items.properties.class.enum.includes(c.class)) errs.push(`bad-class:${c.class}`);
    if (!c.source?.type || !c.source?.ref) errs.push("bad-source");
    if (c.ui_flow !== "unknown" && !(c.ui_flow && c.ui_flow.operation && c.ui_flow.screen && c.ui_flow.user_journey)) errs.push("bad-ui-flow");
  }
  return errs;
}

describe("LEM-193 OpenAPI-driven API coverage", () => {
  it("generates cases across six documented classes with source citation and cap enforcement", async () => {
    const spec = {
      paths: {
        "/users": { get: { operationId: "listUsers" }, post: { operationId: "createUser" } },
      },
    };
    const report = await runApiCoverage({ spec, target: "https://example.test", maxCases: 7, runId: "run-cap", resolver: async () => ["93.184.216.34"] });
    expect(report.status).toBe("completed");
    expect(report.safe_target_validated).toBe(true);
    expect(report.max_cases).toBe(7);
    expect(report.cases.length).toBe(7);
    expect(report.summary.capped).toBe(true);
    const classes = new Set(report.cases.map((c) => c.class));
    expect(["positive", "negative", "boundary", "auth", "tenant", "idempotency"].every((c) => classes.has(c as any))).toBe(true);
    for (const c of report.cases) {
      expect(c.source.type).toBe("spec_operation");
      expect(typeof c.source.ref).toBe("string");
      expect(c.source.ref.length).toBeGreaterThan(0);
      expect(c.operation.length).toBeGreaterThan(0);
    }
  });

  it("cites observed traffic sources and maps API failures to UI flows; unmapped failures flagged ui_flow unknown", async () => {
    const traffic = [
      { operation: "GET /orders", method: "GET", path: "/orders", ui_flow: { operation: "GET /orders", screen: "Orders", user_journey: "View orders" } },
      { operation: "POST /orders", method: "POST", path: "/orders" },
    ];
    const report = await runApiCoverage({
      traffic,
      target: "https://example.test",
      maxCases: 12,
      runId: "run-map",
      resolver: async () => ["93.184.216.34"],
      execute: async ({ case: c }) => {
        if (c.class === "auth") return { ok: false, status: 401, error: "unauthorized" };
        return { ok: true, status: 200 };
      },
    });

    expect(report.traffic_source).toBe("provided");
    const mapped = report.cases.find((c) => c.operation === "GET /orders" && c.class === "auth");
    const unmapped = report.cases.find((c) => c.operation === "POST /orders" && c.class === "auth");
    expect(mapped?.failure?.message).toMatch(/unauthorized/i);
    expect(mapped?.ui_flow).toEqual({ operation: "GET /orders", screen: "Orders", user_journey: "View orders" });
    expect(unmapped?.failure).toBeTruthy();
    expect(unmapped?.ui_flow).toBe("unknown");
    expect(report.summary.failures).toBeGreaterThan(0);
    expect(report.summary.mapped_failures).toBeGreaterThan(0);
    expect(report.summary.unmapped_failures).toBeGreaterThan(0);

    // schema validation
    const schema = loadSchema();
    expect(validateAgainstSchema(report, schema)).toEqual([]);
  });

  it("rejects non-safe targets before any request (LEM-059 SSRF rules)", async () => {
    let executed = 0;
    await expect(runApiCoverage({
      spec: { paths: { "/x": { get: {} } } },
      target: "http://127.0.0.1:8080",
      execute: async () => { executed++; return { ok: true, status: 200 }; },
    })).rejects.toBeInstanceOf(SsrfError);
    expect(executed).toBe(0);
  });
});
