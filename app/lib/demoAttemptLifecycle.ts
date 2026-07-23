export type DemoAttemptResult =
  | { kind: "success"; answer: string }
  | { kind: "empty" }
  | { kind: "error"; error: unknown };

type DemoAttemptParams<T> = {
  generate: () => Promise<T>;
  normalizeAnswer: (generated: T) => string;
  releaseReservation: () => Promise<void>;
};

export async function completeDemoAttempt<T>({
  generate,
  normalizeAnswer,
  releaseReservation,
}: DemoAttemptParams<T>): Promise<DemoAttemptResult> {
  try {
    const generated = await generate();
    const answer = normalizeAnswer(generated);

    if (!answer) {
      await releaseReservation();
      return { kind: "empty" };
    }

    return { kind: "success", answer };
  } catch (error: unknown) {
    await releaseReservation();
    return { kind: "error", error };
  }
}
