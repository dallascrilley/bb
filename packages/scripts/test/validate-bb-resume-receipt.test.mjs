import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateResumeReceipt } from "../../../scripts/validate-bb-resume-receipt.mjs";

const historicalPath = fileURLToPath(
  new URL(
    "../../../docs/receipts/wks-1536-2026-09-04/timeline.json",
    import.meta.url,
  ),
);
const scriptPath = fileURLToPath(
  new URL("../../../scripts/validate-bb-resume-receipt.mjs", import.meta.url),
);

function testOnlyReceipt() {
  const target = {
    threadId: "test-only-thread",
    turnId: "test-only-turn",
    interactionId: "test-only-interaction",
  };
  return {
    ...target,
    evidenceKind: "synthetic-test-only-not-live-proof",
    events: [
      "pending",
      "nativeAnswer",
      "ownerAccepted",
      "execution",
      "completed",
    ].map((kind, index) => ({
      ...target,
      kind,
      timestamp: `2026-09-06T00:00:0${index}.000Z`,
      evidenceRef: `test-only:${kind}`,
      ...(kind === "nativeAnswer" ? {} : { sourceSeq: index + 1 }),
    })),
  };
}

describe("BB resume receipt chronology", () => {
  it("accepts explicit test-only post-answer execution of the original turn", () => {
    expect(validateResumeReceipt(testOnlyReceipt())).toEqual({
      threadId: "test-only-thread",
      turnId: "test-only-turn",
      interactionId: "test-only-interaction",
    });
  });

  it("rejects the retained real completion-before-resolution timeline", () => {
    expect(() =>
      validateResumeReceipt(JSON.parse(readFileSync(historicalPath, "utf8"))),
    ).toThrow("completed before owner resolution");
    const result = spawnSync(process.execPath, [scriptPath, historicalPath], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("completed before owner resolution");
  });

  it.each(["threadId", "turnId", "interactionId"])(
    "rejects execution for another %s",
    (key) => {
      const receipt = testOnlyReceipt();
      receipt.events[3][key] = "another-target";
      expect(() => validateResumeReceipt(receipt)).toThrow(
        "differs from original target",
      );
    },
  );

  it("rejects missing execution despite completed and success claims", () => {
    const receipt = testOnlyReceipt();
    receipt.events.splice(3, 1);
    receipt.status = "completed";
    receipt.postAnswerExecutionObserved = true;
    expect(() => validateResumeReceipt(receipt)).toThrow(
      "including post-answer execution",
    );
  });

  it.each([
    "not-a-date",
    "2026-09-06T00:00:03",
    "2026-02-30T00:00:03.000Z",
    "2026-09-06T00:00:03.000+00:00",
  ])("rejects malformed or noncanonical time %s", (value) => {
    const receipt = testOnlyReceipt();
    receipt.events[3].timestamp = value;
    expect(() => validateResumeReceipt(receipt)).toThrow(
      "unambiguous canonical UTC",
    );
  });

  it.each(["2026-09-06T00:00:01.000Z", "2026-09-06T00:00:02.000Z"])(
    "rejects execution before or simultaneous with owner acceptance",
    (value) => {
      const receipt = testOnlyReceipt();
      receipt.events[3].timestamp = value;
      expect(() => validateResumeReceipt(receipt)).toThrow(
        "strictly increasing timestamps",
      );
    },
  );

  it.each([0, 2, 3, 3.5, "4", Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid or nonincreasing owner sequence %s",
    (value) => {
      const receipt = testOnlyReceipt();
      receipt.events[3].sourceSeq = value;
      expect(() => validateResumeReceipt(receipt)).toThrow("owner sourceSeq");
    },
  );

  it("rejects duplicated evidence even with newly assigned chronology", () => {
    const receipt = testOnlyReceipt();
    receipt.events[3].evidenceRef = receipt.events[2].evidenceRef;
    expect(() => validateResumeReceipt(receipt)).toThrow(
      "duplicate evidenceRef",
    );
  });

  it("rejects substitution of completion for execution", () => {
    const receipt = testOnlyReceipt();
    receipt.events[3].kind = "completed";
    expect(() => validateResumeReceipt(receipt)).toThrow("expected execution");
  });

  it("provides a standalone schema and proof-limit help surface", () => {
    const result = spawnSync(process.execPath, [scriptPath, "--help"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "not authenticity or physical notification delivery",
    );
  });
});
