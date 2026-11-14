import { describe, expect, it } from "vitest";

import {
  AuthError,
  BillingError,
  CorruptStateError,
  EXIT_CODES,
  HarnessError,
  KillSwitchHaltError,
  MalformedWorkflowError,
  OperatorInterruptError,
  PersonaError,
  PluginError,
  PolicyError,
  PolicyThresholdError,
  QueueError,
  QuotaError,
  RedactionError,
  SsrfError,
  StateError,
  WorkflowError,
  exitCodeForError,
  toErrorPayload,
} from "../../src/index.js";

import { emitError, runCli } from "../../../cli/src/errors.js";

describe("LEM-007 typed errors and exit-code contract", () => {
  it("defines typed errors for all required failure domains", () => {
    const cases = [
      new HarnessError("h"),
      new WorkflowError("w"),
      new StateError("s"),
      new PersonaError("p"),
      new PluginError("pl"),
      new PolicyError("po"),
      new AuthError("a"),
      new QuotaError("q"),
      new BillingError("b"),
      new QueueError("qu"),
      new SsrfError("ss"),
      new RedactionError("r"),
    ];
    for (const err of cases) {
      expect(err).toBeInstanceOf(HarnessError);
      expect(typeof err.errorCode).toBe("string");
      expect(typeof err.exitCode).toBe("number");
      expect(toErrorPayload(err).ok).toBe(false);
    }
  });

  it("maps exit codes per contract", () => {
    expect(EXIT_CODES.pass).toBe(0);
    expect(EXIT_CODES.policyThresholdFailed).toBe(1);
    expect(EXIT_CODES.harnessError).toBe(2);
    expect(EXIT_CODES.killSwitchHalt).toBe(3);
    expect(EXIT_CODES.interrupt).toBe(130);

    expect(exitCodeForError(new HarnessError("x"))).toBe(2);
    expect(exitCodeForError(new WorkflowError("x"))).toBe(2);
    expect(exitCodeForError(new StateError("x"))).toBe(2);
    expect(exitCodeForError(new PolicyThresholdError("threshold"))).toBe(1);
    expect(exitCodeForError(new KillSwitchHaltError("halt"))).toBe(3);
    expect(exitCodeForError(new OperatorInterruptError())).toBe(130);
    expect(exitCodeForError(new Error("boom"))).toBe(2);
  });

  it("produces typed payloads with stable error codes for malformed workflow and corrupt state", () => {
    const wf = new MalformedWorkflowError("Workflow file is malformed", { path: "wf.yaml" });
    const wfPayload = toErrorPayload(wf);
    expect(wfPayload).toEqual({
      ok: false,
      error: {
        type: "MalformedWorkflowError",
        code: "workflow_malformed",
        message: "Workflow file is malformed",
        details: { path: "wf.yaml" },
      },
    });

    const st = new CorruptStateError("progress.json is corrupt", { path: ".lemma/progress.json" });
    const stPayload = toErrorPayload(st);
    expect(stPayload).toEqual({
      ok: false,
      error: {
        type: "CorruptStateError",
        code: "state_corrupt",
        message: "progress.json is corrupt",
        details: { path: ".lemma/progress.json" },
      },
    });
  });

  it("keeps stdout JSON-only and sends diagnostics to stderr with correct exit codes", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) };

    const code1 = await runCli(
      () => ({
        stdoutJson: { ok: true, value: 1 },
        stderrLines: ["progress: starting", "progress: done"],
        exitCode: EXIT_CODES.pass as 0,
      }),
      io,
    );
    expect(code1).toBe(0);
    expect(out.join("")).toBe(`${JSON.stringify({ ok: true, value: 1 })}\n`);
    expect(err).toEqual(["progress: starting\n", "progress: done\n"]);
    expect(() => {
      JSON.parse(out.join(""));
    }).not.toThrow();
    expect(out.join("")).not.toContain("progress: starting");

    out.length = 0;
    err.length = 0;
    const emitted = emitError(io, new MalformedWorkflowError("bad workflow"));
    expect(emitted.exitCode).toBe(2);
    expect(err).toEqual([]);
    const parsed = JSON.parse(out.join("")) as { ok: boolean; error: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("workflow_malformed");

    out.length = 0;
    err.length = 0;
    const code2 = await runCli(() => {
      throw new PolicyThresholdError("score below threshold", { score: 40, min: 60 });
    }, io);
    expect(code2).toBe(1);
    expect(err).toEqual([]);
    const p2 = JSON.parse(out.join("")) as { error: { code: string; type: string } };
    expect(p2.error.code).toBe("policy_threshold_failed");
    expect(p2.error.type).toBe("PolicyThresholdError");

    out.length = 0;
    err.length = 0;
    const code3 = await runCli(() => {
      throw new KillSwitchHaltError("halted");
    }, io);
    expect(code3).toBe(3);
    expect(err).toEqual([]);

    out.length = 0;
    err.length = 0;
    const code130 = await runCli(() => {
      throw new OperatorInterruptError();
    }, io);
    expect(code130).toBe(130);
    expect(err).toEqual([]);
  });
});
