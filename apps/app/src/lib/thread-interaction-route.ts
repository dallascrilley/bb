import type { PendingInteraction } from "@bb/domain";

export function isActivePendingInteraction(
  interaction: PendingInteraction,
): boolean {
  return interaction.status === "pending" || interaction.status === "resolving";
}

export function selectThreadPendingInteraction(
  interactions: readonly PendingInteraction[] | undefined,
  requestedInteractionId: string | undefined,
  fetchedInteraction: PendingInteraction | undefined,
): PendingInteraction | null {
  if (requestedInteractionId === undefined) {
    if (interactions === undefined || interactions.length === 0) return null;
    return interactions.reduce((latest, interaction) =>
      interaction.createdAt > latest.createdAt ? interaction : latest,
    );
  }

  const listedInteraction = interactions?.find(
    (interaction) => interaction.id === requestedInteractionId,
  );
  if (listedInteraction !== undefined) return listedInteraction;
  if (
    fetchedInteraction !== undefined &&
    fetchedInteraction.id === requestedInteractionId &&
    isActivePendingInteraction(fetchedInteraction)
  ) {
    return fetchedInteraction;
  }
  return null;
}

export function isExpiredPendingInteraction(
  interaction: Pick<
    PendingInteraction,
    "status" | "statusReason" | "expiresAt"
  >,
  now: number,
): boolean {
  if (interaction.status === "resolved" || interaction.status === "resolving") {
    return false;
  }
  if (interaction.status === "interrupted") {
    return (
      interaction.statusReason === "timeout" ||
      (interaction.expiresAt !== undefined &&
        interaction.expiresAt !== null &&
        interaction.expiresAt <= now)
    );
  }
  return (
    interaction.expiresAt !== undefined &&
    interaction.expiresAt !== null &&
    interaction.expiresAt <= now
  );
}
