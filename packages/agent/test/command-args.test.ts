import { describe, expect, it } from "vitest";

import {
  SUBCOMMANDS,
  assayInvocation,
  browserInvocation,
  demoInvocation,
  extractUrl,
  isUrl,
} from "../src/index.js";

const PERSONAS = "/tmp/personas";

describe("LEM-088 command argument builders", () => {
  it("extracts and validates URLs", () => {
    expect(extractUrl("please check https://example.com/app?x=1 now")).toBe("https://example.com/app?x=1");
    expect(extractUrl("no url here")).toBeNull();
    expect(isUrl("http://localhost:3000")).toBe(true);
    expect(isUrl("https://example.com")).toBe(true);
    expect(isUrl("ftp://example.com")).toBe(false);
    expect(isUrl(".")).toBe(false);
  });

  it("browserInvocation requires explicit http(s) URL", () => {
    const empty = browserInvocation("", PERSONAS);
    expect(empty.args).toEqual([]);
    expect(empty.error).toMatch(/needs a reachable URL/);
    const dir = browserInvocation("./my-app", PERSONAS);
    expect(dir.args).toEqual([]);
    expect(dir.error).toBeTruthy();
  });

  it("browserInvocation calls the browser subcommand with interaction defaults", () => {
    const invocation = browserInvocation("http://localhost:3000", PERSONAS);
    expect(invocation.args).toEqual([
      "browser",
      "http://localhost:3000",
      "--crawl",
      "--max-pages",
      "25",
      "--timeout-ms",
      "120000",
    ]);
    expect(invocation.args[0]).toBe("browser");
    expect(invocation.args).not.toContain("run");
    expect(invocation.args).not.toContain("--no-browser");
    expect(invocation.args).not.toContain("--headless");
  });

  it("browserInvocation passes safe browser flags and never swaps the target", () => {
    const passthrough = browserInvocation(
      "http://localhost:3000 --viewport 390x844 --no-browser --target https://evil.example",
      PERSONAS,
    );
    expect(passthrough.args).toContain("--viewport");
    expect(passthrough.args[passthrough.args.indexOf("--viewport") + 1]).toBe("390x844");
    expect(passthrough.args).not.toContain("--no-browser");
    expect(passthrough.args.filter((arg) => arg === "browser").length).toBe(1);
    expect(passthrough.args).not.toContain("--target");
    expect(passthrough.args).not.toContain("https://evil.example");
  });

  it("assayInvocation and demoInvocation follow ported semantics", () => {
    expect(SUBCOMMANDS.has("run")).toBe(true);
    expect(SUBCOMMANDS.has("report")).toBe(true);

    const url = assayInvocation("check https://example.com", PERSONAS);
    expect(url.args).not.toContain("--no-browser");
    expect(url.args[url.args.indexOf("--target") + 1]).toBe("https://example.com");

    const staticDefault = assayInvocation("review release readiness", PERSONAS);
    expect(staticDefault.args).toContain("--no-browser");
    expect(staticDefault.args[staticDefault.args.indexOf("--target") + 1]).toBe(".");

    const passthrough = assayInvocation("status --root .harness", PERSONAS);
    expect(passthrough.args).toEqual(["status", "--root", ".harness"]);

    const demoStatic = demoInvocation("", PERSONAS);
    expect(demoStatic.args).toEqual([
      "run",
      "--target",
      ".",
      "--no-browser",
      "--personas-dir",
      PERSONAS,
      "--intent",
      "Lemma demo assessment",
    ]);

    const demoUrl = demoInvocation("http://localhost:3000 --no-crawl --headless", PERSONAS);
    expect(demoUrl.args[demoUrl.args.indexOf("--target") + 1]).toBe("http://localhost:3000");
    expect(demoUrl.args).not.toContain("--no-browser");
    expect(demoUrl.args).toContain("--no-crawl");
    expect(demoUrl.args).toContain("--headless");
    expect(demoUrl.args).not.toContain("--crawl");
    expect(demoUrl.args).not.toContain("--headed");
  });
});
