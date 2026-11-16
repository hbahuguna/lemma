import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { JobQueue, STATUS_CANCELLED, STATUS_COMPLETED, STATUS_FAILED, STATUS_QUEUED } from "../src/queue.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-cloud-queue-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("LEM-119 tenant queue and isolation", () => {
  it("submits jobs and enforces owner-only polling without leaking tenant roots", async () => {
    const root = await makeTempDir();
    const queue = new JobQueue(root);
    const job = queue.submit("ws_acme", "/tmp/target", { options: { no_browser: true } });
    expect(job.job_id.startsWith("job-")).toBe(true);
    expect(job.status).toBe(STATUS_QUEUED);
    expect(job.workspace_id).toBe("ws_acme");
    expect((job as any).root).toBeUndefined();

    const owner = queue.getJob("ws_acme", job.job_id);
    expect(owner?.job_id).toBe(job.job_id);
    expect(queue.getJob("ws_other", job.job_id)).toBeNull();
    expect(queue.listJobs("ws_other")).toEqual([]);

    const state = JSON.parse(fs.readFileSync(path.join(root, ".lemma", "cloud", "queue.json"), "utf8"));
    expect(state.jobs[job.job_id].root).toContain(path.join(".lemma", "tenants", "ws_acme"));
  });

  it("isolates tenant roots and jobs across workspaces", async () => {
    const root = await makeTempDir();
    const queue = new JobQueue(root);
    const a = queue.submit("ws_one", "/tmp/one");
    const b = queue.submit("ws_two", "/tmp/two");
    expect(queue.tenantRootFor("ws_one")).not.toBe(queue.tenantRootFor("ws_two"));
    expect(queue.getJob("ws_one", b.job_id)).toBeNull();
    expect(queue.getJob("ws_two", a.job_id)).toBeNull();
    expect(queue.listJobs("ws_one").map((j) => j.job_id)).toEqual([a.job_id]);
    expect(queue.listJobs("ws_two").map((j) => j.job_id)).toEqual([b.job_id]);
  });

  it("cancels queued jobs and writes tenant kill signal for running jobs", async () => {
    const root = await makeTempDir();
    const queue = new JobQueue(root);
    const queued = queue.submit("ws_acme", "/tmp/target");
    const cancelled = queue.cancel("ws_acme", queued.job_id, "operator stop");
    expect(cancelled.status).toBe(STATUS_CANCELLED);
    expect(cancelled.cancel_requested).toBe(true);

    const runningJob = queue.submit("ws_run", "/tmp/target");
    const claimed = queue.claimNext();
    expect(claimed?.job_id).toBe(runningJob.job_id);
    expect(claimed?.status).toBe("running");
    const runningCancelled = queue.cancel("ws_run", runningJob.job_id, "stop now");
    expect(runningCancelled.status).toBe("running");
    expect(runningCancelled.status_detail).toBe("cancellation requested");
    const killPath = path.join(root, ".lemma", "tenants", "ws_run", ".lemma", "KILL");
    expect(fs.existsSync(killPath)).toBe(true);
    const kill = JSON.parse(fs.readFileSync(killPath, "utf8"));
    expect(kill.reason).toBe("stop now");
  });

  it("recovers running jobs and supports requeue-on-failure then terminal outcome", async () => {
    const root = await makeTempDir();
    const queue = new JobQueue(root, { maxAttempts: 2 });
    const job = queue.submit("ws_acme", "/tmp/target");
    queue.claimNext();
    const recovered = queue.recover();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe(STATUS_QUEUED);
    expect(queue.getJob("ws_acme", job.job_id)?.status).toBe(STATUS_QUEUED);

    // fail once -> requeue, fail again -> terminal failed
    const failing = new JobQueue(root, {
      maxAttempts: 2,
      executor: () => {
        throw new Error("boom");
      },
    });
    // ensure clean queue state for this check
    const root2 = await makeTempDir();
    const fq = new JobQueue(root2, {
      maxAttempts: 2,
      executor: async (j) => {
        if (j.attempt === 1) throw new Error("simulated crash");
        return { status: STATUS_COMPLETED, run_id: "run-ok", findings: 1, confidence: 10 };
      },
    });
    const j2 = fq.submit("ws_acme", "/tmp/t");
    const first = await fq.processNext();
    expect(first?.job_id).toBe(j2.job_id);
    expect(first?.status).toBe(STATUS_QUEUED); // requeued after failure
    const second = await fq.processNext();
    expect(second?.status).toBe(STATUS_COMPLETED);
    expect(second?.run_id).toBe("run-ok");

    const root3 = await makeTempDir();
    const fq2 = new JobQueue(root3, {
      maxAttempts: 2,
      executor: async () => {
        throw new Error("always fails");
      },
    });
    fq2.submit("ws_acme", "/tmp/t");
    expect((await fq2.processNext())?.status).toBe(STATUS_QUEUED);
    expect((await fq2.processNext())?.status).toBe(STATUS_FAILED);

    // keep linter happy for unused var
    expect(failing.maxAttempts).toBe(2);
  });

  it("reports metrics and deletes workspace jobs", async () => {
    const root = await makeTempDir();
    const queue = new JobQueue(root, {
      executor: async (j) => ({ status: STATUS_COMPLETED, duration_seconds: 1.5, run_id: `run-${j.job_id}` }),
    });
    const a = queue.submit("ws_a", "/tmp/a");
    queue.submit("ws_b", "/tmp/b");
    await queue.processNext();
    const metrics = queue.metrics() as any;
    expect(metrics.total).toBe(2);
    expect(metrics.completed).toBe(1);
    expect(metrics.queue_depth).toBe(1);
    expect(metrics.by_status[STATUS_COMPLETED]).toBe(1);
    expect(metrics.average_run_duration_seconds).toBeGreaterThan(0);

    const removed = queue.deleteWorkspaceJobs("ws_a");
    expect(removed).toBe(1);
    expect(queue.getJob("ws_a", a.job_id)).toBeNull();
    expect(queue.listJobs("ws_b")).toHaveLength(1);
  });
});
