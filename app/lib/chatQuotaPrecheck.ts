export type ChatQuotaPrecheckResult =
  | { kind: "allowed" }
  | { kind: "exceeded"; usedTalks: number }
  | { kind: "error"; message: string };

type ChatQuotaPrecheckParams = {
  limit: number;
  loadIsUnlimited: () => Promise<boolean>;
  loadUsedTalks: () => Promise<number>;
};

export async function precheckChatQuota({
  limit,
  loadIsUnlimited,
  loadUsedTalks,
}: ChatQuotaPrecheckParams): Promise<ChatQuotaPrecheckResult> {
  try {
    if (await loadIsUnlimited()) return { kind: "allowed" };

    const loaded = await loadUsedTalks();
    const usedTalks = Number.isFinite(loaded) ? Math.max(0, loaded) : 0;

    return usedTalks >= limit
      ? { kind: "exceeded", usedTalks }
      : { kind: "allowed" };
  } catch (error: unknown) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
