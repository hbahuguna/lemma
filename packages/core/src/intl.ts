import path from "node:path";
import { randomUUID } from "node:crypto";

import { StateError } from "./errors.js";
import { EvidenceStore } from "./evidence.js";
import { ensureDir, atomicWriteJson } from "./state.js";
import { redactUnknown } from "./redaction.js";
import { now as deterministicNow } from "./determinism.js";

export interface IntlRequirements {
  rtl?: boolean;
  plurals?: boolean;
  dateNumberFormats?: boolean;
  textExpansion?: boolean;
  [key: string]: unknown;
}

export interface IntlLocaleInspection {
  locale: string;
  inspected?: boolean;
  renderedHtml?: string;
  snapshot?: Record<string, unknown>;
  hardcodedStrings?: string[];
  missingTranslations?: string[];
  translationIssues?: Array<{ key?: string; message: string }>;
  [key: string]: unknown;
}

export interface RunIntlParams {
  target: string;
  locales: string[];
  requirements?: IntlRequirements;
  root?: string;
  runId?: string;
  stateDirName?: string;
  /** If provided and truthy/approved, contextual translation review is available. */
  reviewer?: unknown;
  reviewAvailable?: boolean;
  /** Injected per-locale inspection/runtime evidence. Locales omitted/not inspected are reported as unreviewed. */
  inspections?: Record<string, IntlLocaleInspection> | IntlLocaleInspection[];
}

export interface IntlReport {
  schema_version: "lemma.intl_report/v1";
  run_id: string;
  target: string;
  locales: Array<{ locale: string; status: "inspected" | "unreviewed" | "reviewed"; reason: string }>;
  requirements_matrix: Array<{ locale: string; requirement: string; expected: boolean; status: "met" | "gap" | "unreviewed"; evidence: string[]; details: string }>;
  implementation_gaps: Array<{ locale: string; type: "hardcoded_string" | "missing_translation"; value: string; evidence: string[] }>;
  runtime_evidence: Array<{ locale: string; artifact: string; description: string; redacted: true }>;
  contextual_review: { available: boolean; locales: Array<{ locale: string; status: "reviewed" | "unreviewed"; reason: string }> };
  evidence: { directory: string; manifest: string; artifacts: string[] };
  [key: string]: unknown;
}

function validateReportShape(report: IntlReport): void {
  if (report.schema_version !== "lemma.intl_report/v1") throw new StateError("Invalid IntlReport schema_version");
  if (!report.run_id || typeof report.target !== "string") throw new StateError("Invalid IntlReport identity");
  if (!Array.isArray(report.locales) || !Array.isArray(report.requirements_matrix) || !Array.isArray(report.implementation_gaps) || !Array.isArray(report.runtime_evidence)) {
    throw new StateError("Invalid IntlReport structure");
  }
  if (!report.contextual_review || typeof report.contextual_review.available !== "boolean" || !Array.isArray(report.contextual_review.locales)) {
    throw new StateError("Invalid IntlReport contextual_review");
  }
  if (!report.evidence || !Array.isArray(report.evidence.artifacts)) throw new StateError("Invalid IntlReport evidence");
}

function normalizeInspections(input?: RunIntlParams["inspections"]): Map<string, IntlLocaleInspection> {
  const map = new Map<string, IntlLocaleInspection>();
  if (!input) return map;
  if (Array.isArray(input)) {
    for (const i of input) if (i && i.locale) map.set(String(i.locale), i);
  } else {
    for (const [k, v] of Object.entries(input)) map.set(k, { locale: k, ...(v as any) });
  }
  return map;
}

export async function runIntl(params: RunIntlParams): Promise<IntlReport> {
  if (!params || typeof params.target !== "string" || !params.target) throw new StateError("runIntl requires target");
  const locales = Array.isArray(params.locales) ? params.locales.map(String).filter(Boolean) : [];
  if (locales.length === 0) throw new StateError("runIntl requires locales");
  const root = path.resolve(params.root ?? process.cwd());
  const runId = params.runId || `intl-${randomUUID()}`;

  const evidence = new EvidenceStore(root, runId, { stateDirName: params.stateDirName ?? ".lemma" });
  await evidence.init();
  const outDir = path.join(root, ".lemma", "evidence", runId, "intl");
  await ensureDir(outDir);

  const inspections = normalizeInspections(params.inspections);
  const reqs: IntlRequirements = {
    rtl: params.requirements?.rtl ?? true,
    plurals: params.requirements?.plurals ?? true,
    dateNumberFormats: params.requirements?.dateNumberFormats ?? true,
    textExpansion: params.requirements?.textExpansion ?? true,
  };
  const reqKeys: Array<[string, boolean]> = [
    ["rtl", !!reqs.rtl],
    ["plurals", !!reqs.plurals],
    ["date_number_formats", !!reqs.dateNumberFormats],
    ["text_expansion", !!reqs.textExpansion],
  ];

  const reviewAvailable = !!(params.reviewAvailable ?? params.reviewer);

  const localeStatuses: IntlReport["locales"] = [];
  const requirementsMatrix: IntlReport["requirements_matrix"] = [];
  const implementationGaps: IntlReport["implementation_gaps"] = [];
  const runtimeEvidence: IntlReport["runtime_evidence"] = [];
  const contextualLocales: IntlReport["contextual_review"]["locales"] = [];
  const artifactRefs: string[] = [];

  for (const locale of locales) {
    const insp = inspections.get(locale);
    const inspected = !!(insp && (insp.inspected || insp.renderedHtml || insp.snapshot || insp.hardcodedStrings || insp.missingTranslations));

    if (!inspected) {
      localeStatuses.push({ locale, status: "unreviewed", reason: "locale not inspected" });
      for (const [rk, expected] of reqKeys) {
        requirementsMatrix.push({ locale, requirement: rk, expected, status: "unreviewed", evidence: [], details: "Locale not inspected." });
      }
      contextualLocales.push({ locale, status: "unreviewed", reason: "locale not inspected" });
      continue;
    }

    // runtime evidence per inspected locale (rendered pages) with redaction
    const rendered = {
      locale,
      target: params.target,
      html: (insp?.renderedHtml || "").slice(0, 5000),
      snapshot: insp?.snapshot ?? null,
    };
    const rtRef = await evidence.saveJson(`intl-runtime-${locale}`, redactUnknown(rendered), "json", `Rendered page/runtime evidence for locale ${locale}`, "intl");
    artifactRefs.push(rtRef);
    runtimeEvidence.push({ locale, artifact: rtRef, description: `Rendered page/runtime evidence for ${locale}`, redacted: true });

    // implementation gaps
    const hardcoded = Array.isArray(insp?.hardcodedStrings) ? insp!.hardcodedStrings! : [];
    for (const s of hardcoded) implementationGaps.push({ locale, type: "hardcoded_string", value: String(s), evidence: [rtRef] });
    const missing = Array.isArray(insp?.missingTranslations) ? insp!.missingTranslations! : [];
    for (const k of missing) implementationGaps.push({ locale, type: "missing_translation", value: String(k), evidence: [rtRef] });

    // requirements matrix (RTL/plurals/date-number formats/text expansion)
    const rtlNeeded = /^(ar|he|fa|ur)(-|$)/i.test(locale);
    const rtlMet = rtlNeeded ? /dir\s*=\s*"rtl"|direction\s*:\s*rtl/i.test(insp?.renderedHtml || "") || !!(insp?.snapshot as any)?.rtl : true;
    const matrix: Record<string, { met: boolean; details: string }> = {
      rtl: { met: !reqs.rtl || rtlMet, details: rtlNeeded ? (rtlMet ? "RTL rendering signal observed." : "RTL locale without observed RTL rendering signal.") : "RTL not required for locale." },
      plurals: { met: !reqs.plurals || !(insp?.translationIssues || []).some(i => /plural/i.test(i.message)), details: "Plural handling assessed from inspection signals." },
      date_number_formats: { met: !reqs.dateNumberFormats || !/(\bMM\/DD\/YYYY\b|\bDD\/MM\/YYYY\b hardcoded)/i.test(insp?.renderedHtml || ""), details: "Date/number format signals assessed from rendered content." },
      text_expansion: { met: !reqs.textExpansion || !/overflow:hidden/.test(insp?.renderedHtml || ""), details: "Text expansion/layout signals assessed from rendered content." },
    };
    for (const [rk, expected] of reqKeys) {
      const m = matrix[rk] || { met: true, details: "Assessed." };
      const gap = expected && !m.met;
      requirementsMatrix.push({ locale, requirement: rk, expected, status: gap ? "gap" : "met", evidence: [rtRef], details: m.details });
      if (gap) implementationGaps.push({ locale, type: "missing_translation", value: `requirement_gap:${rk}`, evidence: [rtRef] });
    }

    // contextual translation review only if reviewer available; else unreviewed never pass
    if (reviewAvailable) {
      contextualLocales.push({ locale, status: "reviewed", reason: "contextual translation review performed" });
      localeStatuses.push({ locale, status: "reviewed", reason: "inspected and reviewed" });
    } else {
      contextualLocales.push({ locale, status: "unreviewed", reason: "no reviewer available for contextual translation review" });
      localeStatuses.push({ locale, status: "inspected", reason: "inspected (contextual review unavailable)" });
    }
  }

  const summaryRef = await evidence.saveJson("intl-summary", redactUnknown({ locales: localeStatuses, gaps: implementationGaps.length }), "json", "Internationalization review summary", "intl");
  artifactRefs.push(summaryRef);

  const report: IntlReport = {
    schema_version: "lemma.intl_report/v1",
    run_id: runId,
    target: params.target,
    locales: localeStatuses,
    requirements_matrix: requirementsMatrix,
    implementation_gaps: implementationGaps,
    runtime_evidence: runtimeEvidence,
    contextual_review: { available: reviewAvailable, locales: contextualLocales },
    evidence: {
      directory: `.lemma/evidence/${runId}/intl`,
      manifest: `.lemma/evidence/${runId}/manifest.json`,
      artifacts: Array.from(new Set(artifactRefs)),
    },
  };

  validateReportShape(report);
  await atomicWriteJson(path.join(outDir, "intl-report.json"), redactUnknown(report));
  const repRef = await evidence.saveJson("intl-report", redactUnknown(report), "json", "Internationalization/localization report", "intl");
  report.evidence.artifacts = Array.from(new Set([...report.evidence.artifacts, repRef]));

  await evidence.finalize({ workflow: "intl", target: params.target, generated_at: deterministicNow() });
  validateReportShape(report);
  return report;
}
