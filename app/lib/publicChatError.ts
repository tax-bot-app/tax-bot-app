export type PublicChatErrorKind =
  | "status"
  | "quota"
  | "generation"
  | "usage"
  | "unexpected";

const PUBLIC_MESSAGES: Record<PublicChatErrorKind, string> = {
  status: "利用状況を確認できませんでした。時間をおいて、もう一度お試しください。",
  quota: "残り回数を確認できませんでした。時間をおいて、もう一度お試しください。",
  generation: "回答を作成できませんでした。時間をおいて、もう一度お試しください。",
  usage: "利用回数を更新できませんでした。時間をおいて、もう一度お試しください。",
  unexpected: "処理を完了できませんでした。時間をおいて、もう一度お試しください。",
};

export function publicChatErrorMessage(kind: PublicChatErrorKind): string {
  return PUBLIC_MESSAGES[kind];
}

export function publicChatErrorDiagnostic(error: unknown): Record<string, string | number> {
  if (!error || typeof error !== "object") {
    return { type: typeof error };
  }

  const source = error as Record<string, unknown>;
  const diagnostic: Record<string, string | number> = {};

  for (const key of ["name", "code", "type", "status", "request_id"]) {
    const value = source[key];
    if (typeof value === "string" && value) diagnostic[key] = value.slice(0, 120);
    if (typeof value === "number" && Number.isFinite(value)) diagnostic[key] = value;
  }

  return Object.keys(diagnostic).length > 0 ? diagnostic : { type: "object" };
}
