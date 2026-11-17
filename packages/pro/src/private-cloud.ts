import fs from "node:fs";
import path from "node:path";

import { SsrfError, StateError, redactText, validateUrl } from "@lemma/core";

import { ProUnavailableError, isProLicensed, type ProLicenseContext } from "./entitlement.js";

export const PRIVATE_CLOUD_CONFIG_SCHEMA_VERSION = "lemma.deploy.private_cloud_config/v1" as const;
export const PRO_TIER_SETTINGS_SCHEMA_REF = "schemas/pro/steered_plan.v1.json (LEM-197)" as const;

export interface TunnelProxyConfig {
  name: string;
  type: "tunnel" | "proxy";
  target: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface PrivateCloudDataFlow {
  state_evidence_reports_in_vpc: true;
  license_validation_outbound: { enabled: boolean; description?: string };
  tunnels_proxies_outbound: { enabled: boolean; description?: string };
}

export interface PrivateCloudConfig {
  schema_version?: string;
  data_flow?: Partial<PrivateCloudDataFlow>;
  tunnels_proxies?: TunnelProxyConfig[];
  custom_headers?: Record<string, string>;
  pro_tier_settings_ref?: string;
  [key: string]: unknown;
}

function assertLicensed(license: ProLicenseContext | null | undefined): void {
  if (!isProLicensed(license ?? null)) throw new ProUnavailableError("private-cloud deployment support");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const SENSITIVE_HEADER_RE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
const SENSITIVE_VALUE_RE = /(bearer\s+[^\s]+|api[_-]?key\s*[:=]|secret|token|password|-----begin)/i;

export function redactHeaders(headers: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(headers)) return out;
  for (const [k, v] of Object.entries(headers)) {
    const name = String(k);
    const raw = typeof v === "string" ? v : JSON.stringify(v);
    if (SENSITIVE_HEADER_RE.test(name) || SENSITIVE_VALUE_RE.test(raw)) {
      const red = redactText(raw);
      out[name] = !red || red === raw ? "[REDACTED]" : red;
    } else {
      out[name] = redactText(raw);
    }
  }
  return out;
}

/** Apply custom header injection with redaction for persistence/logging surfaces. */
export function injectHeaders(
  base: Record<string, string> | null | undefined,
  custom: Record<string, string> | null | undefined,
  opts: { redact?: boolean } = {},
): { headers: Record<string, string>; redacted: Record<string, string> } {
  const merged: Record<string, string> = { ...(base || {}) };
  const customSafe = isRecord(custom) ? custom : {};
  for (const [k, v] of Object.entries(customSafe)) merged[String(k)] = typeof v === "string" ? v : String(v);
  const redacted = redactHeaders(merged);
  return { headers: opts.redact ? { ...redacted } : merged, redacted };
}

export async function validateTunnelOrProxyTarget(target: string, options: { allowlist?: Iterable<unknown> | null; root?: string | null; resolver?: any } = {}): Promise<void> {
  // Unsafe targets rejected per LEM-059 (SSRF validation)
  await validateUrl(target, { allowlist: options.allowlist ?? null, root: options.root ?? null, resolver: options.resolver ?? null });
}

export async function validateTunnelsProxies(
  entries: TunnelProxyConfig[] | unknown,
  options: { enabled?: boolean; allowlist?: Iterable<unknown> | null; root?: string | null; resolver?: any } = {},
): Promise<{ valid: TunnelProxyConfig[]; disabledByConfig: boolean }> {
  const list = Array.isArray(entries) ? entries : [];
  const valid: TunnelProxyConfig[] = [];
  const globalEnabled = options.enabled !== false;
  for (const item of list) {
    if (!isRecord(item)) throw new StateError("Tunnel/proxy entry must be an object", { details: { entry: item } });
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : "";
    const type = item.type === "tunnel" || item.type === "proxy" ? item.type : null;
    const target = typeof item.target === "string" ? item.target.trim() : "";
    if (!name || !type || !target) {
      throw new StateError("Tunnel/proxy entry requires name, type (tunnel|proxy), and target", { details: { name, type, target } });
    }
    const enabled = item.enabled !== false;
    if (enabled && globalEnabled) {
      // validate unsafe targets per LEM-059 when active
      await validateTunnelOrProxyTarget(target, options);
    }
    valid.push({
      ...item,
      name,
      type,
      target,
      enabled,
      headers: redactHeaders((item.headers as any) || {}),
    } as TunnelProxyConfig);
  }
  return { valid, disabledByConfig: !globalEnabled };
}

/** Extract/validate private-cloud + tunnels/proxies configured via Pro-tier settings schema (LEM-197). */
export function extractPrivateCloudSettingsFromProPlan(plan: any): PrivateCloudConfig {
  const ctx = isRecord(plan?.context) ? plan.context : {};
  const pc = (isRecord((ctx as any).private_cloud) ? (ctx as any).private_cloud : isRecord((plan as any).private_cloud) ? (plan as any).private_cloud : {}) as any;
  const tunnels = Array.isArray(pc.tunnels_proxies) ? pc.tunnels_proxies : (Array.isArray((ctx as any).tunnels_proxies) ? (ctx as any).tunnels_proxies : []);
  const customHeaders = isRecord(pc.custom_headers) ? pc.custom_headers : (isRecord((ctx as any).custom_headers) ? (ctx as any).custom_headers : {});
  return {
    schema_version: typeof pc.schema_version === "string" ? pc.schema_version : PRIVATE_CLOUD_CONFIG_SCHEMA_VERSION,
    data_flow: isRecord(pc.data_flow) ? (pc.data_flow as any) : undefined,
    tunnels_proxies: tunnels as TunnelProxyConfig[],
    custom_headers: customHeaders as Record<string, string>,
    pro_tier_settings_ref: PRO_TIER_SETTINGS_SCHEMA_REF,
  };
}

export async function validatePrivateCloudProSettings(
  input: { plan?: any; config?: PrivateCloudConfig },
  options: { license?: ProLicenseContext | null; allowlist?: Iterable<unknown> | null; root?: string | null; resolver?: any } = {},
): Promise<{ config: PrivateCloudConfig; tunnels: TunnelProxyConfig[] }> {
  assertLicensed(options.license ?? null);
  const cfg = input.config || extractPrivateCloudSettingsFromProPlan(input.plan || {});
  const df = isRecord(cfg.data_flow) ? cfg.data_flow : {};
  const tunnelsEnabled = isRecord((df as any).tunnels_proxies_outbound) ? (df as any).tunnels_proxies_outbound.enabled !== false : false;
  const tunnels = await validateTunnelsProxies(cfg.tunnels_proxies || [], {
    enabled: tunnelsEnabled || (cfg.tunnels_proxies || []).some((t: any) => t && t.enabled === true),
    allowlist: options.allowlist ?? null,
    root: options.root ?? null,
    resolver: options.resolver ?? null,
  });
  const redactedCustom = redactHeaders((cfg.custom_headers as any) || {});
  return {
    config: {
      ...cfg,
      schema_version: cfg.schema_version || PRIVATE_CLOUD_CONFIG_SCHEMA_VERSION,
      pro_tier_settings_ref: cfg.pro_tier_settings_ref || PRO_TIER_SETTINGS_SCHEMA_REF,
      tunnels_proxies: tunnels.valid,
      custom_headers: redactedCustom,
      data_flow: {
        state_evidence_reports_in_vpc: true,
        license_validation_outbound: isRecord((df as any).license_validation_outbound) ? (df as any).license_validation_outbound as any : { enabled: true },
        tunnels_proxies_outbound: isRecord((df as any).tunnels_proxies_outbound) ? (df as any).tunnels_proxies_outbound as any : { enabled: false },
      },
    },
    tunnels: tunnels.valid,
  };
}

export interface DeploymentDryRunResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  data_flow: {
    state_evidence_reports_in_vpc: boolean;
    license_validation_outbound: { enabled: boolean; documented: boolean; disableable: boolean };
    tunnels_proxies_outbound: { enabled: boolean; documented: boolean; disableable: boolean };
    no_other_outbound_documented: boolean;
  };
}

export function runPrivateCloudDeploymentDryRun(repoRoot: string): DeploymentDryRunResult {
  const root = path.resolve(repoRoot);
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const mustExist = [
    "deploy/private-cloud/Dockerfile",
    "deploy/private-cloud/docker-compose.yml",
    "deploy/private-cloud/helm/lemma-private-cloud/Chart.yaml",
    "deploy/private-cloud/helm/lemma-private-cloud/values.yaml",
    "deploy/private-cloud/config.schema.json",
    "deploy/private-cloud/README.md",
  ];
  for (const rel of mustExist) {
    const p = path.join(root, rel);
    const ok = fs.existsSync(p);
    checks.push({ name: `asset:${rel}`, ok, ...(ok ? {} : { detail: "missing" }) });
  }
  const read = (rel: string) => {
    try { return fs.readFileSync(path.join(root, rel), "utf8"); } catch { return ""; }
  };
  const readme = read("deploy/private-cloud/README.md");
  const compose = read("deploy/private-cloud/docker-compose.yml");
  const schema = read("deploy/private-cloud/config.schema.json");

  const licenseDoc = /licen[cs]e validation/i.test(readme) && /disable/i.test(readme) && /LEMMA_LICENSE_VALIDATION/i.test(compose);
  const tunnelDoc = /tunnels?\/proxies|tunnels_proxies/i.test(readme) && /disable/i.test(readme) && /LEMMA_TUNNELS_PROXIES/i.test(compose);
  const lem059 = /LEM-059/.test(readme) && /unsafe targets? are rejected/i.test(readme);
  const lem197 = /LEM-197/.test(readme) && /Pro-tier settings schema/i.test(readme);
  const redaction = /redact/i.test(readme) && /custom header/i.test(readme);
  const upgrade = /Upgrade path/i.test(readme);
  const vpcOnly = /all state, evidence, and reports remain inside the VPC/i.test(readme);
  const schemaRef = /lemma\.deploy\.private_cloud_config\/v1/.test(schema);

  checks.push({ name: "data_flow:license_validation_documented_disableable", ok: licenseDoc });
  checks.push({ name: "data_flow:tunnels_proxies_documented_disableable", ok: tunnelDoc });
  checks.push({ name: "validation:LEM-059_referenced", ok: lem059 });
  checks.push({ name: "config:LEM-197_referenced", ok: lem197 });
  checks.push({ name: "headers:redaction_documented", ok: redaction });
  checks.push({ name: "docs:upgrade_path", ok: upgrade });
  checks.push({ name: "docs:vpc_data_residency", ok: vpcOnly });
  checks.push({ name: "schema:versioned", ok: schemaRef });

  const ok = checks.every((c) => c.ok);
  return {
    ok,
    checks,
    data_flow: {
      state_evidence_reports_in_vpc: vpcOnly,
      license_validation_outbound: { enabled: true, documented: licenseDoc, disableable: licenseDoc },
      tunnels_proxies_outbound: { enabled: false, documented: tunnelDoc, disableable: tunnelDoc },
      no_other_outbound_documented: /No other outbound traffic is required or performed by default/i.test(readme),
    },
  };
}

export { SsrfError };
