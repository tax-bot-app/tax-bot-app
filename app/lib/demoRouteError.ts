export type DemoRouteErrorKind = "generation" | "timeout" | "unexpected";

const PUBLIC_MESSAGES: Record<DemoRouteErrorKind, string> = {
  generation:
    "回答を作成できませんでした。時間をおいて、もう一度お試しください。",
  timeout:
    "混み合っています。少し時間をおいて、もう一度お試しください。",
  unexpected:
    "処理を完了できませんでした。時間をおいて、もう一度お試しください。",
};

export function demoRouteErrorMessage(kind: DemoRouteErrorKind): string {
  return PUBLIC_MESSAGES[kind];
}

export function demoRouteErrorDiagnostic(
  error: unknown
): Record<string, string | number> {
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

export function isDemoTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const source = error as Record<string, unknown>;
  const name = typeof source.name === "string" ? source.name : "";
  const message = typeof source.message === "string" ? source.message : "";
  const cause = typeof source.cause === "string" ? source.cause : "";

  return (
    name === "AbortError" ||
    /aborted/i.test(message) ||
    message.includes("DEMO_TIMEOUT") ||
    cause.includes("DEMO_TIMEOUT")
  );
}
