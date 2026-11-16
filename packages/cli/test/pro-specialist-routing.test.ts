import { describe, expect, it } from "vitest";

import { proCommand } from "../src/commands.js";
import { ProUnavailableError } from "@lemma/pro";

describe("LEM-157 CLI pro specialist routing", () => {
  it("routes `lemma pro <specialist>` and returns typed ProUnavailableError when unlicensed (no partial execution)", async () => {
    const io = { stdout: (_: string) => {}, stderr: (_: string) => {} };
    await expect(proCommand(["security", "--target", "."], io as any)).rejects.toBeInstanceOf(ProUnavailableError);
    await expect(proCommand(["confidence", "--target", "."], io as any)).rejects.toMatchObject({ errorCode: "pro_unavailable" });
    await expect(proCommand(["performance", "--target", "."], io as any)).rejects.toBeInstanceOf(ProUnavailableError);
    await expect(proCommand(["privacy", "--target", "."], io as any)).rejects.toBeInstanceOf(ProUnavailableError);
  });
});
