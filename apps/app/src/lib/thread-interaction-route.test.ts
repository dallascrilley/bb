import type { PendingInteraction } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  isExpiredPendingInteraction,
  selectThreadPendingInteraction,
} from "./thread-interaction-route";

interface InteractionOverrides {
  status?: PendingInteraction["status"];
  statusReason?: string | null;
  expiresAt?: number | null;
}

function makeInteraction(
  id: string,
  createdAt: number,
  overrides: InteractionOverrides = {},
): PendingInteraction {
  return {
    id,
    threadId: "thr_route",
    turnId: "turn_route",
    providerId: "codex",
    providerThreadId: "provider_route",
    providerRequestId: `request_${id}`,
    origin: {
      kind: "provider",
      providerId: "codex",
      providerThreadId: "provider_route",
      providerRequestId: `request_${id}`,
    },
    payload: {
      kind: "user_question",
      questions: [
        {
          id: "question_route",
          prompt: "Continue?",
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    },
    resolution: null,
    status: "pending",
    statusReason: null,
    createdAt,
    resolvedAt: null,
    ...overrides,
  };
}

describe("thread interaction route selection", () => {
  it("selects the requested interaction instead of the newest interaction", () => {
    const older = makeInteraction("pint_older", 1);
    const newer = makeInteraction("pint_newer", 2);

    expect(
      selectThreadPendingInteraction([newer, older], older.id, undefined),
    ).toBe(older);
  });

  it("uses the exact fetched interaction when the pending list has changed", () => {
    const requested = makeInteraction("pint_requested", 1);
    const current = makeInteraction("pint_current", 2);

    expect(
      selectThreadPendingInteraction([current], requested.id, requested),
    ).toBe(requested);
  });

  it("does not substitute another interaction for a missing target", () => {
    const current = makeInteraction("pint_current", 2);

    expect(
      selectThreadPendingInteraction([current], "pint_missing", undefined),
    ).toBeNull();
  });

  it("recognizes timed-out and elapsed interactions without treating resolving as expired", () => {
    expect(
      isExpiredPendingInteraction(
        makeInteraction("pint_timeout", 1, {
          status: "interrupted",
          statusReason: "timeout",
        }),
        2,
      ),
    ).toBe(true);
    expect(
      isExpiredPendingInteraction(
        makeInteraction("pint_elapsed", 1, { expiresAt: 2_000 }),
        2_000,
      ),
    ).toBe(true);
    expect(
      isExpiredPendingInteraction(
        makeInteraction("pint_resolving", 1, {
          status: "resolving",
          expiresAt: 1,
        }),
        2,
      ),
    ).toBe(false);
  });
});
