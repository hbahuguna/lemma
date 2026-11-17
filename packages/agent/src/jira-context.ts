/**
 * Jira context form/fetch/flatten/redaction utilities (ported from assay).
 * Host-neutral core logic with injectable form API/fetch; optional host wiring helpers.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface JiraFormPrefill {
  site?: string;
  issueKey?: string;
  email?: string;
  tokenRef?: string;
}

export interface JiraFormField {
  key: string;
  type: "string";
  title: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  format?: "email" | "uri";
  default?: string;
}

export interface JiraFormPayload {
  title: string;
  metadata: Record<string, unknown>;
  fields: JiraFormField[];
}

export interface JiraFormInfo {
  id: string;
  sessionID?: string;
  title?: string;
  fields?: JiraFormField[];
}

export interface JiraFormDetail extends JiraFormInfo {
  state?: {
    status: "pending" | "answered" | "cancelled";
    answer?: Record<string, unknown>;
    message?: string;
  };
}

export interface JiraFormApi {
  create(sessionID: string, payload: JiraFormPayload): Promise<JiraFormInfo>;
  get(sessionID: string, formID: string): Promise<JiraFormDetail>;
}

export interface JiraIssueContext {
  source: "jira";
  site: string;
  issueKey: string;
  url: string;
  summary: string;
  description: string;
  status?: string;
  priority?: string;
  type?: string;
  labels: string[];
  assignee?: string;
  reporter?: string;
  created?: string;
  updated?: string;
  resolution?: string;
  fixVersions: string[];
  components: string[];
  parent?: { key?: string; summary?: string };
  subtasks: Array<{ key?: string; summary?: string; status?: string }>;
  links: Array<{ type?: string; inward?: { key?: string; summary?: string }; outward?: { key?: string; summary?: string } }>;
  customFields: Record<string, unknown>;
}

const JIRA_FORM_TIMEOUT_MS = 10 * 60 * 1000;

export function buildJiraFormFields(prefill: JiraFormPrefill = {}): JiraFormField[] {
  const fields: JiraFormField[] = [
    {
      key: "jira_site",
      type: "string",
      title: "Jira site",
      description: "Base URL, e.g. https://yourorg.atlassian.net (https:// is added if omitted)",
      placeholder: "https://yourorg.atlassian.net",
      required: true,
    },
    {
      key: "jira_issue_key",
      type: "string",
      title: "Jira issue key",
      description: "Issue key or full issue URL, e.g. PROJ-123",
      placeholder: "PROJ-123",
      required: true,
    },
    {
      key: "jira_email",
      type: "string",
      format: "email",
      title: "Jira email",
      description: "Email for your Jira Cloud account. Used only for this request.",
      placeholder: "you@example.com",
      required: true,
    },
  ];
  if (prefill.site) fields[0]!.default = prefill.site;
  if (prefill.issueKey) fields[1]!.default = prefill.issueKey;
  if (prefill.email) fields[2]!.default = prefill.email;
  if (!prefill.tokenRef) {
    fields.push({
      key: "jira_token",
      type: "string",
      title: "Jira API token",
      description:
        "Used only in-memory for this Jira request and not written to harness state, evidence, or logs. OpenCode keeps form answers in its local form store, so use a scoped, revocable token.",
      placeholder: "Paste API token",
      required: true,
    });
  }
  return fields;
}

const DEFAULT_OPENCODE_URL = "http://127.0.0.1:49374";

export interface LocalServiceConfig {
  baseUrl: string;
  auth: string;
}

/**
 * Locate local OpenCode-compatible service for native Form API fallback.
 * Checks env vars and common local service config files.
 * Secrets are used only for Authorization header construction (in-memory).
 */
export function readLocalServiceConfig(): LocalServiceConfig | null {
  const configuredPort =
    process.env.ASSAY_OPENCODE_PORT ||
    process.env.LEMMA_OPENCODE_PORT ||
    process.env.OPENCODE_PORT ||
    "";
  const baseUrl = (
    process.env.ASSAY_OPENCODE_URL ||
    process.env.LEMMA_OPENCODE_URL ||
    process.env.OPENCODE_URL ||
    (configuredPort ? `http://127.0.0.1:${configuredPort}` : DEFAULT_OPENCODE_URL)
  ).replace(/\/+$/, "");

  let password =
    process.env.ASSAY_OPENCODE_PASSWORD ||
    process.env.LEMMA_OPENCODE_PASSWORD ||
    process.env.OPENCODE_SERVER_PASSWORD ||
    process.env.OPENCODE_PASSWORD ||
    "";
  let username = process.env.ASSAY_OPENCODE_USERNAME || process.env.LEMMA_OPENCODE_USERNAME || process.env.OPENCODE_USERNAME || "opencode";

  if (!password) {
    const candidates = [
      join(homedir(), ".config", "opencode", "service.json"),
      join(homedir(), ".local", "share", "opencode", "service.json"),
      join(homedir(), ".opencode", "service.json"),
    ];
    for (const p of candidates) {
      try {
        const parsed = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
        const pw = parsed?.password ?? parsed?.token ?? parsed?.serverPassword;
        const user = parsed?.username ?? parsed?.user;
        if (typeof pw === "string" && pw) password = pw;
        if (typeof user === "string" && user) username = user;
        if (password) break;
      } catch {
        // continue
      }
    }
  }

  if (!password) return null;
  return {
    baseUrl,
    auth: "Basic " + Buffer.from(`${username}:${password}`).toString("base64"),
  };
}

export function createHttpFormApi(
  baseUrl: string,
  auth: string,
  fetchImpl: typeof fetch = fetch,
): JiraFormApi {
  const root = baseUrl.replace(/\/+$/, "");
  const request = async (p: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await fetchImpl(`${root}${p}`, {
      ...init,
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    if (!response.ok) {
      throw new Error(`native Form API request failed with HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { data?: unknown };
    return payload?.data ?? payload;
  };

  return {
    create: async (sessionID, payload) => {
      const data = await request(`/api/session/${encodeURIComponent(sessionID)}/form`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      return data as JiraFormInfo;
    },
    get: async (sessionID, formID) => {
      const data = await request(
        `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`,
      );
      return data as JiraFormDetail;
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function getJiraFormApi(ctx: unknown): JiraFormApi {
  const c = isRecord(ctx) ? ctx : {};
  const session = isRecord(c.session) ? c.session : undefined;
  const sessionForm = session && isRecord(session.form) ? session.form : undefined;
  if (typeof sessionForm?.create === "function" && typeof sessionForm?.get === "function") {
    const createFn = sessionForm.create as (input: unknown) => Promise<unknown>;
    const getFn = sessionForm.get as (input: unknown) => Promise<unknown>;
    return {
      create: async (sessionID, payload) => {
        const res = await createFn({ sessionID, ...payload });
        const r = isRecord(res) && "data" in res ? (res as { data: unknown }).data : res;
        return r as JiraFormInfo;
      },
      get: async (sessionID, formID) => {
        const res = await getFn({ sessionID, formID });
        const r = isRecord(res) && "data" in res ? (res as { data: unknown }).data : res;
        return r as JiraFormDetail;
      },
    };
  }

  const client = isRecord(c.client) ? c.client : undefined;
  const raw = client && isRecord(client._client) ? client._client : undefined;
  if (typeof raw?.post === "function" && typeof raw?.get === "function") {
    const postFn = raw.post as (input: unknown) => Promise<unknown>;
    const getFn = raw.get as (input: unknown) => Promise<unknown>;
    return {
      create: async (sessionID, payload) => {
        const res = await postFn({
          url: "/api/session/{sessionID}/form",
          path: { sessionID },
          headers: { "Content-Type": "application/json" },
          body: payload,
        });
        const r = isRecord(res) ? res : {};
        const data = isRecord(r.data) ? r.data : r;
        return ((isRecord(data) && "data" in data ? (data as { data: unknown }).data : data) ?? data) as JiraFormInfo;
      },
      get: async (sessionID, formID) => {
        const res = await getFn({
          url: "/api/session/{sessionID}/form/{formID}",
          path: { sessionID, formID },
        });
        const r = isRecord(res) ? res : {};
        const data = isRecord(r.data) ? r.data : r;
        return ((isRecord(data) && "data" in data ? (data as { data: unknown }).data : data) ?? data) as JiraFormDetail;
      },
    };
  }

  const local = readLocalServiceConfig();
  if (local) return createHttpFormApi(local.baseUrl, local.auth);

  throw new Error("native Form API is unavailable in this runtime");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function collectJiraForm(
  api: JiraFormApi,
  sessionID: string,
  prefill: JiraFormPrefill = {},
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const created = await api.create(sessionID, {
    title: "Jira context",
    metadata: { kind: "assay.jira" },
    fields: buildJiraFormFields(prefill),
  });
  const formID = created?.id;
  if (!formID) throw new Error("Jira form creation returned no form id");

  const deadline = Date.now() + JIRA_FORM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    const detail = await api.get(sessionID, formID);
    const state = detail?.state;
    if (state?.status === "answered") return state.answer || {};
    if (state?.status === "cancelled") return null;
    await sleep(500, signal);
  }
  return null;
}

export function normalizeJiraSite(raw: string): string {
  let site = String(raw || "").trim();
  if (!site) throw new Error("Jira site is required");
  if (!/^https?:\/\//i.test(site)) site = `https://${site}`;
  const url = new URL(site);
  if (!url.host) throw new Error("Jira site is not a valid URL");
  return `${url.protocol}//${url.host}`;
}

export function parseJiraTarget(siteRaw: string, issueRaw: string): { site: string; issueKey: string } {
  let site = String(siteRaw || "").trim();
  let issue = String(issueRaw || "").trim();

  if (/^https?:\/\//i.test(issue)) {
    const url = new URL(issue);
    site = `${url.protocol}//${url.host}`;
    const pathMatch = url.pathname.match(/\/browse\/([^/?#]+)/i) || url.pathname.match(/\/issues\/([^/?#]+)/i);
    if (pathMatch && pathMatch[1]) issue = decodeURIComponent(pathMatch[1]);
  }

  site = normalizeJiraSite(site);
  if (!issue) throw new Error("Jira issue key is required");

  const keyMatch = issue.match(/\b([A-Z][A-Z0-9_]+-\d+)\b/i);
  issue = keyMatch?.[1] ? keyMatch[1].toUpperCase() : issue.replace(/^\/+|\/+$/g, "");
  if (!issue) throw new Error("Jira issue key is required");

  return { site, issueKey: issue };
}

export function redactSecrets(value: string, secrets: string[] = []): string {
  let output = String(value ?? "");
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    output = output.split(secret).join("[REDACTED]");
  }
  output = output.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
  output = output.replace(/\bBasic\s+[A-Za-z0-9+/=._-]+/gi, "Basic [REDACTED]");
  output = output.replace(
    /(\b(?:api[_-]?key|token|password|secret|authorization|bearer)\b\s*[:=]\s*)([^\s,;]+)/gi,
    "$1[REDACTED]",
  );
  return output;
}

export function sanitizeError(error: unknown, secrets: string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message, secrets);
}

export function adfToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(adfToText).join("");
  if (typeof value !== "object") return "";

  const node = value as Record<string, unknown>;
  const type = node.type;
  const content = node.content;
  const textVal = node.text;
  if (type === "text") return typeof textVal === "string" ? textVal : "";
  if (type === "hardBreak") return "\n";
  if (type === "paragraph") return `${adfToText(content)}\n`;
  if (type === "heading") return `\n${adfToText(content)}\n`;
  if (type === "listItem") return `- ${adfToText(content).trim()}\n`;
  if (type === "codeBlock") return `\n\`\`\`\n${adfToText(content)}\n\`\`\`\n`;
  return adfToText(content);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function summarizeJiraIssue(data: unknown, token: string, site: string): JiraIssueContext {
  const root = isRecord(data) ? data : {};
  const fields = isRecord(root.fields) ? root.fields : {};
  const names = isRecord(root.names) ? root.names : {};
  const secrets = [token];
  const text = (value: unknown) => redactSecrets(adfToText(value), secrets);
  const customFields: Record<string, unknown> = {};

  for (const [id, value] of Object.entries(fields)) {
    if (!id.startsWith("customfield_")) continue;
    const nameVal = names[id];
    const name = typeof nameVal === "string" ? nameVal : id;
    if (!/acceptance|criteria|story point|estimate|epic|sprint|team|environment|severity|impact/i.test(name)) continue;
    if (value == null) continue;
    if (typeof value === "number" || typeof value === "boolean") {
      customFields[name] = value;
    } else if (typeof value === "string") {
      customFields[name] = redactSecrets(value, secrets);
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      customFields[name] = value.map((item) => redactSecrets(String(item), secrets));
    } else if (isRecord(value) && typeof value.value === "string") {
      customFields[name] = redactSecrets(value.value, secrets);
    }
  }

  const status = isRecord(fields.status) ? asString(fields.status.name) : undefined;
  const priority = isRecord(fields.priority) ? asString(fields.priority.name) : undefined;
  const type = isRecord(fields.issuetype) ? asString(fields.issuetype.name) : undefined;
  const assignee = isRecord(fields.assignee) ? asString(fields.assignee.displayName) : undefined;
  const reporter = isRecord(fields.reporter) ? asString(fields.reporter.displayName) : undefined;
  const resolution = isRecord(fields.resolution) ? asString(fields.resolution.name) : undefined;
  const parentObj = isRecord(fields.parent) ? fields.parent : undefined;
  const parentFields = parentObj && isRecord(parentObj.fields) ? parentObj.fields : undefined;

  return {
    source: "jira",
    site,
    issueKey: typeof root.key === "string" || typeof root.key === "number" ? String(root.key) : "",
    url: `${site}/browse/${encodeURIComponent(typeof root.key === "string" || typeof root.key === "number" ? String(root.key) : "")}`,
    summary: text(fields.summary),
    description: text(fields.description),
    ...(status ? { status } : {}),
    ...(priority ? { priority } : {}),
    ...(type ? { type } : {}),
    labels: Array.isArray(fields.labels) ? fields.labels.map((label) => String(label)) : [],
    ...(assignee ? { assignee } : {}),
    ...(reporter ? { reporter } : {}),
    ...(() => { const v = asString(fields.created); return v ? { created: v } : {}; })(),
    ...(() => { const v = asString(fields.updated); return v ? { updated: v } : {}; })(),
    ...(resolution ? { resolution } : {}),
    fixVersions: Array.isArray(fields.fixVersions)
      ? fields.fixVersions.map((item) => (isRecord(item) ? asString(item.name) : undefined)).filter((x): x is string => !!x)
      : [],
    components: Array.isArray(fields.components)
      ? fields.components.map((item) => (isRecord(item) ? asString(item.name) : undefined)).filter((x): x is string => !!x)
      : [],
    ...(parentObj
      ? (() => { const k = asString(parentObj.key); return { parent: { ...(k ? { key: k } : {}), summary: text(parentFields?.summary) } }; })()
      : {}),
    subtasks: Array.isArray(fields.subtasks)
      ? fields.subtasks.map((item) => {
          const it = isRecord(item) ? item : {};
          const f = isRecord(it.fields) ? it.fields : {};
          const st = isRecord(f.status) ? asString(f.status.name) : undefined;
          const key = asString(it.key);
          return {
            ...(key ? { key } : {}),
            summary: text(f.summary),
            ...(st ? { status: st } : {}),
          };
        })
      : [],
    links: Array.isArray(fields.issuelinks)
      ? fields.issuelinks.map((item) => {
          const it = isRecord(item) ? item : {};
          const linkType = isRecord(it.type) ? asString(it.type.name) : undefined;
          const inward = isRecord(it.inwardIssue) ? it.inwardIssue : undefined;
          const outward = isRecord(it.outwardIssue) ? it.outwardIssue : undefined;
          const inwardFields = inward && isRecord(inward.fields) ? inward.fields : undefined;
          const outwardFields = outward && isRecord(outward.fields) ? outward.fields : undefined;
          const inwardKey = inward ? asString(inward.key) : undefined;
          const outwardKey = outward ? asString(outward.key) : undefined;
          return {
            ...(linkType ? { type: linkType } : {}),
            ...(inward
              ? { inward: { ...(inwardKey ? { key: inwardKey } : {}), summary: text(inwardFields?.summary) } }
              : {}),
            ...(outward
              ? { outward: { ...(outwardKey ? { key: outwardKey } : {}), summary: text(outwardFields?.summary) } }
              : {}),
          };
        })
      : [],
    customFields,
  };
}

export function formatJiraContext(context: JiraIssueContext): string {
  return `Jira context fetched (token redacted). Use it to refine the test plan and coverage.\n\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\``;
}

export async function fetchJiraIssue(input: {
  site: string;
  issueKey: string;
  email: string;
  token: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<JiraIssueContext> {
  const { site, issueKey } = parseJiraTarget(input.site, input.issueKey);
  const email = String(input.email || "").trim();
  const token = String(input.token || "").trim();
  if (!email) throw new Error("Jira email is required");
  if (!token) throw new Error("Jira API token is required");

  const url = `${site}/rest/api/2/issue/${encodeURIComponent(issueKey)}?expand=names&fields=*all`;
  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  const fetcher = input.fetchImpl || fetch;
  const response = await fetcher(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    ...(input.signal ? { signal: input.signal } : {}),
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Jira authentication failed (HTTP ${response.status}); check site, email, token, and permissions`);
    }
    if (response.status === 404) {
      throw new Error(`Jira issue not found (HTTP ${response.status}); check the issue key and site`);
    }
    throw new Error(`Jira request failed (HTTP ${response.status})`);
  }

  const data = await response.json();
  return summarizeJiraIssue(data, token, site);
}

export interface JiraContextToolContext {
  sessionID?: string;
  signal?: AbortSignal;
}

export interface JiraContextToolDefinition {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute: (input: JiraFormPrefill, context: JiraContextToolContext) => Promise<{ content: string }>;
}

export function buildJiraContextToolDefinition(
  ctx: unknown,
  name: "assay_jira_context" | "lemma_jira_context",
): JiraContextToolDefinition {
  return {
    name,
    description:
      "Collect Jira ticket context for test planning and return redacted issue details. Prefers native Jira form when available; can also fetch directly when site, issueKey, email, and tokenRef (or provided token) are supplied. Never expose raw tokens in output.",
    input: {
      type: "object",
      properties: {
        site: { type: "string", description: "Optional Jira base URL (e.g. https://yourorg.atlassian.net)." },
        issueKey: { type: "string", description: "Optional Jira issue key or issue URL." },
        email: { type: "string", description: "Optional Jira account email." },
        tokenRef: {
          type: "string",
          description: "Optional environment variable name holding the Jira API token (preferred; avoids form token field).",
        },
        token: {
          type: "string",
          description: "Optional API token for direct fetch fallback (use only when necessary; prefer tokenRef or native form). Never echo this value.",
        },
      },
      additionalProperties: false,
    },
    execute: async (input: JiraFormPrefill & { token?: string } = {}, context: JiraContextToolContext = {}) => {
      const sessionID = context.sessionID;
      const directToken = (typeof input.tokenRef === "string" && input.tokenRef)
        ? (process.env[input.tokenRef] ?? "")
        : (typeof input.token === "string" ? input.token : "");
      const hasDirectFields = Boolean(
        (typeof input.site === "string" && input.site.trim()) &&
        (typeof input.issueKey === "string" && input.issueKey.trim()) &&
        (typeof input.email === "string" && input.email.trim()) &&
        directToken,
      );

      if (hasDirectFields) {
        try {
          const issue = await fetchJiraIssue({
            site: String(input.site),
            issueKey: String(input.issueKey),
            email: String(input.email),
            token: directToken,
            ...(context.signal ? { signal: context.signal } : {}),
          });
          return { content: formatJiraContext(issue) };
        } catch (error) {
          return {
            content: `Jira context unavailable: ${sanitizeError(error, [directToken])}. Verify site/issue/email/tokenRef (or token) and permissions, or provide ticket context via paste in chat.`,
          };
        }
      }

      if (!sessionID) {
        return {
          content:
            "Jira context unavailable: no active session for native form. Provide ticket context by pasting the Jira issue details/AC in chat, or call this tool with site, issueKey, email, and tokenRef (env var) if available. Record a context gap and continue with safe unique steps.",
        };
      }

      let api: JiraFormApi | null = null;
      try {
        api = getJiraFormApi(ctx);
      } catch (error) {
        return {
          content:
            `Jira form is unavailable in this runtime (${sanitizeError(error)}). Provide ticket context by pasting the Jira issue details/AC in chat, or set a Jira API token in an env var and call \`lemma_jira_context\`/\`assay_jira_context\` with site, issueKey, email, and tokenRef. How do you want to provide the ticket context?`,
        };
      }

      let answer: Record<string, unknown> | null;
      try {
        answer = await collectJiraForm(api, sessionID, input || {}, context.signal);
      } catch (error) {
        return {
          content: `Jira context unavailable: ${sanitizeError(error)}. Provide ticket context by pasting details in chat or using tokenRef with direct fields. Record a context gap and continue with safe unique steps.`,
        };
      }
      if (!answer) {
        return { content: "Jira context cancelled. Provide ticket context by pasting details in chat if needed, then continue with safe unique steps." };
      }

      const token = (typeof input.tokenRef === "string" && input.tokenRef)
        ? (process.env[input.tokenRef] ?? "")
        : (typeof answer.jira_token === "string" ? answer.jira_token : "");
      if (!token) {
        const ref = (typeof input.tokenRef === "string" && input.tokenRef) ? `environment variable ${input.tokenRef}` : "API token";
        return { content: `Jira context unavailable: ${ref} is missing. Provide ticket context by pasting details in chat or retry with tokenRef. Record a context gap and continue.` };
      }

      try {
        const issue = await fetchJiraIssue({
          site: typeof answer.jira_site === "string" ? answer.jira_site : (typeof input.site === "string" ? input.site : ""),
          issueKey: typeof answer.jira_issue_key === "string" ? answer.jira_issue_key : (typeof input.issueKey === "string" ? input.issueKey : ""),
          email: typeof answer.jira_email === "string" ? answer.jira_email : (typeof input.email === "string" ? input.email : ""),
          token,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { content: formatJiraContext(issue) };
      } catch (error) {
        return {
          content: `Jira context unavailable: ${sanitizeError(error, [token])}. Provide ticket context by pasting details in chat or retry with corrected fields/tokenRef. Record a context gap and continue with safe unique steps.`,
        };
      }
    },
  };
}

/**
 * Context gathering is no longer part of any /lemma* command. Registration is
 * intentionally a no-op so no host ever exposes a Jira context form. Kept as
 * an exported symbol for backward compatibility with older installed plugins.
 */
export async function registerJiraContextTool(_ctx: unknown): Promise<boolean> {
  return false;
}
