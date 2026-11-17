import path from "node:path";

import { describe, expect, it } from "vitest";

import { SsrfError } from "@lemma/core";

import {
  ProUnavailableError,
  extractPrivateCloudSettingsFromProPlan,
  injectHeaders,
  redactHeaders,
  runPrivateCloudDeploymentDryRun,
  validatePrivateCloudProSettings,
  validateTunnelOrProxyTarget,
  validateTunnelsProxies,
} from "../../src/index.js";

const repoRoot = path.resolve(__dirname, "../../../..");
const licensed = { verification: true };

describe("LEM-205 private-cloud deployment support", () => {
  it("deployment dry-run: assets present and data-flow assertions (VPC-only, only documented outbound, disable-able)", () => {
    const result = runPrivateCloudDeploymentDryRun(repoRoot);
    expect(result.ok).toBe(true);
    expect(result.data_flow.state_evidence_reports_in_vpc).toBe(true);
    expect(result.data_flow.license_validation_outbound).toEqual({ enabled: true, documented: true, disableable: true });
    expect(result.data_flow.tunnels_proxies_outbound).toEqual({ enabled: false, documented: true, disableable: true });
    expect(result.data_flow.no_other_outbound_documented).toBe(true);

    const failed = result.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
  });

  it("tunnel/proxy validation configured via Pro-tier settings schema (LEM-197) and unsafe-target rejection per LEM-059", async () => {
    const plan = {
      schema_version: "lemma.pro.steered_plan/v1",
      context: {
        private_cloud: {
          schema_version: "lemma.deploy.private_cloud_config/v1",
          data_flow: {
            state_evidence_reports_in_vpc: true,
            license_validation_outbound: { enabled: true },
            tunnels_proxies_outbound: { enabled: true },
          },
          tunnels_proxies: [
            { name: "preprod", type: "tunnel", target: "https://preprod.example.com", enabled: true },
          ],
          custom_headers: { "x-tenant": "acme" },
        },
      },
    };

    const extracted = extractPrivateCloudSettingsFromProPlan(plan);
    expect(extracted.pro_tier_settings_ref).toContain("LEM-197");
    expect(extracted.tunnels_proxies[0]!.target).toBe("https://preprod.example.com");

    const resolver = async (hostname: string) => {
      if (hostname === "preprod.example.com") return ["93.184.216.34"]; // public
      if (hostname === "metadata.internal") return ["169.254.169.254"];
      return ["93.184.216.34"];
    };

    const validated = await validatePrivateCloudProSettings({ plan }, { license: licensed, resolver });
    expect(validated.tunnels[0]!.name).toBe("preprod");
    expect(validated.config.data_flow?.state_evidence_reports_in_vpc).toBe(true);

    // unsafe targets rejected per LEM-059
    await expect(validateTunnelOrProxyTarget("http://169.254.169.254/latest/meta-data", { resolver })).rejects.toBeInstanceOf(SsrfError);
    await expect(validateTunnelsProxies([{ name: "bad", type: "proxy", target: "http://127.0.0.1:8080", enabled: true }], { enabled: true, resolver })).rejects.toBeInstanceOf(SsrfError);

    // when globally disabled, entries can be present but not validated as active outbound targets
    const disabled = await validateTunnelsProxies([{ name: "local", type: "proxy", target: "http://127.0.0.1:8080", enabled: true }], { enabled: false, resolver });
    expect(disabled.disabledByConfig).toBe(true);
    expect(disabled.valid[0]!.target).toBe("http://127.0.0.1:8080");

    // license gate
    await expect(validatePrivateCloudProSettings({ plan }, { license: null, resolver })).rejects.toBeInstanceOf(ProUnavailableError);
  });

  it("custom header injection supports redaction (no raw secrets persisted in redacted form)", () => {
    const { headers, redacted } = injectHeaders(
      { "content-type": "application/json" },
      { Authorization: "Bearer super-secret-token", "X-Api-Key": "abc123", "X-Tenant": "acme" },
      { redact: false },
    );

    expect(headers.Authorization).toBe("Bearer super-secret-token");
    expect(headers["X-Api-Key"]).toBe("abc123");
    expect(headers["X-Tenant"]).toBe("acme");

    expect(redacted.Authorization).not.toContain("super-secret-token");
    expect(redacted["X-Api-Key"]).not.toBe("abc123");
    expect(redacted["X-Tenant"]).toBe("acme");

    const onlyRedacted = redactHeaders({ Cookie: "session=secret", Accept: "text/html" });
    expect(onlyRedacted.Cookie).not.toContain("secret");
    expect(onlyRedacted.Accept).toBe("text/html");

    const safeForStorage = JSON.stringify(redacted);
    expect(safeForStorage).not.toContain("super-secret-token");
    expect(safeForStorage).not.toContain("abc123");
  });
});
