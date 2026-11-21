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
    "Lemma browser assessment",
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

describe("browser agent prompt (context gathering removed)", () => {
  it("context protocol is removed", () => {
    expect(CONTEXT_PROTOCOL).toBe("");
  });

  it("browser agent prompt embeds target, command, and invariants without context gathering", () => {
    const prompt = buildBrowserAgentPrompt(INPUT);
    expect(prompt).toMatch(/https:\/\/testradius\.dev/);
    expect(prompt).toMatch(/'lemma' 'plan'/);
    expect(prompt).toMatch(/'lemma' 'browser'/);
    expect(prompt).toMatch(/--crawl/);
    expect(prompt).toMatch(/--max-pages/);
    expect(prompt).toMatch(/--mobile/);
    expect(prompt).toMatch(/--headed/);
    expect(prompt).toMatch(/--active/);
    expect(prompt).not.toMatch(/Context gathering UX/);
    expect(prompt).not.toMatch(/Context checkpoint/i);
    expect(prompt).not.toMatch(/gather context/i);
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
