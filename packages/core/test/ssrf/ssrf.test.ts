import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SsrfError, isSafeUrl, loadAllowlist, validateRedirectChain, validateUrl } from "../../src/ssrf.js";

const originalEnv = { ...process.env };
const temps: string[] = [];

afterEach(() => {
  process.env = { ...originalEnv };
  for (const t of temps.splice(0)) {
    try { rmSync(t, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

describe("LEM-059 SSRF-safe target validation and allowlists", () => {
  it("rejects private and metadata targets without leaking resolved internal addresses", async () => {
    const resolver = (host: string) => {
      if (host === "localhost") return ["127.0.0.1"];
      if (host === "metadata.google.internal") return ["169.254.169.254"];
      return ["93.184.216.34"];
    };
    const urls = [
      "http://127.0.0.1:8080/",
      "http://localhost:8080/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/",
    ];
    for (const url of urls) {
      await expect(validateUrl(url, { resolver })).rejects.toBeInstanceOf(SsrfError);
      try {
        await validateUrl(url, { resolver });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        expect(msg).not.toContain("127.0.0.1");
        expect(msg).not.toContain("169.254");
      }
    }
  });

  it("allows a public target via injected resolver", async () => {
    const resolver = () => ["93.184.216.34"];
    await expect(validateUrl("https://example.com/", { resolver })).resolves.toBe("https://example.com/");
  });

  it("allows localhost only with config allowlist loaded from root", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lemma-ssrf-"));
    temps.push(root);
    const dir = path.join(root, ".harness");
    rmSync(dir, { recursive: true, force: true });
    // create .harness/ssrf-allowlist.json
    const harnessDir = path.join(root, ".harness");
    // ensure dir exists
    await import("node:fs/promises").then((fs) => fs.mkdir(harnessDir, { recursive: true }));
    writeFileSync(path.join(harnessDir, "ssrf-allowlist.json"), JSON.stringify({ allow: ["127.0.0.0/8", "localhost"] }), "utf8");

    const resolver = () => ["127.0.0.1"];
    await expect(validateUrl("http://localhost:8080/", { root, resolver })).resolves.toBe("http://localhost:8080/");
    await expect(validateUrl("http://localhost:8080/", { resolver })).rejects.toBeInstanceOf(SsrfError);
  });

  it("CIDR allowlist overrides private range", async () => {
    const resolver = () => ["10.1.2.3"];
    await expect(
      validateUrl("http://internal.example/", { allowlist: ["10.0.0.0/8"], resolver }),
    ).resolves.toBe("http://internal.example/");
  });

  it("checks DNS rebinding on every validation call", async () => {
    const addresses = ["93.184.216.34", "127.0.0.1"];
    let i = 0;
    const resolver = () => [addresses[Math.min(i++, addresses.length - 1)]!];
    await expect(validateUrl("https://example.com/", { resolver })).resolves.toBe("https://example.com/");
    await expect(validateUrl("https://example.com/", { resolver })).rejects.toBeInstanceOf(SsrfError);
  });

  it("revalidates redirect chains at every hop", async () => {
    const resolver = () => ["93.184.216.34"];
    await expect(
      validateRedirectChain(["https://example.com/", "http://127.0.0.1:8080/secret"], { resolver }),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("loads allowlist from environment variable", () => {
    process.env.QH_SSRF_ALLOWLIST = "127.0.0.0/8,localhost";
    expect(loadAllowlist()).toEqual(["127.0.0.0/8", "localhost"]);
  });

  it("isSafeUrl returns boolean and compatibility aliases exist", async () => {
    const resolver = () => ["93.184.216.34"];
    await expect(isSafeUrl("https://example.com/", { resolver })).resolves.toBe(true);
    await expect(isSafeUrl("http://127.0.0.1/", { resolver: () => ["127.0.0.1"] })).resolves.toBe(false);
  });
});
