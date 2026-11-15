import { describe, expect, it } from "vitest";

import { CONTEXT_PROTOCOL, buildBrowserAgentPrompt, shellQuote } from "../src/index.js";

const INPUT = {
  url: "https://testradius.dev",
  args: [
    "run",
    "--target",
    "https://testradius.dev",
    "--personas-dir",
    "/repo/personas",
    "--intent",
    "Assay browser assessment",
    "--crawl",
    "--max-pages",
    "8",
    "--mobile",
    "--headed",
    "--active",
  ],
  projectDirectory: "/work/project",
  repoRoot: "/repo",
  python: "/usr/local/bin/python3.11",
  ssrfAllowlist: "127.0.0.0/8,::1,localhost",
};

describe("LEM-090 browser agent prompt and invariants", () => {
  it("context protocol requires the native question tool and forbids placeholder waits", () => {
    expect(CONTEXT_PROTOCOL).toMatch(/native `question` tool/);
    expect(CONTEXT_PROTOCOL).toMatch(/Never run `echo`/);
    expect(CONTEXT_PROTOCOL).toMatch(/Never ask for or accept a raw token/);
    expect(CONTEXT_PROTOCOL).toMatch(/Skip/);
    expect(CONTEXT_PROTOCOL).toMatch(/Paste/);
    expect(CONTEXT_PROTOCOL).toMatch(/MCP/);
    expect(CONTEXT_PROTOCOL).toMatch(/Secure env\/secret ref/);
    expect(CONTEXT_PROTOCOL).toMatch(/one decision per question/);
  });

  it("context protocol routes Jira through the native four-field form tool", () => {
    expect(CONTEXT_PROTOCOL).toMatch(/Jira form/);
    expect(CONTEXT_PROTOCOL).toMatch(/assay_jira_context/);
    expect(CONTEXT_PROTOCOL).toMatch(/site, issue key, email, API token/);
    expect(CONTEXT_PROTOCOL).toMatch(/token is consumed by the tool in memory/i);
    expect(CONTEXT_PROTOCOL).toMatch(/do not ask the user to paste it into chat/i);
  });

  it("browser agent prompt embeds the target, command, context flow, and invariants", () => {
    const prompt = buildBrowserAgentPrompt(INPUT);
    expect(prompt).toMatch(/https:\/\/testradius\.dev/);
    expect(prompt).toMatch(/python3\.11 -P -m harness/);
    expect(prompt).toMatch(/--crawl/);
    expect(prompt).toMatch(/--max-pages/);
    expect(prompt).toMatch(/--mobile/);
    expect(prompt).toMatch(/--headed/);
    expect(prompt).toMatch(/--active/);
    expect(prompt).toMatch(/Context gathering UX/);
    expect(prompt).toMatch(/question/);
    expect(prompt).toMatch(/Skip/);
    expect(prompt).toMatch(/no repeated commands/i);
    expect(prompt).toMatch(/coverage gaps, never passes/i);
    expect(prompt).toMatch(/never ask for or persist raw credentials/i);
    expect(prompt).toMatch(/testing environments/i);
  });

  it("shellQuote escapes single quotes for shell safety", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
