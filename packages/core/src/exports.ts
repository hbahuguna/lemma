import { redactText, redactUnknown, sanitizeUrl } from "./redaction.js";

export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json" as const;
export const SARIF_VERSION = "2.1.0" as const;

const SENSITIVE_INLINE_KEY_RE =
  /((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|token|access[_-]?token|id[_-]?token|refresh[_-]?token|secret|client_secret|password|passwd|session|jwt)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s,;]+)/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function isSensitiveKey(keyHint: string): boolean {
  return /(token|secret|password|passwd|api[_-]?key|authorization|cookie|session|jwt|credential)/i.test(keyHint);
}

function redactExportString(value: string): string {
  let text = value;
  // sanitize obvious embedded URLs first
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (m) => {
    try {
      return sanitizeUrl(m);
    } catch {
      return m;
    }
  });
  // core text redaction first (handles bearer/JWT/common tokens), then inline key=value forms
  text = redactText(text);
  text = text.replace(SENSITIVE_INLINE_KEY_RE, (_m, prefix: string) => `${prefix}[REDACTED]`);
  // second pass for overlapping cases
  return redactText(text);
}

function redactForExport(value: unknown, keyHint = ""): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (isSensitiveKey(keyHint)) return "[REDACTED]";
    return redactExportString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactForExport(item));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactForExport(v, k);
      }
    }
    return out;
  }
  // fallback through core redaction
  return redactUnknown(value, keyHint);
}

function sarifLevel(severity: unknown): "error" | "warning" | "note" {
  const sev = asString(severity).toLowerCase();
  if (sev === "critical" || sev === "high") return "error";
  if (sev === "medium") return "warning";
  return "note";
}

export function buildSarif(reportInput: Record<string, unknown>): Record<string, unknown> {
  const report = redactForExport(reportInput) as Record<string, unknown>;
  const findingsRaw = Array.isArray(report.findings) ? report.findings : [];
  const rules: Array<Record<string, unknown>> = [];
  const ruleIds = new Set<string>();
  const results: Array<Record<string, unknown>> = [];

  for (const item of findingsRaw) {
    if (!isRecord(item)) continue;
    const finding = item;
    const checkId = asString(finding.check_id || finding.id || "finding");
    const ruleId = `quality-harness/${checkId}`;
    const title = asString(finding.title || checkId);
    const consequence = asString(finding.consequence);
    const remediation = asString(finding.remediation);
    const severity = asString(finding.severity);

    if (!ruleIds.has(ruleId)) {
      ruleIds.add(ruleId);
      rules.push({
        id: ruleId,
        name: checkId,
        shortDescription: { text: title },
        fullDescription: { text: consequence },
        help: { text: remediation },
        defaultConfiguration: { level: sarifLevel(severity) },
        properties: {
          severity: finding.severity,
          domain: finding.domain,
          tags: Array.isArray(finding.tags) ? finding.tags : [],
        },
      });
    }

    const locationUri = asString(finding.location);
    const messageParts = [title];
    if (consequence) messageParts.push(`Consequence: ${consequence}`);
    if (remediation) messageParts.push(`Remediation: ${remediation}`);
    const result: Record<string, unknown> = {
      ruleId,
      level: sarifLevel(severity),
      message: { text: messageParts.join("\n\n") },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: locationUri },
          },
        },
      ],
      properties: {
        fingerprint: asString(finding.fingerprint),
        persona: asString(finding.persona),
        strength: asString(finding.strength),
        check_id: checkId,
      },
    };

    if (Array.isArray(finding.evidence) && finding.evidence.length > 0) {
      result.relatedLocations = finding.evidence.map((path, index) => ({
        id: index,
        physicalLocation: {
          artifactLocation: { uri: asString(path) },
        },
      }));
    }

    results.push(result);
  }

  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: "quality-harness",
            informationUri: "https://github.com/hbahuguna/lemma",
            rules,
          },
        },
        results,
      },
    ],
  };
}
