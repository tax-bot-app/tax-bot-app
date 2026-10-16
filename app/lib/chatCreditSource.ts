export type ChatCreditSource = "monthly" | "single" | "none";

export function chooseChatCreditSource(params: {
  monthlyAvailable: boolean;
  singleCredits: number;
}): ChatCreditSource {
  if (params.monthlyAvailable) return "monthly";
  if (Number.isFinite(params.singleCredits) && params.singleCredits > 0) {
    return "single";
  }
  return "none";
}
