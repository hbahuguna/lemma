import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { CHECK_CATALOG, type CheckDefinition, type CheckRegistryLike } from "./checks.js";
import { PersonaError, PluginError } from "./errors.js";
import type { EvidenceStore } from "./evidence.js";
import { checkOwnership, ownershipErrorMessage, type PersonaOwnershipSource } from "./personas.js";
import {
  CheckOutcome,
  CheckStatus,
  type BlockerDraft,
  type Check,
  type FindingDraft,
  type Target,
} from "./models.js";

export const PLUGIN_ENTRY_POINT_GROUP = "lemma.checks";
export const ASSAY_ENTRY_POINT_GROUP = "quality_harness.checks";
export const PLUGIN_SIGNATURE_SCHEME = "hmac-sha256";
export const DEFAULT_PLUGIN_TRUST_FILE = path.join(".lemma", "plugins", "trusted_keys.json");
export const PLUGIN_SCHEMA_VERSION = "quality-harness.check-plugin/v1" as const;
export const KNOWN_INPUT_REQUIREMENTS = new Set(["source", "url", "markup", "manifest", "any"]);
const CHECK_ID_PATTERN = /^[a-z][a-z0-9_.-]*$/;

export interface PluginContext {
  /** The read-only execution surface exposed to a plugin evaluator. */
  check: Check;
  target: Target;
  root: string | null;
  inventory: unknown;
  evidence: EvidenceStore;
  log: (message: string) => void;
  saveJson: (name: string, payload: unknown, description?: string, kind?: string) => Promise<string>;
}

export type PluginEvaluator = (context: PluginContext) => CheckOutcome | Promise<CheckOutcome>;

export interface CheckPlugin {
  definition: CheckDefinition;
  evaluate: PluginEvaluator;
  signature?: string;
}

/**
 * Authoring-time plugin definition input. Normalized to a registry-compatible
 * `CheckDefinition` (stable id, kind/intent/expected/requires/base_weight/domain).
 */
export interface PluginDefinitionInput {
  id: string;
  title?: string;
  name?: string;
  domain: string;
  persona?: string;
  kind?: string;
  intent?: string;
  description?: string;
  expected: string;
  base_weight?: number;
  requires?: string;
}

export interface DefinePluginInput<TDef extends PluginDefinitionInput = PluginDefinitionInput> {
  definition: TDef;
  evaluate: PluginEvaluator;
  signature?: string;
}

export interface PluginEntryPoint {
  name: string;
  value: string;
  load: () => unknown;
}

function slug(value: string, fallback = "plugin"): string {
  const v = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return v || fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function isValidCheckStatus(status: unknown): status is CheckStatus {
  return typeof status === "string" && (Object.values(CheckStatus) as string[]).includes(status);
}

function isFindingDraftLike(value: unknown): value is FindingDraft {
  return isRecord(value)
    && typeof value.title === "string"
    && typeof value.severity === "string"
    && typeof value.domain === "string"
    && typeof value.strength === "string"
    && typeof value.consequence === "string";
}

function isBlockerDraftLike(value: unknown): value is BlockerDraft {
  return isRecord(value)
    && typeof value.attempted_action === "string"
    && typeof value.boundary === "string"
    && Array.isArray(value.unblock_evidence)
    && typeof value.covered_elsewhere === "boolean"
    && Array.isArray(value.covered_by);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function normalizeOutcomeForValidation(outcome: CheckOutcome): {
  status: string;
  evidence: string[];
  findings: FindingDraft[];
  blocker: BlockerDraft | null;
} {
  return {
    status: outcome.status,
    evidence: normalizeStringArray(outcome.evidence),
    findings: Array.isArray(outcome.findings) ? outcome.findings : [],
    blocker: outcome.blocker ?? null,
  };
}

function resolveEvidencePath(evidence: EvidenceStore, raw: string): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(evidence.root, raw);
  const runDir = path.resolve(evidence.runDir);
  const rel = path.relative(runDir, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return null;
  } catch {
    return null;
  }
  return candidate;
}

function invalidEvidencePaths(evidence: EvidenceStore, paths: readonly string[] | undefined): string[] {
  const invalid: string[] = [];
  for (const raw of paths ?? []) {
    if (resolveEvidencePath(evidence, raw) === null) invalid.push(String(raw));
  }
  return invalid;
}

/**
 * Create a blocked CheckOutcome for a plugin check that cannot be executed
 * (e.g. registry-blocked definition). This is a coverage gap, not a pass/fatal.
 */
export function blockedPluginOutcome(check: Pick<Check, "id" | "title" | "expected">, reason: string): CheckOutcome {
  const boundary = String(reason || `Plugin check '${check.id}' is blocked.`);
  const outcome = new CheckOutcome({
    status: CheckStatus.BLOCKED,
    actual: boundary,
    evidence: [],
    findings: [],
    blocker: null,
    metadata: { limitation: boundary, boundary },
  });
  outcome.addBlocker(
    check.expected || check.title || `Run plugin check '${check.id}'.`,
    boundary,
    [
      `Resolve the plugin issue for '${check.id}' (install/verify/sign/fix ownership or configuration) and re-run.`,
    ],
    false,
    [],
  );
  return outcome;
}

export class PluginCheckRunner {
  /** Execute a plugin evaluator with a bounded, evidence-backed context. */

  readonly target: Target;
  readonly root: string | null;
  readonly inventory: unknown;
  readonly evidence: EvidenceStore;
  readonly log: (message: string) => void;

  constructor(
    target: Target,
    root: string | null | undefined,
    inventory: unknown,
    evidence: EvidenceStore,
    log?: (message: string) => void,
  ) {
    this.target = target;
    this.root = root ?? null;
    this.inventory = inventory;
    this.evidence = evidence;
    this.log = log ?? (() => {});
  }

  createContext(check: Check): PluginContext {
    return {
      check,
      target: this.target,
      root: this.root ?? null,
      inventory: this.inventory,
      evidence: this.evidence,
      log: this.log,
      saveJson: (name: string, payload: unknown, description = "", kind = "plugin") =>
        this.evidence.saveJson(name, payload, kind, description, check.id),
    };
  }

  async run(check: Check, evaluator: PluginEvaluator): Promise<CheckOutcome> {
    const context = this.createContext(check);
    let outcome: unknown;
    try {
      outcome = await evaluator(context);
    } catch (err) {
      const name = (err as Error)?.name ?? "Error";
      const msg = err instanceof Error ? err.message : String(err);
      return new CheckOutcome({
        status: CheckStatus.ERROR,
        actual: `Plugin check crashed: ${name}: ${msg}`,
        metadata: { error: msg },
      });
    }

    if (!(outcome instanceof CheckOutcome)) {
      const typeName = outcome === null ? "null" : typeof outcome === "object" ? (outcome as { constructor?: { name?: string } }).constructor?.name ?? "object" : typeof outcome;
      return new CheckOutcome({
        status: CheckStatus.ERROR,
        actual: `Plugin did not return a CheckOutcome (got ${String(typeName)}).`,
      });
    }

    const co = outcome;
    if (!isValidCheckStatus(co.status)) {
      return new CheckOutcome({
        status: CheckStatus.ERROR,
        actual: `Plugin returned an unknown check status: ${JSON.stringify(co.status)}.`,
      });
    }

    const normalized = normalizeOutcomeForValidation(co);
    if (!Array.isArray(co.findings) || normalized.findings.some((d) => !isFindingDraftLike(d))) {
      return new CheckOutcome({
        status: CheckStatus.ERROR,
        actual: "Plugin findings must be FindingDraft instances.",
      });
    }
    if (co.blocker !== null && co.blocker !== undefined && !isBlockerDraftLike(co.blocker)) {
      return new CheckOutcome({
        status: CheckStatus.ERROR,
        actual: "Plugin blocker must be a BlockerDraft instance.",
      });
    }

    const invalid = invalidEvidencePaths(this.evidence, normalized.evidence);
    if (invalid.length > 0) {
      return new CheckOutcome({
        status: CheckStatus.ERROR,
        actual: "Plugin returned evidence outside this run's evidence directory.",
        metadata: { limitation: `Invalid plugin evidence paths: ${invalid.slice(0, 5).join(", ")}` },
      });
    }

    if (normalized.findings.length > 0) {
      const allowed = new Set(normalized.evidence);
      for (const draft of normalized.findings) {
        const draftEvidence = normalizeStringArray(draft.evidence);
        if (draftEvidence.some((p) => !allowed.has(p))) {
          return new CheckOutcome({
            status: CheckStatus.ERROR,
            actual: "Plugin finding evidence must be included in the check evidence.",
          });
        }
      }
      if (normalized.evidence.length === 0 && normalized.findings.some((d) => normalizeStringArray(d.evidence).length === 0)) {
        return new CheckOutcome({
          status: CheckStatus.ERROR,
          actual: "Plugin findings require evidence before they can be recorded.",
        });
      }
    }

    // ensure normalized arrays on returned outcome
    co.evidence = normalized.evidence;
    return co;
  }
}

export function signaturePayload(definition: CheckDefinition, entryPoint: string): Buffer {
  const payload = {
    schema_version: PLUGIN_SCHEMA_VERSION,
    entry_point: entryPoint,
    id: definition.id,
    title: definition.title,
    domain: definition.domain,
    // Legacy metadata retained in v1 signature for parity/compatibility.
    persona: definition.persona ?? "",
    kind: definition.kind,
    intent: definition.intent,
    expected: definition.expected,
    base_weight: definition.base_weight,
    requires: definition.requires,
  };
  return Buffer.from(canonicalJson(payload), "utf8");
}

export function resolvePluginTrustFile(root: string = process.cwd()): string {
  return path.join(path.resolve(root), DEFAULT_PLUGIN_TRUST_FILE);
}

export function loadTrustKeys(
  trustFilePath: string,
  log?: (message: string) => void,
): Record<string, string> {
  try {
    if (!fsSync.existsSync(trustFilePath)) return {};
    const raw = fsSync.readFileSync(trustFilePath, "utf8");
    const payload = JSON.parse(raw) as unknown;
    if (!isRecord(payload)) {
      log?.(`WARNING: plugin trust store ${trustFilePath} needs a 'keys' object.`);
      return {};
    }
    let keysRaw: unknown = payload;
    if ("keys" in payload) {
      if (!isRecord(payload.keys)) {
        log?.(`WARNING: plugin trust store ${trustFilePath} needs a 'keys' object.`);
        return {};
      }
      keysRaw = payload.keys;
    }
    if (!isRecord(keysRaw)) {
      log?.(`WARNING: plugin trust store ${trustFilePath} needs a 'keys' object.`);
      return {};
    }
    const out: Record<string, string> = {};
    for (const [keyId, secret] of Object.entries(keysRaw)) {
      if (typeof secret === "string" && secret) out[String(keyId)] = secret;
    }
    return out;
  } catch (err) {
    log?.(`WARNING: could not read plugin trust store ${trustFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

export function saveTrustKeys(trustFilePath: string, keys: Record<string, string>): string {
  const resolved = path.resolve(trustFilePath);
  const dir = path.dirname(resolved);
  fsSync.mkdirSync(dir, { recursive: true });
  const payload = {
    keys: Object.fromEntries(
      Object.entries(keys)
        .filter(([, secret]) => typeof secret === "string" && secret.length > 0)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  fsSync.writeFileSync(resolved, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return resolved;
}

export function signPlugin(
  definition: CheckDefinition,
  entryPoint: string,
  keyId: string,
  secret: string,
): string {
  const digest = createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(signaturePayload(definition, entryPoint))
    .digest("hex");
  return `${PLUGIN_SIGNATURE_SCHEME}:${keyId}:${digest}`;
}

export function parsePluginSignature(signature: string): { keyId: string; digest: string } {
  const parts = String(signature || "").split(":");
  if (parts.length !== 3 || parts[0] !== PLUGIN_SIGNATURE_SCHEME || !parts[1] || !parts[2]) {
    throw new PluginError(
      `Plugin signature must look like '${PLUGIN_SIGNATURE_SCHEME}:<key_id>:<hex_digest>'.`,
    );
  }
  return { keyId: parts[1], digest: parts[2] };
}

function parseSignature(signature: string): { keyId: string; digest: string } {
  return parsePluginSignature(signature);
}

export function verifyPluginSignature(
  definition: CheckDefinition,
  entryPoint: string,
  signature: string,
  trustKeys: Record<string, string>,
): { valid: boolean; keyId: string; error?: string } {
  try {
    const { keyId, digest } = parsePluginSignature(signature);
    const secret = trustKeys[keyId];
    if (!secret) {
      return { valid: false, keyId, error: `unknown signing key '${keyId}'` };
    }
    const expected = createHmac("sha256", Buffer.from(secret, "utf8"))
      .update(signaturePayload(definition, entryPoint))
      .digest("hex");
    const a = Buffer.from(digest, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false, keyId, error: `signature did not verify against key '${keyId}'` };
    }
    return { valid: true, keyId };
  } catch (err) {
    return { valid: false, keyId: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Normalize and validate a plugin-authored definition into the registry/check
 * definition shape used for loading, planning, signing, and validation.
 */
export function definePluginDefinition(input: unknown): CheckDefinition {
  if (!isRecord(input)) {
    throw new PluginError("Plugin definition must be an object.");
  }
  const id = typeof input.id === "string" ? input.id : "";
  const title = typeof input.title === "string" ? input.title : (typeof input.name === "string" ? input.name : "");
  const domain = typeof input.domain === "string" ? input.domain : "";
  const kind = typeof input.kind === "string" ? input.kind : "plugin";
  const intent = typeof input.intent === "string" ? input.intent : (typeof input.description === "string" ? input.description : "");
  const expected = typeof input.expected === "string" ? input.expected : "";
  const persona = typeof input.persona === "string" ? input.persona : "";
  const requires = typeof input.requires === "string" ? input.requires : "any";
  const rawWeight = input.base_weight;
  const baseWeight = typeof rawWeight === "number" ? rawWeight : Number(rawWeight ?? 1);
  const def: CheckDefinition = {
    id,
    title,
    domain,
    persona,
    kind,
    intent,
    expected,
    base_weight: Number.isFinite(baseWeight) ? baseWeight : 1,
    requires,
  };
  if (!CHECK_ID_PATTERN.test(def.id)) {
    throw new PluginError(
      `Check id '${def.id}' must start with a lower-case letter and use only lower-case letters, digits, '.', '_', or '-'.`,
    );
  }
  if (!def.title.trim()) throw new PluginError(`Check '${def.id}' needs a non-empty title.`);
  if (!def.domain.trim()) throw new PluginError(`Check '${def.id}' needs a non-empty domain.`);
  if (!["static", "browser", "plugin"].includes(def.kind)) {
    throw new PluginError(`Check '${def.id}' has unknown kind '${def.kind}'; use static, browser, or plugin.`);
  }
  if (!KNOWN_INPUT_REQUIREMENTS.has(def.requires)) {
    throw new PluginError(
      `Check '${def.id}' has unknown input requirement '${def.requires}'; use ${Array.from(KNOWN_INPUT_REQUIREMENTS).sort().join(", ")}.`,
    );
  }
  if (!Number.isFinite(def.base_weight) || def.base_weight <= 0) {
    throw new PluginError(`Check '${def.id}' base_weight must be greater than zero.`);
  }
  return def;
}

function toCheckDefinition(input: unknown): CheckDefinition {
  return definePluginDefinition(input);
}

/**
 * Define a typed, registry-compatible check plugin for authoring/export.
 * The returned object can be signed and loaded by `CheckRegistry`.
 */
export function definePlugin<TDef extends PluginDefinitionInput>(input: DefinePluginInput<TDef>): CheckPlugin {
  if (!isRecord(input)) {
    throw new PluginError("Plugin must be an object with definition and evaluate.");
  }
  if (typeof input.evaluate !== "function") {
    throw new PluginError("Plugin evaluator is not callable.");
  }
  const definition = definePluginDefinition(input.definition);
  return {
    definition,
    evaluate: input.evaluate,
    ...(typeof input.signature === "string" && input.signature ? { signature: input.signature } : {}),
  };
}

function pluginFromLoaded(loaded: unknown): CheckPlugin {
  if (isRecord(loaded) && isRecord(loaded.definition) && typeof loaded.evaluate === "function") {
    return {
      definition: toCheckDefinition(loaded.definition),
      evaluate: loaded.evaluate as unknown as PluginEvaluator,
      ...(typeof loaded.signature === "string" && loaded.signature ? { signature: loaded.signature } : {}),
    };
  }
  if (isRecord(loaded) && typeof loaded.id === "string" && typeof loaded.evaluate === "function") {
    // allow flat shape
    return {
      definition: toCheckDefinition(loaded),
      evaluate: loaded.evaluate as unknown as PluginEvaluator,
      ...(typeof loaded.signature === "string" && loaded.signature ? { signature: loaded.signature } : {}),
    };
  }
  if (isRecord(loaded) && "definition" in loaded && "evaluate" in loaded) {
    const def = loaded.definition;
    const ev = loaded.evaluate;
    if (typeof ev !== "function") throw new PluginError("Plugin evaluator is not callable.");
    return {
      definition: toCheckDefinition(def),
      evaluate: ev as unknown as PluginEvaluator,
      ...(typeof loaded.signature === "string" && loaded.signature ? { signature: loaded.signature } : {}),
    };
  }
  throw new PluginError("Entry point must load a CheckPlugin (or an object with definition, evaluate, and signature).");
}

export function loadNodeEntryPoints(group: string = PLUGIN_ENTRY_POINT_GROUP): Promise<PluginEntryPoint[]> {
  // Best-effort Node/ESM entry-point discovery via package.json "lemma.checks" / "quality_harness.checks" maps
  // in installed packages is environment-dependent. Core provides an explicit loader hook; callers/tests may inject
  // discovered entry points. Here we return [] by default to keep discovery deterministic and dependency-free.
  void group;
  return Promise.resolve([]);
}

export class CheckRegistry implements CheckRegistryLike {
  readonly trustKeys: Record<string, string>;
  readonly trustFile: string;
  readonly logFn: (message: string) => void;

  private readonly _definitions = new Map<string, CheckDefinition>();
  private readonly _evaluators = new Map<string, PluginEvaluator>();
  private readonly _sources = new Map<string, string>();
  private readonly _blocked = new Map<string, string>();
  private readonly _ownerHints = new Map<string, string>();

  constructor(options?: { trustKeys?: Record<string, string>; trustFile?: string; log?: (message: string) => void }) {
    this.trustKeys = { ...(options?.trustKeys ?? {}) };
    this.trustFile = options?.trustFile ?? DEFAULT_PLUGIN_TRUST_FILE;
    this.logFn = options?.log ?? (() => {});
  }

  get definitions(): CheckDefinition[] {
    return Array.from(this._definitions.values());
  }

  ids(): string[] {
    return Array.from(this._definitions.keys());
  }

  get(id: string): CheckDefinition | undefined {
    return this._definitions.get(id);
  }

  evaluator(id: string): PluginEvaluator | undefined {
    return this._evaluators.get(id);
  }

  source(id: string): string {
    return this._sources.get(id) ?? "";
  }

  blockedReason(id: string): string {
    return this._blocked.get(id) ?? "";
  }

  ownerHint(id: string): string {
    return this._ownerHints.get(id) ?? "";
  }

  block(id: string, reason: string): void {
    if (!this._definitions.has(id) || this._blocked.has(id)) return;
    this._blocked.set(id, reason);
    this.logFn(`WARNING: check '${id}' blocked: ${reason}`);
  }

  builtinCount(): number {
    let n = 0;
    for (const [id, source] of this._sources.entries()) {
      if (source === "builtin" && !this._blocked.has(id)) n += 1;
    }
    return n;
  }

  pluginCount(): number {
    let n = 0;
    for (const [id, source] of this._sources.entries()) {
      if (source.startsWith("plugin:") && !this._blocked.has(id)) n += 1;
    }
    return n;
  }

  blockedCount(): number {
    return this._blocked.size;
  }

  hasPluginFailures(): boolean {
    for (const source of this._sources.values()) {
      if (source === "plugin-blocked") return true;
    }
    return false;
  }

  registerBuiltins(): void {
    for (const def of CHECK_CATALOG) {
      this.register(def, { source: "builtin", trusted: true });
    }
  }

  register(
    definition: CheckDefinition,
    opts?: { evaluator?: PluginEvaluator; source?: string; signature?: string; entryPoint?: string; trusted?: boolean },
  ): void {
    this._validateDefinition(definition);
    const source = opts?.source ?? "builtin";
    if (this._definitions.has(definition.id)) {
      throw new PluginError(
        `Duplicate check id '${definition.id}' from ${source}; already registered by ${this._sources.get(definition.id) ?? "unknown"}.`,
      );
    }
    if (!opts?.trusted) {
      this._verifySignature(definition, opts?.entryPoint ?? "", opts?.signature ?? "");
    }
    if (opts?.evaluator !== undefined && typeof opts.evaluator !== "function") {
      throw new PluginError(`Plugin evaluator for '${definition.id}' is not callable.`);
    }
    this._definitions.set(definition.id, definition);
    this._sources.set(definition.id, source);
    if (opts?.evaluator) this._evaluators.set(definition.id, opts.evaluator);
  }

  async loadEntryPoint(entryPoint: PluginEntryPoint): Promise<void> {
    const name = String(entryPoint?.name ?? "unnamed");
    const value = String(entryPoint?.value ?? "");
    let plugin: CheckPlugin | null = null;
    try {
      const loaded = await entryPoint.load();
      plugin = pluginFromLoaded(loaded);
      if (typeof plugin.evaluate !== "function") throw new PluginError("Plugin evaluator is not callable.");
      if (plugin.definition.kind !== "static" && plugin.definition.kind !== "plugin") {
        throw new PluginError("Browser plugin kind is not supported yet; use 'static' or 'plugin'.");
      }
      this.register(plugin.definition, {
        evaluator: plugin.evaluate,
        source: `plugin:${value || name}`,
        signature: plugin.signature ?? "",
        entryPoint: value,
        trusted: false,
      });
    } catch (err) {
      if (err instanceof PluginError) {
        this.blockPlugin(name, plugin?.definition ?? null, err.message, value || name);
      } else {
        const msg = `Plugin '${name}' could not be imported: ${(err as Error)?.name ?? "Error"}: ${err instanceof Error ? err.message : String(err)}`;
        this.blockFailure(name, msg);
      }
    }
  }

  blockPlugin(label: string, definition: CheckDefinition | null, reason: string, entryPointName = ""): void {
    let def = definition;
    if (def) {
      try {
        this._validateDefinition(def);
      } catch {
        def = null;
      }
      if (def && !this._definitions.has(def.id)) {
        this._definitions.set(def.id, def);
        this._sources.set(def.id, "plugin-blocked");
        this._blocked.set(def.id, reason);
        this._ownerHints.set(def.id, def.persona || "functional");
        this.logFn(`WARNING: plugin check '${def.id}' blocked: ${reason}`);
        return;
      }
    }
    void entryPointName;
    this.blockFailure(label, reason, def?.persona || "functional");
  }

  blockFailure(label: string, reason: string, ownerHint = "functional"): string {
    const base = `plugin.load.${slug(label)}`;
    let checkId = base;
    let suffix = 2;
    while (this._definitions.has(checkId)) {
      checkId = `${base}-${suffix}`;
      suffix += 1;
    }
    const definition: CheckDefinition = {
      id: checkId,
      title: `Plugin '${label}' could not be loaded`,
      domain: "functional",
      kind: "plugin",
      intent: "Keep a plugin configuration failure visible as a coverage gap.",
      expected: "The plugin loads, validates, and is owned by exactly one persona.",
      base_weight: 1.0,
      requires: "any",
      persona: "",
    };
    this._definitions.set(checkId, definition);
    this._sources.set(checkId, "plugin-blocked");
    this._blocked.set(checkId, reason);
    this._ownerHints.set(checkId, ownerHint || "functional");
    this.logFn(`WARNING: plugin '${label}' blocked: ${reason}`);
    return checkId;
  }

  blockMissingPluginCheck(checkId: string, personaId: string, domain: string, reason: string): void {
    if (this._definitions.has(checkId)) return;
    const definition: CheckDefinition = {
      id: checkId,
      title: `Plugin check '${checkId}' could not be loaded`,
      domain: domain || "functional",
      kind: "plugin",
      intent: "Keep a plugin load failure visible as a coverage gap.",
      expected: "The plugin loads, validates, signs, and is owned by exactly one persona.",
      base_weight: 1.0,
      requires: "any",
      persona: "",
    };
    this._definitions.set(checkId, definition);
    this._sources.set(checkId, "plugin-blocked");
    this._blocked.set(checkId, reason);
    this._ownerHints.set(checkId, personaId);
    this.logFn(`WARNING: plugin check '${checkId}' blocked: ${reason}`);
  }

  /**
   * Resolve every registered check to exactly one persona owner (D16).
   * Built-in checks are a configuration contract: unowned/multiply-owned checks
   * fail validation before execution. Plugin ownership failures become blocked
   * checks (coverage gaps) instead.
   */
  validateOwnership(personas: Iterable<PersonaOwnershipSource>): void {
    const ownership = checkOwnership(personas);
    for (const checkId of this.ids()) {
      const owners = ownership[checkId] ?? [];
      const source = this._sources.get(checkId) ?? "";
      const isPlugin = source.startsWith("plugin");
      if (owners.length === 1) {
        if (this._blocked.has(checkId) && !this._ownerHints.get(checkId)) {
          const owner = owners[0];
          if (owner) this._ownerHints.set(checkId, owner);
        }
        continue;
      }
      const reason = ownershipErrorMessage(checkId, owners);
      if (!isPlugin) {
        throw new PersonaError(reason);
      }
      if (this._blocked.has(checkId)) {
        continue;
      }
      this.block(checkId, reason);
    }
  }

  fingerprint(): string {
    const trustKeyIds = Object.keys(this.trustKeys).sort();
    const items = Array.from(this._definitions.keys()).sort().map((checkId) => ({
      id: checkId,
      source: this._sources.get(checkId) ?? "",
      blocked: this._blocked.get(checkId) ?? "",
      evaluator: this._evaluators.has(checkId),
      key_id: this._ownerHints.get(checkId) ?? "",
    }));
    const payload = {
      schema_version: "quality-harness.registry-fingerprint/v1",
      trust_keys: trustKeyIds,
      checks: items,
    };
    return createHash("sha256")
      .update(Buffer.from(canonicalJson(payload), "utf8"))
      .digest("hex");
  }

  private _validateDefinition(definition: CheckDefinition): void {
    if (!definition || typeof definition !== "object") throw new PluginError("Plugin definition must be a CheckDefinition.");
    if (!definition.id || !CHECK_ID_PATTERN.test(definition.id)) {
      throw new PluginError(
        `Check id '${definition.id}' must start with a lower-case letter and use only lower-case letters, digits, '.', '_', or '-'.`,
      );
    }
    if (!String(definition.title || "").trim()) throw new PluginError(`Check '${definition.id}' needs a non-empty title.`);
    if (!String(definition.domain || "").trim()) throw new PluginError(`Check '${definition.id}' needs a non-empty domain.`);
    if (!["static", "browser", "plugin"].includes(definition.kind)) {
      throw new PluginError(`Check '${definition.id}' has unknown kind '${definition.kind}'; use static, browser, or plugin.`);
    }
    if (!KNOWN_INPUT_REQUIREMENTS.has(definition.requires)) {
      throw new PluginError(
        `Check '${definition.id}' has unknown input requirement '${definition.requires}'; use ${Array.from(KNOWN_INPUT_REQUIREMENTS).sort().join(", ")}.`,
      );
    }
    const weight = Number(definition.base_weight);
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new PluginError(`Check '${definition.id}' base_weight must be greater than zero.`);
    }
  }

  private _verifySignature(definition: CheckDefinition, entryPoint: string, signature: string): void {
    if (!signature) {
      throw new PluginError(
        `Plugin '${definition.id}' is unsigned. Sign its entry point with a key from ${this.trustFile}.`,
      );
    }
    const { keyId, digest } = parseSignature(signature);
    const secret = this.trustKeys[keyId];
    if (!secret) {
      throw new PluginError(
        `Plugin '${definition.id}' references unknown signing key '${keyId}'. Add it to ${this.trustFile}.`,
      );
    }
    const expected = createHmac("sha256", Buffer.from(secret, "utf8"))
      .update(signaturePayload(definition, entryPoint))
      .digest("hex");
    const a = Buffer.from(digest, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new PluginError(`Plugin '${definition.id}' signature did not verify against key '${keyId}'.`);
    }
  }
}

export async function buildRegistry(options?: {
  root?: string;
  entryPoints?: Iterable<PluginEntryPoint> | null;
  log?: (message: string) => void;
  trustFile?: string;
  includeBuiltins?: boolean;
}): Promise<CheckRegistry> {
  const root = path.resolve(options?.root ?? process.cwd());
  const trustFile = options?.trustFile ?? path.join(root, DEFAULT_PLUGIN_TRUST_FILE);
  const log = options?.log;
  const registry = new CheckRegistry({
    trustKeys: loadTrustKeys(trustFile, log),
    trustFile,
    ...(log ? { log } : {}),
  });
  if (options?.includeBuiltins !== false) {
    registry.registerBuiltins();
  }
  try {
    const discovered = options?.entryPoints
      ? Array.from(options.entryPoints)
      : await loadNodeEntryPoints(PLUGIN_ENTRY_POINT_GROUP);
    for (const ep of discovered.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      await registry.loadEntryPoint(ep);
    }
  } catch (err) {
    registry.blockFailure(
      "entry-point discovery",
      `Installed plugin discovery failed: ${(err as Error)?.name ?? "Error"}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return registry;
}

// Compatibility helper for file-based local plugins (useful for tests and local dev).
export async function loadPluginFromFile(filePath: string, exportName = "PLUGIN"): Promise<CheckPlugin> {
  const abs = path.resolve(filePath);
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  const loaded = mod[exportName] ?? mod.default ?? mod;
  return pluginFromLoaded(loaded);
}
