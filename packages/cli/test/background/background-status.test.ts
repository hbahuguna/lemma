import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/index.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runCli(args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    stdout: (c) => { stdout += c; },
    stderr: (c) => { stderr += c; },
  });
  return { code, stdout, stderr };
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("LEM-150 background CLI", () => {
  it("surfaces background status/summary/events via lemma status --background", async () => {
    const root = await mkdtemp("lemma-cli-bg-");
    tempDirs.push(root);
    const bgDir = path.join(root, ".lemma", "background");
    await fs.mkdir(bgDir, { recursive: true });
    await fs.writeFile(path.join(bgDir, "status.json"), JSON.stringify({ running: true, paused: false, stopped: false, completed_ticks: 2 }), "utf8");
    await fs.writeFile(path.join(bgDir, "summary.json"), JSON.stringify({ runs: [{ run_id: "bg-1", result: { status: "passed", summary: "ok" } }] }), "utf8");
    await fs.writeFile(path.join(bgDir, "events.jsonl"), JSON.stringify({ event: "background_started" }) + "\n" + JSON.stringify({ event: "background_check_completed" }) + "\n", "utf8");
    await fs.writeFile(path.join(bgDir, "KILL"), JSON.stringify({ reason: "stop-bg" }), "utf8");

    const res = await runCli(["status", "--background", "--root", root]);
    expect(res.code).toBe(0);
    expect(res.stderr).toBe("");
    const json = JSON.parse(res.stdout) as any;
    expect(json.status).toBe("ok");
    expect(json.background).toBeTruthy();
    expect(json.background.status.running).toBe(true);
    expect(json.background.summary.runs[0].run_id).toBe("bg-1");
    expect(json.background.events.length).toBe(2);
    expect(json.background.kill.reason).toBe("stop-bg");
  });
});
