import { HarnessError } from "./errors.js";
import { CheckStatus } from "./models.js";
import { now } from "./determinism.js";
import { sha256Bytes } from "./evidence.js";
import { ownershipErrorMessage } from "./personas.js";
import type { Check, Risk, Target } from "./models.js";

export interface CheckDefinition {
  id: string;
  title: string;
  domain: string;
  kind: string;
  intent: string;
  expected: string;
  base_weight: number;
  requires: string;
  persona: string;
}

export interface CheckRegistryLike {
  definitions: readonly CheckDefinition[] | CheckDefinition[];
  ids(): string[];
  source(id: string): string;
  blockedReason?(id: string): string;
  block?(id: string, reason: string): void;
  ownerHint?(id: string): string;
}

export interface PersonaLike {
  id: string;
  owns?: readonly string[] | string[];
}

export const ASSAY_CATEGORY_LABELS = [
  "manager",
  "full",
  "test",
  "functionality",
  "browser",
  "issues",
  "demo",
  "more",
  "help",
  "accessibility",
  "ui",
  "ux",
  "usability",
  "personas",
  "compatibility",
  "intl",
  "localization",
  "content",
  "geo",
  "security",
  "security-review",
  "privacy",
  "state",
  "reliability",
  "performance",
  "load",
  "stress",
  "networking",
  "api",
  "data",
  "failure",
  "proof",
  "confidence",
  "confidence-init",
  "confidence-plan",
  "review",
  "skeptical-review",
  "release",
  "release-review",
  "incident",
  "eval",
  "eval-design-review",
  "statistical-review",
  "agentic",
  "chatbot",
  "bias",
  "tests",
  "generate",
  "map",
  "full-report",
  "stats",
  "integrations",
  "ai-upgrade",
  "auto",
  "background",
  "forever",
  "settings",
  "human",
  "pro",
] as const;

export type AssayCategoryLabel = (typeof ASSAY_CATEGORY_LABELS)[number];

export const ASSAY_CATEGORY_INTENT_PREFIX = "Assay ";
export const ASSAY_CATEGORY_INTENT_SUFFIX = " assessment";

export function assayCategoryIntent(label: string): string {
  return `${ASSAY_CATEGORY_INTENT_PREFIX}${label}${ASSAY_CATEGORY_INTENT_SUFFIX}`;
}

export const ASSAY_CATEGORY_INTENTS: readonly string[] = ASSAY_CATEGORY_LABELS.map((label) =>
  assayCategoryIntent(label),
);

export const SPECIAL_CATEGORY_CHECK_IDS: Readonly<Record<string, string>> = {
  full: "static.full_assessment",
  test: "static.test_category",
  functionality: "static.functionality_category",
  browser: "static.browser_category",
  issues: "static.issues_category",
  demo: "static.demo_category",
  more: "static.more_category",
};

export function isGenericCategoryCheckId(id: string): boolean {
  return id.startsWith("static.category.");
}

export function categoryLabelFromCheckId(id: string): string | null {
  if (isGenericCategoryCheckId(id)) return id.slice("static.category.".length);
  for (const [label, checkId] of Object.entries(SPECIAL_CATEGORY_CHECK_IDS)) {
    if (checkId === id) return label;
  }
  return null;
}

export function categoryCheckIdForLabel(label: string): string | null {
  const special = (SPECIAL_CATEGORY_CHECK_IDS as Record<string, string | undefined>)[label];
  if (special) return special;
  if ((ASSAY_CATEGORY_LABELS as readonly string[]).includes(label)) {
    return `static.category.${label}`;
  }
  return null;
}

function normIntent(intent: string): string {
  return (intent || "").toLowerCase();
}

function matchesAssayLabelIntent(textLower: string, label: string): boolean {
  const phrase = `assay ${label} assessment`;
  if (textLower.includes(phrase)) return true;
  if (textLower.includes(`${label} category assessment`)) return true;
  return false;
}

export function matchedAssayCategoryLabel(intent: string): AssayCategoryLabel | null {
  const text = normIntent(intent);
  for (const label of ASSAY_CATEGORY_LABELS) {
    if (matchesAssayLabelIntent(text, label)) return label;
  }
  // backward-compat aliases used by existing helpers/tests
  if (text.includes("full assessment") || text.trim() === "full") return "full";
  return null;
}

export function isFullCategoryIntent(intent: string): boolean {
  return matchedAssayCategoryLabel(intent) === "full";
}

export function isTestCategoryIntent(intent: string): boolean {
  return matchedAssayCategoryLabel(intent) === "test";
}

export function isFunctionalityCategoryIntent(intent: string): boolean {
  return matchedAssayCategoryLabel(intent) === "functionality";
}

export function isBrowserCategoryIntent(intent: string): boolean {
  return matchedAssayCategoryLabel(intent) === "browser";
}

export function isIssuesCategoryIntent(intent: string): boolean {
  return matchedAssayCategoryLabel(intent) === "issues";
}

export function isDemoCategoryIntent(intent: string): boolean {
  return matchedAssayCategoryLabel(intent) === "demo";
}

export function isMoreCategoryIntent(intent: string): boolean {
  return matchedAssayCategoryLabel(intent) === "more";
}

export function categoryCheckIdForIntent(intent: string): string | null {
  const label = matchedAssayCategoryLabel(intent);
  if (!label) return null;
  return categoryCheckIdForLabel(label);
}

export const CHECK_CATALOG: readonly CheckDefinition[] = [
  {
    id: "static.full_assessment",
    title: "Full category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Confirm that a comprehensive full-category assessment was requested and represented.",
    expected:
      "The run intent explicitly requests the full category and the planned scope is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.test_category",
    title: "Test category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent: "Confirm that the test category assessment was requested and represented.",
    expected:
      "The run intent explicitly requests the test category and the planned scope is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.functionality_category",
    title: "Functionality category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Confirm that the functionality category assessment was requested and represented.",
    expected:
      "The run intent explicitly requests the functionality category and the planned scope is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.browser_category",
    title: "Browser category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Confirm that the browser category assessment was requested and represented.",
    expected:
      "The run intent explicitly requests the browser category and the planned scope is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.issues_category",
    title: "Issues category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Confirm that the issues category assessment was requested and represented.",
    expected:
      "The run intent explicitly requests the issues category and the planned scope is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.demo_category",
    title: "Demo category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Confirm that the demo category assessment was requested and represented.",
    expected:
      "The run intent explicitly requests the demo category and the planned scope is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.more_category",
    title: "More category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Confirm that the more/extended assessment category was requested and represented.",
    expected:
      "The run intent explicitly requests the more category and an extended inventory of additional assessment surfaces is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.manager",
    title: "Manager category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the manager category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the manager category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.help",
    title: "Help category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the help category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the help category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.accessibility",
    title: "Accessibility category assessment scope is recorded",
    domain: "accessibility",
    kind: "static",
    intent:
      "Record deterministic scope for the accessibility category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the accessibility category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.ui",
    title: "Ui category assessment scope is recorded",
    domain: "accessibility",
    kind: "static",
    intent:
      "Record deterministic scope for the ui category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the ui category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.ux",
    title: "Ux category assessment scope is recorded",
    domain: "accessibility",
    kind: "static",
    intent:
      "Record deterministic scope for the ux category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the ux category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.usability",
    title: "Usability category assessment scope is recorded",
    domain: "accessibility",
    kind: "static",
    intent:
      "Record deterministic scope for the usability category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the usability category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.personas",
    title: "Personas category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the personas category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the personas category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.compatibility",
    title: "Compatibility category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the compatibility category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the compatibility category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.intl",
    title: "Intl category assessment scope is recorded",
    domain: "content",
    kind: "static",
    intent:
      "Record deterministic scope for the intl category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the intl category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.localization",
    title: "Localization category assessment scope is recorded",
    domain: "content",
    kind: "static",
    intent:
      "Record deterministic scope for the localization category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the localization category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.content",
    title: "Content category assessment scope is recorded",
    domain: "content",
    kind: "static",
    intent:
      "Record deterministic scope for the content category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the content category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.geo",
    title: "Geo category assessment scope is recorded",
    domain: "content",
    kind: "static",
    intent:
      "Record deterministic scope for the geo category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the geo category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.security",
    title: "Security category assessment scope is recorded",
    domain: "security",
    kind: "static",
    intent:
      "Record deterministic scope for the security category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the security category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.security-review",
    title: "Security review category assessment scope is recorded",
    domain: "security",
    kind: "static",
    intent:
      "Record deterministic scope for the security review category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the security review category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.privacy",
    title: "Privacy category assessment scope is recorded",
    domain: "security",
    kind: "static",
    intent:
      "Record deterministic scope for the privacy category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the privacy category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.state",
    title: "State category assessment scope is recorded",
    domain: "security",
    kind: "static",
    intent:
      "Record deterministic scope for the state category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the state category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.reliability",
    title: "Reliability category assessment scope is recorded",
    domain: "reliability",
    kind: "static",
    intent:
      "Record deterministic scope for the reliability category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the reliability category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.performance",
    title: "Performance category assessment scope is recorded",
    domain: "performance",
    kind: "static",
    intent:
      "Record deterministic scope for the performance category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the performance category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.load",
    title: "Load category assessment scope is recorded",
    domain: "performance",
    kind: "static",
    intent:
      "Record deterministic scope for the load category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the load category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.stress",
    title: "Stress category assessment scope is recorded",
    domain: "performance",
    kind: "static",
    intent:
      "Record deterministic scope for the stress category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the stress category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.networking",
    title: "Networking category assessment scope is recorded",
    domain: "reliability",
    kind: "static",
    intent:
      "Record deterministic scope for the networking category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the networking category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.api",
    title: "Api category assessment scope is recorded",
    domain: "data_integrity",
    kind: "static",
    intent:
      "Record deterministic scope for the api category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the api category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.data",
    title: "Data category assessment scope is recorded",
    domain: "data_integrity",
    kind: "static",
    intent:
      "Record deterministic scope for the data category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the data category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.failure",
    title: "Failure category assessment scope is recorded",
    domain: "reliability",
    kind: "static",
    intent:
      "Record deterministic scope for the failure category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the failure category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.proof",
    title: "Proof category assessment scope is recorded",
    domain: "data_integrity",
    kind: "static",
    intent:
      "Record deterministic scope for the proof category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the proof category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.confidence",
    title: "Confidence category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the confidence category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the confidence category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.confidence-init",
    title: "Confidence init category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the confidence init category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the confidence init category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.confidence-plan",
    title: "Confidence plan category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the confidence plan category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the confidence plan category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.review",
    title: "Review category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the review category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the review category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.skeptical-review",
    title: "Skeptical review category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the skeptical review category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the skeptical review category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.release",
    title: "Release category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the release category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the release category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.release-review",
    title: "Release review category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the release review category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the release review category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.incident",
    title: "Incident category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the incident category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the incident category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.eval",
    title: "Eval category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the eval category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the eval category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.eval-design-review",
    title: "Eval design review category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the eval design review category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the eval design review category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.statistical-review",
    title: "Statistical review category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the statistical review category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the statistical review category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.agentic",
    title: "Agentic category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the agentic category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the agentic category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.chatbot",
    title: "Chatbot category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the chatbot category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the chatbot category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.bias",
    title: "Bias category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the bias category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the bias category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.tests",
    title: "Tests category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the tests category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the tests category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.generate",
    title: "Generate category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the generate category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the generate category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.map",
    title: "Map category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the map category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the map category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.full-report",
    title: "Full report category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the full report category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the full report category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.stats",
    title: "Stats category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the stats category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the stats category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.integrations",
    title: "Integrations category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the integrations category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the integrations category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.ai-upgrade",
    title: "Ai upgrade category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the ai upgrade category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the ai upgrade category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.auto",
    title: "Auto category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the auto category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the auto category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.background",
    title: "Background category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the background category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the background category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.forever",
    title: "Forever category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the forever category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the forever category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.settings",
    title: "Settings category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the settings category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the settings category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.human",
    title: "Human category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the human category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the human category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.category.pro",
    title: "Pro category assessment scope is recorded",
    domain: "functional",
    kind: "static",
    intent:
      "Record deterministic scope for the pro category assessment (documented no-op/rationale where no deeper automated check is owned).",
    expected:
      "The run intent explicitly requests the pro category and the planned scope/rationale is recorded as evidence.",
    base_weight: 0.5,
    requires: "any",
    persona: "",
  },
  {
    id: "static.inventory",
    title: "Source and test inventory is complete and readable",
    domain: "functional",
    kind: "static",
    intent: "Know what the release contains before judging it.",
    expected:
      "A readable source tree with an inventory of languages, manifests, tests, and CI.",
    base_weight: 1.0,
    requires: "source",
    persona: "",
  },
  {
    id: "static.secrets",
    title: "No live credentials or private keys are committed",
    domain: "security",
    kind: "static",
    intent:
      "Prevent a release from exposing credentials that grant access beyond the product.",
    expected:
      "No private keys, provider tokens, or high-entropy credentials in tracked source.",
    base_weight: 2.0,
    requires: "source",
    persona: "",
  },
  {
    id: "static.unsafe",
    title: "High-risk code patterns are absent or justified",
    domain: "security",
    kind: "static",
    intent:
      "Reduce remotely triggerable command execution, injection, and transport failures.",
    expected:
      "No unjustified eval, shell execution, unsafe HTML injection, SQL concatenation, or TLS bypass.",
    base_weight: 1.8,
    requires: "source",
    persona: "",
  },
  {
    id: "static.tests",
    title: "The release has an automated test signal",
    domain: "functional",
    kind: "static",
    intent: "Ensure change safety does not depend entirely on manual exploration.",
    expected:
      "At least one automated test file and a discoverable test framework or documented test command.",
    base_weight: 1.5,
    requires: "source",
    persona: "",
  },
  {
    id: "static.ci",
    title: "Continuous integration runs the test signal",
    domain: "reliability",
    kind: "static",
    intent: "Keep evidence fresh on every change instead of relying on one local run.",
    expected: "A CI configuration that runs tests or the harness on pull requests.",
    base_weight: 1.0,
    requires: "source",
    persona: "",
  },
  {
    id: "static.dependencies",
    title: "Dependencies and environment files are locked and clean",
    domain: "data_integrity",
    kind: "static",
    intent: "Prevent unrepeatable builds and accidental environment disclosure.",
    expected:
      "A lockfile for each package ecosystem and no committed local environment file.",
    base_weight: 1.1,
    requires: "manifest",
    persona: "",
  },
  {
    id: "static.accessibility",
    title: "Source markup avoids obvious accessibility barriers",
    domain: "accessibility",
    kind: "static",
    intent:
      "Catch barriers before a browser run, especially missing text alternatives and labels.",
    expected:
      "Images have alt text, interactive elements are semantic, and document language is declared.",
    base_weight: 1.2,
    requires: "markup",
    persona: "",
  },
  {
    id: "browser.load",
    title: "The live target loads with a meaningful response",
    domain: "functional",
    kind: "browser",
    intent: "Establish that a real customer can reach a rendered product surface.",
    expected: "A 2xx/3xx response, a non-empty title, and visible body content.",
    base_weight: 1.8,
    requires: "url",
    persona: "",
  },
  {
    id: "browser.console",
    title: "The rendered page has no unhandled console errors",
    domain: "reliability",
    kind: "browser",
    intent:
      "Detect runtime failures that may be invisible to a happy-path screenshot.",
    expected: "No page errors and no error-level console messages during load.",
    base_weight: 1.2,
    requires: "url",
    persona: "",
  },
  {
    id: "browser.network",
    title: "Critical network requests succeed",
    domain: "reliability",
    kind: "browser",
    intent: "Find failed APIs and missing assets that break a customer journey.",
    expected: "No failed requests and no unexpected 4xx/5xx responses during load.",
    base_weight: 1.3,
    requires: "url",
    persona: "",
  },
  {
    id: "browser.security",
    title: "Transport, headers, cookies, and forms use safe defaults",
    domain: "security",
    kind: "browser",
    intent:
      "Reduce session theft, mixed-content injection, and clickjacking exposure.",
    expected:
      "HTTPS, baseline security headers, secure cookies, and no insecure form targets.",
    base_weight: 1.8,
    requires: "url",
    persona: "",
  },
  {
    id: "browser.accessibility",
    title: "Rendered controls expose usable names and structure",
    domain: "accessibility",
    kind: "browser",
    intent:
      "Ensure keyboard and assistive-technology users can identify and operate the page.",
    expected:
      "Images have alternatives, form controls have labels, controls have accessible names, and IDs are unique.",
    base_weight: 1.4,
    requires: "url",
    persona: "",
  },
  {
    id: "browser.content",
    title: "The page has a clear title and heading structure",
    domain: "content",
    kind: "browser",
    intent: "Give customers and search systems a coherent page identity.",
    expected: "One primary heading and a concise, descriptive page title.",
    base_weight: 0.8,
    requires: "url",
    persona: "",
  },
  {
    id: "browser.links",
    title: "Rendered links are safe and actionable",
    domain: "functional",
    kind: "browser",
    intent: "Avoid dead ends, insecure destinations, and tabnabbing exposure.",
    expected:
      "No empty or javascript: links, no insecure destinations on HTTPS pages, and noopener on new tabs.",
    base_weight: 0.9,
    requires: "url",
    persona: "",
  },
  {
    id: "browser.overflow",
    title: "The page does not overflow the mobile viewport",
    domain: "accessibility",
    kind: "browser",
    intent: "Catch horizontal scrolling and clipped content on small screens.",
    expected: "No rendered element extends beyond the mobile viewport width.",
    base_weight: 0.8,
    requires: "url",
    persona: "",
  },
  {
    id: "browser.focus_order",
    title: "Keyboard focus order follows the document order",
    domain: "accessibility",
    kind: "browser",
    intent: "Keep keyboard and assistive-technology navigation predictable.",
    expected: "No positive tabindex values disturb the natural focus order.",
    base_weight: 0.8,
    requires: "url",
    persona: "",
  },
  {
    id: "browser.steps",
    title: "Natural-language ticket scenario steps executed successfully",
    domain: "functional",
    kind: "browser",
    intent:
      "Execute ticket acceptance criteria and natural-language steps directly against the live target.",
    expected:
      "All planned scenario steps from the ticket execute with no assertion errors or broken interactions.",
    base_weight: 2.0,
    requires: "url",
    persona: "",
  },
] as const;

export function catalogIds(registry?: CheckRegistryLike | null): string[] {
  if (registry != null) return [...registry.ids()];
  return CHECK_CATALOG.map((d) => d.id);
}

export function registryFingerprint(registry?: CheckRegistryLike | null): string {
  const fp = (registry as { fingerprint?: () => string } | null | undefined)?.fingerprint;
  if (typeof fp === "function") return fp.call(registry);
  const definitions: readonly CheckDefinition[] = registry?.definitions ?? CHECK_CATALOG;
  const ids = registry?.ids ? [...registry.ids()] : definitions.map((d) => d.id);
  const sorted = [...ids].sort();
  const payload = sorted.map((id) => {
    const def = definitions.find((d) => d.id === id);
    return {
      id,
      source: registry?.source ? registry.source(id) : "builtin",
      blocked: registry?.blockedReason ? (registry.blockedReason(id) ?? "") : "",
      domain: def?.domain ?? "",
      kind: def?.kind ?? "",
      persona: def?.persona ?? "",
      base_weight: def?.base_weight ?? 0,
    };
  });
  return sha256Bytes(JSON.stringify(payload));
}

export interface PlanChecksInput {
  target: Target;
  inventory: Record<string, unknown>;
  selectedPersonas: readonly string[] | readonly PersonaLike[];
  ownership: Record<string, string[]>;
  maxChecks: number;
  noBrowser?: boolean;
  registry?: CheckRegistryLike | null;
  allPersonas?: readonly string[] | readonly PersonaLike[];
  mobile?: boolean;
  intent?: string;
  scenario?: boolean;
}

function personaId(p: string | PersonaLike): string {
  return typeof p === "string" ? p : p.id;
}

function toIdSet(list: readonly (string | PersonaLike)[] | undefined): Set<string> {
  return new Set((list ?? []).map(personaId));
}

function isApplicable(
  definition: CheckDefinition,
  inventory: Record<string, unknown>,
  target: Target,
  noBrowser: boolean,
  intent: string,
  scenario: boolean,
): boolean {
  const textIntent = intent || "";
  const liveBrowserAvailable = target.kind === "url" && !noBrowser;
  const matchedLabel = matchedAssayCategoryLabel(textIntent);
  const categoryLabel = categoryLabelFromCheckId(definition.id);
  const comprehensive = matchedLabel === "full" || /\b(full regression|regression|comprehensive assessment|release readiness|release confidence)\b/i.test(textIntent);

  // category scope checks (specialized and generic) are intent-gated
  if (categoryLabel != null) {
    if (!comprehensive && matchedLabel !== categoryLabel) return false;
    if (definition.id === "static.browser_category") {
      return !liveBrowserAvailable;
    }
    if (definition.id === "static.demo_category") {
      return !liveBrowserAvailable;
    }
    return true;
  }

  if (definition.id === "browser.steps") return scenario;

  const sourceAvailable = Boolean(inventory.available);
  const hasMarkup = Boolean(inventory.has_markup ?? inventory.hasMarkup);
  const hasManifest = Boolean(inventory.has_manifest ?? inventory.hasManifest);
  if (definition.requires === "source") return sourceAvailable;
  if (definition.requires === "markup") return sourceAvailable && hasMarkup;
  if (definition.requires === "manifest") return sourceAvailable && hasManifest;
  if (definition.requires === "url") return liveBrowserAvailable;
  return true;
}

function placeholderOwner(
  owners: string[],
  checkId: string,
  selected: Set<string>,
  registry?: CheckRegistryLike | null,
): string {
  const hint = registry?.ownerHint?.(checkId) ?? "";
  if (hint) return hint;
  for (const owner of owners) {
    if (selected.has(owner)) return owner;
  }
  const firstOwner = owners[0];
  if (firstOwner) return firstOwner;
  const firstSelected = [...selected].sort()[0];
  return firstSelected ?? "unassigned";
}

export function planChecks(input: PlanChecksInput): Check[] {
  const {
    target,
    inventory,
    selectedPersonas,
    ownership,
    maxChecks,
    noBrowser = false,
    registry = null,
    mobile = false,
    intent = "",
    scenario = false,
  } = input;

  const selected = toIdSet(selectedPersonas);
  // allPersonas accepted for API compatibility/future parity but ownership map is authoritative input.
  void input.allPersonas;
  const definitions: readonly CheckDefinition[] = registry?.definitions ?? CHECK_CATALOG;

  const checks: Check[] = [];
  for (const definition of definitions) {
    const owners = ownership[definition.id] ?? [];
    const source = registry?.source(definition.id) ?? "builtin";
    const isPlugin = source.startsWith("plugin");
    let blockedReason = registry?.blockedReason?.(definition.id) ?? "";

    let owner: string;
    if (owners.length === 1) {
      const onlyOwner = owners[0];
      if (onlyOwner === undefined) {
        throw new HarnessError(ownershipErrorMessage(definition.id, owners));
      }
      owner = onlyOwner;
    } else if (!isPlugin) {
      throw new HarnessError(ownershipErrorMessage(definition.id, owners));
    } else {
      if (registry && !blockedReason) {
        const reason = ownershipErrorMessage(definition.id, owners);
        registry.block?.(definition.id, reason);
        blockedReason = reason;
      }
      owner = placeholderOwner(owners, definition.id, selected, registry);
    }

    if (!selected.has(owner)) continue;
    if (!isApplicable(definition, inventory, target, noBrowser, intent, scenario)) continue;
    if (!mobile && (definition.id === "browser.overflow" || definition.id === "browser.focus_order")) {
      continue;
    }

    const blocked = blockedReason.length > 0;
    checks.push({
      id: definition.id,
      title: definition.title,
      domain: definition.domain,
      persona: owner,
      kind: definition.kind,
      intent: definition.intent,
      expected: definition.expected,
      base_weight: definition.base_weight,
      status: blocked ? CheckStatus.BLOCKED : CheckStatus.PLANNED,
      weight: definition.base_weight,
      actual: blocked ? blockedReason : "",
      evidence: [],
      finding_ids: [],
      skip_reason: blocked ? blockedReason : "",
      started_at: null,
      completed_at: blocked ? now() : null,
      metadata: {},
    });
  }

  if (checks.length === 0) {
    throw new HarnessError(
      "No applicable checks. A directory target needs source files; a URL target " +
        "needs browser execution enabled. Use --source to combine both.",
    );
  }
  let limited = checks;
  if (maxChecks > 0) limited = checks.slice(0, maxChecks);
  if (limited.length === 0) {
    throw new HarnessError("max_checks removed every applicable check");
  }
  return limited;
}

export function applyRiskWeights(checks: Check[], risks: Risk[]): void {
  const multipliers: Record<string, number> = {};
  for (const risk of risks) {
    const domain = risk.domain;
    const current = multipliers[domain] ?? 1.0;
    const next = typeof risk.weight_multiplier === "number" ? risk.weight_multiplier : 1.0;
    multipliers[domain] = Math.max(current, next);
  }
  for (const check of checks) {
    const multiplier = multipliers[check.domain] ?? 1.0;
    check.weight = Math.round(check.base_weight * multiplier * 10000) / 10000;
  }
}
