import { Severity, normalizeRisk, type Risk, type Target } from "./models.js";

export const PRIORITY_MULTIPLIER: Record<string, number> = {
  [Severity.CRITICAL]: 1.7,
  [Severity.HIGH]: 1.4,
  [Severity.MEDIUM]: 1.15,
  [Severity.LOW]: 1.0,
  [Severity.INFO]: 0.9,
};

export interface InventoryLike {
  available?: boolean;
  root?: string;
  source_files?: string[];
  test_files?: string[];
  markup_files?: string[];
  ci_files?: string[];
  manifests?: string[];
  lockfiles?: string[];
  env_files?: string[];
  env_files_tracked?: string[];
  tracked_available?: boolean;
  [key: string]: unknown;
}

export interface IntentRule {
  keywords: readonly string[];
  title: string;
  domain: string;
  priority: string;
  consequence: string;
}

export const INTENT_RULES: readonly IntentRule[] = [
  {
    keywords: ["login", "sign in", "sign-in", "auth", "password", "session", "sso", "identity"],
    title: "Identity and session boundaries may fail open",
    domain: "security",
    priority: Severity.HIGH,
    consequence: "Account takeover, broken authorization, or a session that outlives the customer's intent.",
  },
  {
    keywords: ["checkout", "payment", "purchase", "billing", "invoice", "subscription", "plan", "usage", "pricing"],
    title: "Money, entitlements, and usage accounting may be wrong",
    domain: "security",
    priority: Severity.HIGH,
    consequence: "Customers can be overcharged, undercharged, or granted entitlements they did not buy.",
  },
  {
    keywords: ["signup", "onboarding", "self-serve", "self serve", "trial", "upgrade"],
    title: "The self-serve activation path may lose or mislead a new customer",
    domain: "functional",
    priority: Severity.HIGH,
    consequence: "A customer cannot reach first value, or reaches a paid state without understanding the commitment.",
  },
  {
    keywords: ["accessibility", "a11y", "wcag", "keyboard", "screen reader", "contrast"],
    title: "Disabled customers may be unable to complete the primary journey",
    domain: "accessibility",
    priority: Severity.HIGH,
    consequence: "Keyboard, low-vision, and assistive-technology users are excluded from the product.",
  },
  {
    keywords: ["upload", "import", "file", "paste", "webhook", "parser"],
    title: "Untrusted input may cross a parser or storage boundary",
    domain: "security",
    priority: Severity.HIGH,
    consequence: "Malicious input can execute code, exhaust resources, or expose another tenant's data.",
  },
  {
    keywords: ["search", "catalog", "content", "copy", "localization", "locale"],
    title: "Customers may not find or understand the intended content",
    domain: "content",
    priority: Severity.MEDIUM,
    consequence: "The task looks complete but the result is missing, ambiguous, or wrong for the locale.",
  },
  {
    keywords: ["performance", "latency", "speed", "load", "scale"],
    title: "User-visible latency may exceed the customer's patience",
    domain: "performance",
    priority: Severity.MEDIUM,
    consequence: "Customers abandon the journey or the release collapses under normal peak load.",
  },
  {
    keywords: ["api", "webhook", "integration", "sync", "export"],
    title: "Machine-to-machine contracts may drift or fail silently",
    domain: "data_integrity",
    priority: Severity.HIGH,
    consequence: "Downstream systems receive partial, duplicated, or malformed data without a visible failure.",
  },
];

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return asArray(value).filter((v): v is string => typeof v === "string");
}

export class RiskAnalyzer {
  private readonly target: Target;
  private readonly intent: string;
  private readonly inventory: InventoryLike;
  private readonly browserPlanned: boolean;

  constructor(target: Target, intent: string, inventory: InventoryLike, browserPlanned: boolean) {
    this.target = target;
    this.intent = intent || "";
    this.inventory = inventory || {};
    this.browserPlanned = browserPlanned;
  }

  analyze(): Risk[] {
    const risks: Risk[] = [];
    const intentLower = this.intent.toLowerCase();

    if (this.intent) {
      risks.push(
        normalizeRisk({
          id: "risk-01",
          title: "The stated customer outcome may not be delivered",
          priority: Severity.HIGH,
          domain: "functional",
          consequence: "The release can pass technical checks while failing the job the customer came to do.",
          evidence: [`Intent: ${this.intent}`],
          weight_multiplier: PRIORITY_MULTIPLIER[Severity.HIGH],
          source: "intent",
          status: "open",
        }),
      );
    }

    risks.push(
      normalizeRisk({
        id: "risk-02",
        title: "Evidence scope may be narrower than the release decision",
        priority: Severity.MEDIUM,
        domain: "reliability",
        consequence: "A confident report can hide untested surfaces, making the ship decision look safer than it is.",
        evidence: [
          `Target kind: ${this.target.kind}`,
          `Browser checks planned: ${this.browserPlanned}`,
          `Source inspection available: ${asBool(this.inventory.available, false)}`,
        ],
        weight_multiplier: PRIORITY_MULTIPLIER[Severity.MEDIUM],
        source: "scope",
        status: "open",
      }),
    );

    if (this.target.kind === "url") {
      risks.push(
        normalizeRisk({
          id: "risk-03",
          title: "The live surface may expose transport, session, or runtime defects",
          priority: Severity.HIGH,
          domain: "security",
          consequence: "A visitor can lose a session, trust a tampered response, or see a broken page.",
          evidence: [`Live URL: ${this.target.resolved}`],
          weight_multiplier: PRIORITY_MULTIPLIER[Severity.HIGH],
          source: "target",
          status: "open",
        }),
      );
    } else if (!this.browserPlanned) {
      risks.push(
        normalizeRisk({
          id: "risk-03",
          title: "Source-only evidence cannot establish rendered behavior",
          priority: Severity.MEDIUM,
          domain: "functional",
          consequence: "A page can compile and still fail for a real customer because Operate coverage is absent.",
          evidence: ["No URL target was supplied."],
          weight_multiplier: PRIORITY_MULTIPLIER[Severity.MEDIUM],
          source: "target",
          status: "open",
        }),
      );
    }

    for (const rule of INTENT_RULES) {
      if (rule.keywords.some((keyword) => intentLower.includes(keyword))) {
        risks.push(
          normalizeRisk({
            id: "",
            title: rule.title,
            priority: rule.priority,
            domain: rule.domain,
            consequence: rule.consequence,
            evidence: [`Intent keyword match: ${rule.keywords.join(", ")}`],
            weight_multiplier: PRIORITY_MULTIPLIER[rule.priority] ?? 1.0,
            source: "intent",
            status: "open",
          }),
        );
      }
    }

    if (asBool(this.inventory.available, false)) {
      const testFiles = stringArray(this.inventory.test_files);
      const ciFiles = stringArray(this.inventory.ci_files);
      const manifests = stringArray(this.inventory.manifests);
      const lockfiles = stringArray(this.inventory.lockfiles);
      const markupFiles = stringArray(this.inventory.markup_files);

      if (testFiles.length === 0) {
        risks.push(
          normalizeRisk({
            id: "",
            title: "No automated regression signal protects this change",
            priority: Severity.MEDIUM,
            domain: "functional",
            consequence: "A regression can ship without a repeatable failing check.",
            evidence: ["0 test/spec files found under the source root."],
            weight_multiplier: PRIORITY_MULTIPLIER[Severity.MEDIUM],
            source: "inventory",
            status: "open",
          }),
        );
      }
      if (ciFiles.length === 0) {
        risks.push(
          normalizeRisk({
            id: "",
            title: "Test evidence is not refreshed by continuous integration",
            priority: Severity.LOW,
            domain: "reliability",
            consequence: "Local evidence can become stale before the next release.",
            evidence: ["No CI configuration found."],
            weight_multiplier: PRIORITY_MULTIPLIER[Severity.LOW],
            source: "inventory",
            status: "open",
          }),
        );
      }

      const trackedAvailable = asBool(this.inventory.tracked_available, false);
      const trackedEnvFiles = trackedAvailable
        ? stringArray(this.inventory.env_files_tracked)
        : stringArray(this.inventory.env_files);
      if (trackedEnvFiles.length > 0) {
        risks.push(
          normalizeRisk({
            id: "",
            title: "Committed environment files may expose live configuration",
            priority: Severity.HIGH,
            domain: "security",
            consequence: "Credentials or internal endpoints may be readable by anyone with repository access.",
            evidence: [`Committed env files: ${trackedEnvFiles.slice(0, 5).join(", ")}`],
            weight_multiplier: PRIORITY_MULTIPLIER[Severity.HIGH],
            source: "inventory",
            status: "open",
          }),
        );
      }

      if (manifests.length > 0 && lockfiles.length === 0) {
        risks.push(
          normalizeRisk({
            id: "",
            title: "Dependency resolution is not reproducible",
            priority: Severity.LOW,
            domain: "data_integrity",
            consequence: "Two builds can execute different dependency code under the same release label.",
            evidence: ["Manifests without a lockfile."],
            weight_multiplier: PRIORITY_MULTIPLIER[Severity.LOW],
            source: "inventory",
            status: "open",
          }),
        );
      }

      if (markupFiles.length > 0) {
        risks.push(
          normalizeRisk({
            id: "",
            title: "Rendered interfaces may carry accessibility barriers",
            priority: Severity.MEDIUM,
            domain: "accessibility",
            consequence: "Some customers cannot perceive, navigate, or operate the interface.",
            evidence: [`${markupFiles.length} markup/component files found.`],
            weight_multiplier: PRIORITY_MULTIPLIER[Severity.MEDIUM],
            source: "inventory",
            status: "open",
          }),
        );
      }
    }

    return this.dedupeAndNumber(risks);
  }

  private dedupeAndNumber(risks: Risk[]): Risk[] {
    const seen = new Set<string>();
    const unique: Risk[] = [];
    for (const risk of risks) {
      const key = risk.title.toLowerCase().replace(/\W+/g, " ").trim();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(risk);
    }
    const limited = unique.slice(0, 12);
    for (let i = 0; i < limited.length; i++) {
      const risk = limited[i];
      if (risk) risk.id = `risk-${String(i + 1).padStart(2, "0")}`;
    }
    return limited;
  }
}

export function analyzeRisk(
  target: Target,
  intent: string,
  inventory: InventoryLike,
  browserPlanned: boolean,
): Risk[] {
  return new RiskAnalyzer(target, intent, inventory, browserPlanned).analyze();
}
