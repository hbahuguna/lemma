import { afterEach, describe, expect, it } from "vitest";

import {
  adfToText,
  buildJiraFormFields,
  collectJiraForm,
  createHttpFormApi,
  fetchJiraIssue,
  formatJiraContext,
  getJiraFormApi,
  parseJiraTarget,
  readLocalServiceConfig,
  redactSecrets,
  registerJiraContextTool,
  sanitizeError,
  summarizeJiraIssue,
} from "../src/index.js";

const TOKEN = "jira_secret_token_123456";
const prevUrl = process.env.ASSAY_OPENCODE_URL;
const prevPassword = process.env.ASSAY_OPENCODE_PASSWORD;

afterEach(() => {
  if (prevUrl === undefined) delete process.env.ASSAY_OPENCODE_URL;
  else process.env.ASSAY_OPENCODE_URL = prevUrl;
  if (prevPassword === undefined) delete process.env.ASSAY_OPENCODE_PASSWORD;
  else process.env.ASSAY_OPENCODE_PASSWORD = prevPassword;
});

describe("LEM-092 Jira context, ADF, and redaction", () => {
  it("builds form fields, parses targets, flattens ADF, and redacts secrets", () => {
    const fields = buildJiraFormFields();
    expect(fields.map((f) => f.key)).toEqual(["jira_site", "jira_issue_key", "jira_email", "jira_token"]);
    expect(fields[0]?.description).toMatch(/https:\/\/ is added if omitted/);
    expect(fields[2]?.format).toBe("email");
    expect(fields[3]?.required).toBe(true);
    expect(fields[3]?.description).toMatch(/in-memory/);
    expect(fields[3]?.description).toMatch(/not written to harness state/i);
    expect(fields[3]?.description).toMatch(/local form store/i);
    expect(fields[3]?.description).toMatch(/scoped, revocable token/i);

    const refFields = buildJiraFormFields({ tokenRef: "JIRA_API_TOKEN", site: "https://acme.atlassian.net" });
    expect(refFields.map((f) => f.key)).toEqual(["jira_site", "jira_issue_key", "jira_email"]);
    expect(refFields[0]?.default).toBe("https://acme.atlassian.net");

    expect(parseJiraTarget("acme.atlassian.net", "proj-123")).toEqual({ site: "https://acme.atlassian.net", issueKey: "PROJ-123" });
    expect(parseJiraTarget("https://acme.atlassian.net/", "https://acme.atlassian.net/browse/PROJ-9")).toEqual({ site: "https://acme.atlassian.net", issueKey: "PROJ-9" });
    expect(parseJiraTarget("https://jira.example.com", "12345")).toEqual({ site: "https://jira.example.com", issueKey: "12345" });
    expect(() => parseJiraTarget("", "PROJ-1")).toThrow(/Jira site is required/);
    expect(() => parseJiraTarget("https://acme.atlassian.net", "")).toThrow(/Jira issue key is required/);

    const text = adfToText({
      type: "doc",
      content: [
        { type: "heading", content: [{ type: "text", text: "Acceptance criteria" }] },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "First" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Second" }] }] },
          ],
        },
      ],
    });
    expect(text).toMatch(/Acceptance criteria/);
    expect(text).toMatch(/- First/);
    expect(text).toMatch(/- Second/);

    const redacted = redactSecrets(`token=${TOKEN} password: hunter2 Authorization: Bearer abc123`, [TOKEN]);
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("abc123");
    expect(redacted).toMatch(/\[REDACTED\]/);

    const sanitized = sanitizeError(new Error(`upstream rejected ${TOKEN}`), [TOKEN]);
    expect(sanitized).not.toContain(TOKEN);
    expect(sanitized).toMatch(/\[REDACTED\]/);
  });

  it("summarizes and formats Jira context with token-safe redaction", () => {
    const issue = {
      key: "PROJ-123",
      self: "https://acme.atlassian.net/rest/api/2/issue/10001",
      names: {
        customfield_10016: "Acceptance Criteria",
        customfield_10017: "Story Points",
        customfield_10018: "Unrelated Notes",
      },
      fields: {
        summary: "Checkout fails for returning users",
        description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `token=${TOKEN}` }] }] },
        status: { name: "In Progress" },
        priority: { name: "High" },
        issuetype: { name: "Bug" },
        labels: ["release-blocker"],
        assignee: { displayName: "Ada Lovelace" },
        reporter: { displayName: "Grace Hopper" },
        created: "2026-01-01T00:00:00.000+0000",
        updated: "2026-01-02T00:00:00.000+0000",
        resolution: null,
        fixVersions: [{ name: "1.2.0" }],
        components: [{ name: "Checkout" }],
        parent: { key: "PROJ-100", fields: { summary: "Checkout epic" } },
        subtasks: [{ key: "PROJ-124", fields: { summary: "Add regression test", status: { name: "To Do" } } }],
        issuelinks: [{ type: { name: "Blocks" }, outwardIssue: { key: "PROJ-200", fields: { summary: "Payment retry" } } }],
        customfield_10016: "User can complete checkout with a saved card",
        customfield_10017: 3,
        customfield_10018: "not planning context",
      },
    } as unknown;

    const context = summarizeJiraIssue(issue, TOKEN, "https://acme.atlassian.net");
    expect(context.issueKey).toBe("PROJ-123");
    expect(context.status).toBe("In Progress");
    expect(context.priority).toBe("High");
    expect(context.labels).toEqual(["release-blocker"]);
    expect(context.fixVersions).toEqual(["1.2.0"]);
    expect(context.parent?.key).toBe("PROJ-100");
    expect(context.subtasks[0]?.key).toBe("PROJ-124");
    expect(context.links[0]?.outward?.key).toBe("PROJ-200");
    expect(context.customFields["Acceptance Criteria"]).toBe("User can complete checkout with a saved card");
    expect(context.customFields["Story Points"]).toBe(3);
    expect(context.customFields["Unrelated Notes"]).toBeUndefined();
    expect(context.description).not.toContain(TOKEN);
    expect(context.description).toMatch(/\[REDACTED\]/);

    const output = formatJiraContext(context);
    expect(output).not.toContain(TOKEN);
    expect(output).toMatch(/Jira context fetched/);
    expect(output).toMatch(/```json/);
  });

  it("collects and fetches Jira context via injectable APIs with token-safe errors", async () => {
    let polls = 0;
    const created: Array<{ sessionID: string; payload: { title: string; fields: unknown[] } }> = [];
    const api = {
      create: (sessionID: string, payload: { title: string; fields: unknown[] }) => { created.push({ sessionID, payload }); return Promise.resolve({ id: "frm_test" }); },
      get: () => {
        polls += 1;
        if (polls === 1) return Promise.resolve({ id: "frm_test", state: { status: "pending" as const } });
        return Promise.resolve({
          id: "frm_test",
          state: { status: "answered" as const, answer: { jira_site: "https://acme.atlassian.net", jira_issue_key: "PROJ-123", jira_email: "qa@example.com", jira_token: TOKEN } },
        });
      },
    };
    const answer = await collectJiraForm(api, "ses_test", {});
    expect(created[0]?.payload.title).toBe("Jira context");
    expect(created[0]?.payload.fields.length).toBe(4);
    expect(answer?.jira_issue_key).toBe("PROJ-123");
    expect(answer?.jira_token).toBe(TOKEN);

    const cancelled = await collectJiraForm({ create: () => Promise.resolve({ id: "frm_cancel" }), get: () => Promise.resolve({ id: "frm_cancel", state: { status: "cancelled" as const } }) }, "ses_test", {});
    expect(cancelled).toBeNull();

    let request: { url: string; init?: RequestInit } | undefined;
    const fakeFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      request = init ? { url, init } : { url };
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            key: "PROJ-123",
            self: "https://acme.atlassian.net/rest/api/2/issue/10001",
            names: { customfield_10016: "Acceptance Criteria" },
            fields: {
              summary: "Checkout bug",
              description: `token=${TOKEN}`,
              status: { name: "Open" },
              customfield_10016: "User can pay",
            },
          }),
      } as Response);
    }) as typeof fetch;
    const context = await fetchJiraIssue({
      site: "https://acme.atlassian.net",
      issueKey: "PROJ-123",
      email: "qa@example.com",
      token: TOKEN,
      fetchImpl: fakeFetch,
    });
    expect(request?.url).toMatch(/\/rest\/api\/2\/issue\/PROJ-123/);
    const auth = (request?.init?.headers as Record<string, string> | undefined)?.Authorization;
    expect(auth).toBe(`Basic ${Buffer.from(`qa@example.com:${TOKEN}`).toString("base64")}`);
    expect(context.customFields["Acceptance Criteria"]).toBe("User can pay");
    expect(context.description).not.toContain(TOKEN);

    await expect(
      fetchJiraIssue({
        site: "https://acme.atlassian.net",
        issueKey: "PROJ-123",
        email: "qa@example.com",
        token: TOKEN,
        fetchImpl: () => Promise.resolve({ ok: false, status: 401 } as Response),
      }),
    ).rejects.toThrow(/Jira authentication failed/);
  });

  it("resolves/registers form API helpers and registers token-safe Jira context tool", async () => {
    const calls: Array<[string, unknown]> = [];
    const ctx = {
      session: {
        form: {
          create: (input: unknown) => { calls.push(["create", input]); return Promise.resolve({ id: "frm_native" }); },
          get: (input: unknown) => { calls.push(["get", input]); return Promise.resolve({ id: "frm_native", state: { status: "pending" } }); },
        },
      },
    };
    const api = getJiraFormApi(ctx);
    expect((await api.create("ses_1", { title: "Jira context", metadata: {}, fields: [] })).id).toBe("frm_native");
    expect((await api.get("ses_1", "frm_native")).state?.status).toBe("pending");
    expect(calls[0]?.[1]).toEqual({ sessionID: "ses_1", title: "Jira context", metadata: {}, fields: [] });

    const rawCalls: Array<[string, unknown]> = [];
    const rawCtx = {
      client: {
        _client: {
          post: (input: unknown) => { rawCalls.push(["post", input]); return Promise.resolve({ data: { data: { id: "frm_raw" } } }); },
          get: (input: unknown) => { rawCalls.push(["get", input]); return Promise.resolve({ data: { data: { id: "frm_raw", state: { status: "answered", answer: { jira_token: TOKEN } } } } }); },
        },
      },
    };
    const rawApi = getJiraFormApi(rawCtx);
    expect((await rawApi.create("ses_2", { title: "Jira context", metadata: {}, fields: [] })).id).toBe("frm_raw");
    expect((rawCalls[0]?.[1] as { url?: string })?.url).toBe("/api/session/{sessionID}/form");

    const httpCalls: Array<{ url: string; init?: RequestInit }> = [];
    const httpApi = createHttpFormApi(
      "http://127.0.0.1:1234/",
      "Basic test",
      (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        httpCalls.push(init ? { url, init } : { url });
        const isCreate = init?.method === "POST";
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: isCreate
                ? { id: "frm_http", title: "Jira context", fields: [] }
                : { id: "frm_http", state: { status: "answered", answer: { jira_token: TOKEN } } },
            }),
        } as Response);
      },
    );
    expect((await httpApi.create("ses_1", { title: "Jira context", metadata: {}, fields: [] })).id).toBe("frm_http");
    expect(httpCalls[0]?.url).toBe("http://127.0.0.1:1234/api/session/ses_1/form");

    process.env.ASSAY_OPENCODE_URL = "http://127.0.0.1:9999/";
    process.env.ASSAY_OPENCODE_PASSWORD = "test-password";
    const config = readLocalServiceConfig();
    expect(config?.baseUrl).toBe("http://127.0.0.1:9999");
    expect(config?.auth).toBe(`Basic ${Buffer.from("opencode:test-password").toString("base64")}`);
    expect(typeof getJiraFormApi({}).create).toBe("function");

    const added: string[] = [];
    const regCtx = {
      session: {
        form: {
          create: () => Promise.resolve({ id: "frm_should_not_be_created" }),
          get: () => Promise.resolve({ id: "frm_should_not_be_created", state: { status: "cancelled" } }),
        },
      },
      tool: {
        transform: (editorFn: (editor: { add: (tool: { name: string }) => void }) => void) => {
          editorFn({ add: (tool) => added.push(tool.name) });
          return Promise.resolve();
        },
      },
    };
    expect(await registerJiraContextTool(regCtx)).toBe(false);
    expect(added).toEqual([]);
  });
});
