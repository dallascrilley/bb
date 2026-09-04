import { randomUUID } from "node:crypto";
import {
  getEnvironment,
  getPendingInteraction,
  listActivePendingInteractions,
  listLiveThreadsWithHost,
  type DbConnection,
} from "@bb/db";
import { buildPendingInteractionApprovalResolution } from "@bb/core-ui";
import {
  CockpitControlError,
  cockpitReceiptSchema,
  createCockpitControl,
  isApprovalPendingInteraction,
  isApprovalPendingInteractionPayload,
  isUserQuestionPendingInteractionPayload,
  pendingInteractionPayloadSchema,
  type CockpitControl,
  type CockpitAttentionKind,
  type CockpitInventory,
  type CockpitReceipt,
  type CockpitReceiptStore,
  type CockpitSessionStatus,
  type PendingInteractionApprovalDecision,
  type ThreadStatus,
} from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { toPendingInteraction } from "../interactions/pending-interaction-serialization.js";
import { requirePublicThread } from "../lib/entity-lookup.js";
import { stopThreadForCurrentState } from "../threads/thread-lifecycle.js";
import { resolveThreadHostCommandEnvironment } from "../threads/thread-command-environment.js";
import { acceptThreadSendRequest } from "../threads/thread-send-request.js";

function toSessionStatus(status: ThreadStatus): CockpitSessionStatus | null {
  switch (status) {
    case "starting":
    case "active":
    case "stopping":
      return "running";
    case "idle":
      return "paused";
    case "error":
      return "error";
    case "pending":
      return null;
  }
}

function requireCockpitThread(deps: AppDeps, sessionId: string) {
  try {
    return requirePublicThread(deps.db, sessionId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new CockpitControlError(
        "expired",
        "Session is no longer available for cockpit-control",
      );
    }
    throw error;
  }
}

function pickApprovalDecision(
  available: readonly PendingInteractionApprovalDecision[],
  action: "approve" | "deny",
): PendingInteractionApprovalDecision {
  if (action === "deny") {
    if (available.includes("deny")) {
      return "deny";
    }
    throw new CockpitControlError(
      "unsupported",
      "Attention item does not offer deny",
    );
  }
  if (available.includes("allow_once")) {
    return "allow_once";
  }
  if (available.includes("allow_for_session")) {
    return "allow_for_session";
  }
  throw new CockpitControlError(
    "unsupported",
    "Attention item does not offer approve",
  );
}

export function createSqliteCockpitReceiptStore(
  db: DbConnection,
): CockpitReceiptStore {
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS cockpit_control_receipts (
      idempotency_key TEXT PRIMARY KEY,
      receipt_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  const select = db.$client.prepare(
    `SELECT receipt_json FROM cockpit_control_receipts WHERE idempotency_key = ?`,
  );
  const upsert = db.$client.prepare(
    `INSERT OR REPLACE INTO cockpit_control_receipts (
      idempotency_key, receipt_json, created_at
    ) VALUES (?, ?, ?)`,
  );
  return {
    get(idempotencyKey) {
      const row = select.get(idempotencyKey);
      if (row === undefined || row === null || typeof row !== "object") {
        return null;
      }
      const json =
        "receipt_json" in row && typeof row.receipt_json === "string"
          ? row.receipt_json
          : null;
      if (json === null) {
        return null;
      }
      try {
        return cockpitReceiptSchema.parse(JSON.parse(json));
      } catch {
        throw new CockpitControlError(
          "invalid_request",
          "Stored cockpit-control receipt is invalid",
        );
      }
    },
    put(idempotencyKey, receipt: CockpitReceipt) {
      upsert.run(idempotencyKey, JSON.stringify(receipt), receipt.createdAt);
    },
  };
}

function listInventory(deps: AppDeps): CockpitInventory {
  const sessions = listLiveThreadsWithHost(deps.db).flatMap((row) => {
    if (row.hostId === null) {
      return [];
    }
    const status = toSessionStatus(row.thread.status);
    if (status === null) {
      return [];
    }
    return [
      {
        id: row.thread.id,
        hostId: row.hostId,
        displayName: row.thread.title ?? row.thread.titleFallback ?? row.thread.id,
        providerId: row.thread.providerId,
        status,
      },
    ];
  });
  const sessionById = new Map(
    sessions.map((session) => [session.id, session]),
  );
  const attentionItems = listActivePendingInteractions(deps.db).flatMap(
    (row) => {
      const thread = sessionById.get(row.threadId);
      if (thread === undefined) {
        return [];
      }
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload) as unknown;
      } catch {
        return [];
      }
      const parsed = pendingInteractionPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        return [];
      }
      const attentionKind: CockpitAttentionKind | null =
        isApprovalPendingInteractionPayload(parsed.data)
          ? "approval"
          : isUserQuestionPendingInteractionPayload(parsed.data)
            ? "question"
            : null;
      if (attentionKind === null) {
        return [];
      }
      return [
        {
          id: row.id,
          sessionId: row.threadId,
          hostId: thread.hostId,
          attentionKind,
          expiresAt: row.expiresAt,
        },
      ];
    },
  );
  return { sessions, attentionItems };
}

export function createServerCockpitControl(deps: AppDeps): CockpitControl {
  const receipts = createSqliteCockpitReceiptStore(deps.db);
  return createCockpitControl({
    now: () => Date.now(),
    createReceiptId: () => randomUUID(),
    receipts,
    listInventory: () => listInventory(deps),
    async pause(sessionId) {
      const thread = requireCockpitThread(deps, sessionId);
      const environment = resolveThreadHostCommandEnvironment({
        db: deps.db,
        thread,
      });
      await stopThreadForCurrentState(deps, thread, environment);
    },
    async resume(sessionId) {
      requireCockpitThread(deps, sessionId);
    },
    async steer(sessionId, message) {
      const thread = requireCockpitThread(deps, sessionId);
      const environment = thread.environmentId
        ? getEnvironment(deps.db, thread.environmentId)
        : null;
      if (environment === null) {
        throw new CockpitControlError(
          "expired",
          "Session has no execution environment",
        );
      }
      await acceptThreadSendRequest(deps, {
        thread,
        payload: {
          input: [{ type: "text", text: message, mentions: [] }],
          mode: "steer-if-active",
        },
      });
    },
    async takeOver(sessionId) {
      const thread = requireCockpitThread(deps, sessionId);
      const environment = resolveThreadHostCommandEnvironment({
        db: deps.db,
        thread,
      });
      await stopThreadForCurrentState(deps, thread, environment);
    },
    async approve(attentionId) {
      const row = getPendingInteraction(deps.db, attentionId);
      if (row === null) {
        throw new CockpitControlError(
          "expired",
          "Attention item is no longer available for cockpit-control",
        );
      }
      const interaction = toPendingInteraction(row);
      if (!isApprovalPendingInteraction(interaction)) {
        throw new CockpitControlError(
          "unsupported",
          "Attention item does not support approve",
        );
      }
      const decision = pickApprovalDecision(
        interaction.payload.availableDecisions,
        "approve",
      );
      deps.pendingInteractions.resolvePendingInteraction({
        threadId: interaction.threadId,
        interactionId: interaction.id,
        resolution: buildPendingInteractionApprovalResolution(
          interaction,
          decision,
        ),
      });
    },
    async deny(attentionId) {
      const row = getPendingInteraction(deps.db, attentionId);
      if (row === null) {
        throw new CockpitControlError(
          "expired",
          "Attention item is no longer available for cockpit-control",
        );
      }
      const interaction = toPendingInteraction(row);
      if (!isApprovalPendingInteraction(interaction)) {
        throw new CockpitControlError(
          "unsupported",
          "Attention item does not support deny",
        );
      }
      const decision = pickApprovalDecision(
        interaction.payload.availableDecisions,
        "deny",
      );
      deps.pendingInteractions.resolvePendingInteraction({
        threadId: interaction.threadId,
        interactionId: interaction.id,
        resolution: buildPendingInteractionApprovalResolution(
          interaction,
          decision,
        ),
      });
    },
    async answer(attentionId, answers) {
      const row = getPendingInteraction(deps.db, attentionId);
      if (row === null) {
        throw new CockpitControlError(
          "expired",
          "Attention item is no longer available for cockpit-control",
        );
      }
      const interaction = toPendingInteraction(row);
      if (!isUserQuestionPendingInteractionPayload(interaction.payload)) {
        throw new CockpitControlError(
          "unsupported",
          "Attention item does not support answer",
        );
      }
      deps.pendingInteractions.resolvePendingInteraction({
        threadId: interaction.threadId,
        interactionId: interaction.id,
        resolution: {
          kind: "user_answer",
          answers,
        },
      });
    },
  });
}
