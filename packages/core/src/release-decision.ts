import { createHash } from "node:crypto";

import { StateError } from "./errors.js";

export type ReleaseDecisionName = "SHIP" | "CANARY" | "HOLD" | "ROLL BACK" | "MORE EVIDENCE";

export interface ReleaseDecisionSignals {
  score: { explicit: boolean; value?: unknown; band?: unknown; [k: string]: unknown };
  coverage: { explicit: boolean; value?: unknown; executed_pct?: unknown; [k: string]: unknown };
  blockers_refusals: { explicit: boolean; count?: number; items?: unknown[]; [k: string]: unknown };
  reviewer_signoff: { explicit: boolean; signed_off?: boolean; review_ids?: string[]; contested_count?: number; [k: string]: unknown };
  unanswered_hum_questions: { explicit: boolean; question_ids?: string[]; count?: number; [k: string]: unknown };
}

export interface ReleaseDecisionReversibility {
  required: boolean;
  satisfied: boolean;
  details: Record<string, unknown>;
}

export interface ReleaseDecision {
  schema_version: "lemma.release_decision/v1";
  decision_id: string;
  run_id: string | null;
  decision: ReleaseDecisionName;
  rationale: string;
  signals: ReleaseDecisionSignals;
  evidence_citations: Array<Record<string, unknown>>;
  reversibility: ReleaseDecisionReversibility;
  downgraded_to_more_evidence?: boolean;
  downgrade_reasons?: string[];
  [k: string]: unknown;
}

export interface RunReleaseDecisionParams {
  report: unknown;
  policy?: Record<string, unknown> | null;
  history?: Record<string, unknown> | unknown[] | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function strArr(v: unknown): string[] {
  return arr(v).filter((x): x is string => typeof x === "string");
}

function extractSignals(report: Record<string, unknown>, policy: Record<string, unknown> | null, history: unknown): ReleaseDecisionSignals {
  const confidence = isRecord(report.confidence) ? report.confidence : null;
  const coverage = isRecord(report.coverage) ? report.coverage : null;
  const blockers = arr(report.blockers);
  const invalid = arr(report.invalid_findings);
  const refusals = arr((report as any).refusals).concat(arr((report as any).contract_failures?.refusals));
  const blockersRefusalItems = [...blockers, ...invalid, ...refusals];
  const blockersExplicit = (Array.isArray(report.blockers)) || (Array.isArray((report as any).invalid_findings)) || (isRecord((policy as any)?.signals?.blockers_refusals) && (policy as any).signals.blockers_refusals.explicit === true) || (isRecord((policy as any)?.blockers_refusals) && (policy as any).blockers_refusals.explicit === true);

  const scoreExplicit = (confidence != null && confidence.score !== undefined) || (isRecord((policy as any)?.signals?.score) && (policy as any).signals.score.explicit === true) || (isRecord((policy as any)?.score) && (policy as any).score.explicit === true);
  const coverageExplicit = (coverage != null && coverage.executed_pct !== undefined) || (coverage != null && Object.keys(coverage).length > 0) || (isRecord((policy as any)?.signals?.coverage) && (policy as any).signals.coverage.explicit === true) || (isRecord((policy as any)?.coverage) && (policy as any).coverage.explicit === true);

  const reviews = arr(report.reviews);
  const reviewNotes = arr(report.review_notes);
  const contested = reviewNotes.filter((n) => isRecord(n) && ((n as any).status === "contested" || (n as any).type === "review_note"));
  const policySignoff = isRecord((policy as any)?.reviewer_signoff) ? (policy as any).reviewer_signoff : (isRecord((policy as any)?.signals?.reviewer_signoff) ? (policy as any).signals.reviewer_signoff : null);
  const reportSignoff = isRecord((report as any).reviewer_signoff) ? (report as any).reviewer_signoff : null;
  const signoffSource = reportSignoff ?? policySignoff;
  const signoffExplicit = signoffSource != null ? (signoffSource as any).explicit !== false : false;
  const signedOffRaw = signoffExplicit ? Boolean((signoffSource as any).signed_off ?? (signoffSource as any).approved ?? (reviews.length > 0 && contested.length === 0)) : false;
  const signedOff = signedOffRaw && contested.length === 0;
  const reviewIds = strArr((signoffSource as any)?.review_ids).concat(reviews.map((r) => isRecord(r) ? String((r as any).review_id || "") : "").filter(Boolean));

  // HUM unanswered questions explicitness
  const humInPolicy = isRecord((policy as any)?.human) ? (policy as any).human : (isRecord((policy as any)?.signals?.unanswered_hum_questions) ? (policy as any).signals.unanswered_hum_questions : null);
  const humInReport = isRecord((report as any).human_decision_context) ? (report as any).human_decision_context : (isRecord((report as any).human) ? (report as any).human : null);
  const humInHistory = isRecord(history) ? ((history as any).human_decision_context ?? (history as any).human ?? null) : null;
  const humSource = humInPolicy ?? humInReport ?? (isRecord(humInHistory) ? humInHistory : null);
  const humExplicit = humSource != null ? ((humSource as any).explicit !== false) : false;
  const unansweredHum = humExplicit ? strArr((humSource as any).unanswered_material_question_ids ?? (humSource as any).unanswered_question_ids ?? (humSource as any).question_ids).filter((id) => id.startsWith("HUM-")) : [];

  return {
    score: { explicit: Boolean(scoreExplicit), value: confidence?.score, band: confidence?.band },
    coverage: { explicit: Boolean(coverageExplicit), value: coverage, executed_pct: coverage?.executed_pct },
    blockers_refusals: { explicit: Boolean(blockersExplicit), count: blockersRefusalItems.length, items: blockersRefusalItems },
    reviewer_signoff: { explicit: signoffExplicit, signed_off: signedOff, review_ids: Array.from(new Set(reviewIds)), contested_count: contested.length },
    unanswered_hum_questions: { explicit: humExplicit, question_ids: Array.from(new Set(unansweredHum)), count: unansweredHum.length },
  };
}

function stableDecisionId(runId: string | null, decision: ReleaseDecisionName, signals: ReleaseDecisionSignals): string {
  const h = createHash("sha256");
  h.update(String(runId || "no-run"));
  h.update("|" + decision);
  h.update("|" + JSON.stringify({ s: signals.score?.value, c: signals.coverage?.executed_pct, b: signals.blockers_refusals?.count, r: signals.reviewer_signoff?.signed_off, h: signals.unanswered_hum_questions?.question_ids || [] }));
  return "rdec-" + h.digest("hex").slice(0, 16);
}

function buildReversibility(decision: ReleaseDecisionName, policy: Record<string, unknown> | null): ReleaseDecisionReversibility {
  const p = isRecord((policy as any)?.reversibility) ? (policy as any).reversibility as Record<string, unknown> : {};
  if (decision === "ROLL BACK") {
    const plan = p.rollback_plan ?? p.rollbackPlan ?? (policy as any)?.rollback_plan ?? (policy as any)?.rollbackPlan;
    const ok = typeof plan === "string" ? plan.trim().length > 0 : (isRecord(plan) || Array.isArray(plan)) ? true : false;
    return { required: true, satisfied: ok, details: { rollback_plan: plan ?? null } };
  }
  if (decision === "CANARY") {
    const scope = p.canary_scope ?? p.canaryScope ?? (policy as any)?.canary_scope ?? (policy as any)?.canaryScope;
    const ok = typeof scope === "string" ? scope.trim().length > 0 : (isRecord(scope) || Array.isArray(scope)) ? true : false;
    return { required: true, satisfied: ok, details: { canary_scope: scope ?? null } };
  }
  if (decision === "HOLD") {
    const reason = p.hold_reason ?? p.holdReason ?? (policy as any)?.hold_reason ?? (policy as any)?.holdReason ?? p.reason ?? (policy as any)?.reason;
    const ok = typeof reason === "string" ? reason.trim().length > 0 : Boolean(reason);
    return { required: true, satisfied: ok, details: { hold_reason: reason ?? null } };
  }
  return { required: false, satisfied: true, details: {} };
}

function evidenceCitations(report: Record<string, unknown>, signals: ReleaseDecisionSignals): Array<Record<string, unknown>> {
  const cites: Array<Record<string, unknown>> = [];
  const runId = typeof report.run_id === "string" ? report.run_id : null;
  if (signals.score.explicit) cites.push({ type: "score", path: "report.confidence", value: signals.score.value, run_id: runId });
  if (signals.coverage.explicit) cites.push({ type: "coverage", path: "report.coverage", value: signals.coverage.value ?? signals.coverage.executed_pct, run_id: runId });
  if (signals.blockers_refusals.explicit) cites.push({ type: "blockers_refusals", path: "report.blockers", count: signals.blockers_refusals.count, run_id: runId });
  if (signals.reviewer_signoff.explicit) cites.push({ type: "reviewer_signoff", path: "report.reviews|policy.reviewer_signoff", review_ids: signals.reviewer_signoff.review_ids, signed_off: signals.reviewer_signoff.signed_off });
  if (signals.unanswered_hum_questions.explicit) cites.push({ type: "unanswered_hum_questions", path: "report.human_decision_context|policy.human", question_ids: signals.unanswered_hum_questions.question_ids });
  // fallback ensure at least one citation from evidence context
  if (cites.length === 0) cites.push({ type: "report", path: "report", run_id: runId });
  return cites;
}

export function runReleaseDecision(params: RunReleaseDecisionParams): ReleaseDecision {
  if (!params || !isRecord(params.report)) {
    throw new StateError("runReleaseDecision requires a report object");
  }
  const report = params.report as Record<string, unknown>;
  const policy = isRecord(params.policy) ? (params.policy as Record<string, unknown>) : null;
  const history = params.history ?? null;
  const runId = typeof report.run_id === "string" ? report.run_id : null;

  const signals = extractSignals(report, policy, history);
  const downgradeReasons: string[] = [];
  if (!signals.score.explicit) downgradeReasons.push("missing_explicit_score");
  if (!signals.coverage.explicit) downgradeReasons.push("missing_explicit_coverage");
  if (!signals.blockers_refusals.explicit) downgradeReasons.push("missing_explicit_blockers_refusals");
  if (!signals.reviewer_signoff.explicit) downgradeReasons.push("missing_explicit_reviewer_signoff");
  if (!signals.unanswered_hum_questions.explicit) downgradeReasons.push("missing_explicit_unanswered_hum_questions");

  const requestedRaw = typeof (policy as any)?.requested_decision === "string" ? String((policy as any).requested_decision).toUpperCase() : null;
  const validRequested: ReleaseDecisionName[] = ["SHIP", "CANARY", "HOLD", "ROLL BACK", "MORE EVIDENCE"];
  let requested: ReleaseDecisionName = (requestedRaw && (validRequested as string[]).includes(requestedRaw)) ? (requestedRaw as ReleaseDecisionName) : "MORE EVIDENCE";

  let decision: ReleaseDecisionName = requested;
  let downgraded = false;

  // Missing any required explicit signal => downgrade to MORE EVIDENCE, never SHIP
  if (downgradeReasons.length > 0) {
    decision = "MORE EVIDENCE";
    downgraded = requested !== "MORE EVIDENCE";
  } else {
    // all explicit; apply substantive gates
    const blockersCount = signals.blockers_refusals.count ?? 0;
    const contested = signals.reviewer_signoff.contested_count ?? 0;
    const unansweredHum = signals.unanswered_hum_questions.question_ids ?? [];
    const signedOff = signals.reviewer_signoff.signed_off === true;
    if (unansweredHum.length > 0 || !signedOff || contested > 0) {
      if (requested === "SHIP" || requested === "CANARY") {
        decision = "MORE EVIDENCE";
        downgraded = true;
        if (unansweredHum.length > 0) downgradeReasons.push("unanswered_hum_questions");
        if (!signedOff) downgradeReasons.push("reviewer_signoff_not_granted");
        if (contested > 0) downgradeReasons.push("contested_review_findings");
      }
    }
    if ((decision === "SHIP" || decision === "CANARY") && blockersCount > 0) {
      decision = "MORE EVIDENCE";
      downgraded = true;
      downgradeReasons.push("blockers_or_refusals_present");
    }
  }

  if (decision === "SHIP" && downgraded) {
    // defensive: never ship on downgrade
    decision = "MORE EVIDENCE";
  }

  const reversibility = buildReversibility(decision, policy);
  if (reversibility.required && !reversibility.satisfied) {
    // cannot record required reversibility details => cannot issue that decision, need more evidence/details
    if (decision !== "MORE EVIDENCE") {
      downgradeReasons.push("missing_reversibility_details");
      downgraded = true;
    }
    decision = "MORE EVIDENCE";
  }

  const citations = evidenceCitations(report, signals);
  const rationaleParts: string[] = [];
  rationaleParts.push(`Decision: ${decision}.`);
  if (downgraded || downgradeReasons.length > 0) rationaleParts.push(`Downgrade/constraints: ${downgradeReasons.join(", ") || "explicit signals incomplete or gating conditions unmet"}.`);
  rationaleParts.push("Every decision cites explicit score, coverage, blockers/refusals, reviewer sign-off, and unanswered HUM-* question signals.");

  const result: ReleaseDecision = {
    schema_version: "lemma.release_decision/v1",
    decision_id: stableDecisionId(runId, decision, signals),
    run_id: runId,
    decision,
    rationale: rationaleParts.join(" "),
    signals,
    evidence_citations: citations,
    reversibility,
    ...(downgraded || downgradeReasons.length ? { downgraded_to_more_evidence: true, downgrade_reasons: Array.from(new Set(downgradeReasons)) } : { downgraded_to_more_evidence: false, downgrade_reasons: [] }),
  };

  // Validate structure first; apply schema-safe redaction that preserves required keys/types.
  validateReleaseDecision(result);
  const redacted = safeRedactReleaseDecision(result);
  validateReleaseDecision(redacted);
  return redacted;
}


function redactString(v: unknown): string {
  if (typeof v !== "string") return typeof v === "number" || typeof v === "boolean" ? String(v) : "";
  // avoid key-name based whole-value redaction; redact sensitive patterns in text only
  return v
    .replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b/g, "[REDACTED_JWT]")
    .replace(/\b(Authorization\s*[:=]\s*(?:Bearer|Basic)\s+)[^\s,"'`]+/gi, "$1[REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password|passwd|session|cookie)\b\s*[:=]\s*([^\s,;"']+)/gi, "$1=[REDACTED]");
}

function safeRedactReleaseDecision(decision: ReleaseDecision): ReleaseDecision {
  const copy: ReleaseDecision = JSON.parse(JSON.stringify(decision));
  copy.rationale = redactString(copy.rationale);
  copy.evidence_citations = (copy.evidence_citations || []).map((c) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c || {})) {
      if (typeof v === "string") o[k] = redactString(v);
      else if (Array.isArray(v)) o[k] = v.map((x) => typeof x === "string" ? redactString(x) : x);
      else o[k] = v;
    }
    return o;
  });
  if (Array.isArray(copy.downgrade_reasons)) copy.downgrade_reasons = copy.downgrade_reasons.map((r) => redactString(r));
  // preserve required signal booleans/numeric counts/ids; redact free-text reason-like fields if any
  if (copy.reversibility && isRecord(copy.reversibility.details)) {
    const d: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(copy.reversibility.details)) {
      d[k] = typeof v === "string" ? redactString(v) : (isRecord(v) ? JSON.parse(JSON.stringify(v)) : v);
    }
    copy.reversibility.details = d;
  }
  return copy;
}

export function validateReleaseDecision(decision: ReleaseDecision): void {
  if (!decision || decision.schema_version !== "lemma.release_decision/v1") throw new StateError("Invalid ReleaseDecision schema_version");
  if (!decision.decision_id) throw new StateError("Invalid ReleaseDecision decision_id");
  const valid: ReleaseDecisionName[] = ["SHIP", "CANARY", "HOLD", "ROLL BACK", "MORE EVIDENCE"];
  if (!valid.includes(decision.decision)) throw new StateError("Invalid ReleaseDecision decision");
  const s = decision.signals;
  if (!s || !s.score || !s.coverage || !s.blockers_refusals || !s.reviewer_signoff || !s.unanswered_hum_questions) throw new StateError("ReleaseDecision missing required signals");
  for (const k of ["score", "coverage", "blockers_refusals", "reviewer_signoff", "unanswered_hum_questions"] as const) {
    if (typeof (s as any)[k].explicit !== "boolean") throw new StateError(`ReleaseDecision signal ${k} must declare explicit boolean`);
  }
  if (!Array.isArray(decision.evidence_citations) || decision.evidence_citations.length < 1) throw new StateError("ReleaseDecision must cite evidence");
  const r = decision.reversibility;
  if (!r || typeof r.required !== "boolean" || typeof r.satisfied !== "boolean" || !isRecord(r.details)) throw new StateError("ReleaseDecision reversibility invalid");
  if (decision.decision === "ROLL BACK" && (!r.required || !r.satisfied || r.details.rollback_plan == null || r.details.rollback_plan === "")) throw new StateError("ROLL BACK requires documented rollback plan");
  if (decision.decision === "CANARY" && (!r.required || !r.satisfied || r.details.canary_scope == null || r.details.canary_scope === "")) throw new StateError("CANARY requires documented canary scope");
  if (decision.decision === "HOLD" && (!r.required || !r.satisfied || r.details.hold_reason == null || r.details.hold_reason === "")) throw new StateError("HOLD requires specific reason");
}
