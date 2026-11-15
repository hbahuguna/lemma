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

  it("browserInvocation builds live run with defaults and no --no-browser", () => {
    const invocation = browserInvocation("http://localhost:3000", PERSONAS);
    expect(invocation.args).toEqual([
      "run",
      "--target",
      "http://localhost:3000",
      "--personas-dir",
      PERSONAS,
      "--intent",
      "Assay browser assessment",
      "--crawl",
      "--max-pages",
      "8",
      "--mobile",
      "--headed",
      "--active",
      "--active-interactions",
    ]);
    expect(invocation.args).not.toContain("--no-browser");
  });

  it("browserInvocation lets explicit flags override defaults and passes safe flags", () => {
    const overridden = browserInvocation(
      "http://localhost:3000 --no-crawl --max-pages 3 --no-mobile --headless",
      PERSONAS,
    );
    expect(overridden.args).toContain("--no-crawl");
    expect(overridden.args[overridden.args.indexOf("--max-pages") + 1]).toBe("3");
    expect(overridden.args).toContain("--no-mobile");
    expect(overridden.args).toContain("--headless");
    expect(overridden.args).not.toContain("--crawl");
    expect(overridden.args).not.toContain("--mobile");
    expect(overridden.args).not.toContain("--headed");

    const passthrough = browserInvocation(
      "http://localhost:3000 --headed --mobile --viewport 390x844 --no-browser --target https://evil.example",
      PERSONAS,
    );
    expect(passthrough.args).toContain("--viewport");
    expect(passthrough.args[passthrough.args.indexOf("--viewport") + 1]).toBe("390x844");
    expect(passthrough.args).toContain("--headed");
    expect(passthrough.args).toContain("--mobile");
    expect(passthrough.args).toContain("--active");
    expect(passthrough.args).toContain("--active-interactions");
    expect(passthrough.args).not.toContain("--no-browser");
    expect(passthrough.args.filter((arg) => arg === "--target").length).toBe(1);
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
      "Assay demo assessment",
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
