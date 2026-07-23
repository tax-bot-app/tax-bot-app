import { describe, expect, it, vi } from "vitest";
import { completeDemoAttempt } from "./demoAttemptLifecycle";

describe("completeDemoAttempt", () => {
  it("keeps the reservation after a successful answer", async () => {
    const releaseReservation = vi.fn(async () => undefined);

    const result = await completeDemoAttempt({
      generate: async () => ({ answer: "回答" }),
      normalizeAnswer: (generated) => generated.answer,
      releaseReservation,
    });

    expect(result).toEqual({ kind: "success", answer: "回答" });
    expect(releaseReservation).not.toHaveBeenCalled();
  });

  it("releases the reservation after an empty answer", async () => {
    const releaseReservation = vi.fn(async () => undefined);

    const result = await completeDemoAttempt({
      generate: async () => ({ answer: "" }),
      normalizeAnswer: (generated) => generated.answer.trim(),
      releaseReservation,
    });

    expect(result).toEqual({ kind: "empty" });
    expect(releaseReservation).toHaveBeenCalledOnce();
  });

  it("releases the reservation after an abort", async () => {
    const releaseReservation = vi.fn(async () => undefined);
    const abortError = new DOMException("DEMO_TIMEOUT", "AbortError");

    const result = await completeDemoAttempt({
      generate: async () => {
        throw abortError;
      },
      normalizeAnswer: () => "",
      releaseReservation,
    });

    expect(result).toEqual({ kind: "error", error: abortError });
    expect(releaseReservation).toHaveBeenCalledOnce();
  });

  it("releases the reservation after an unexpected generation error", async () => {
    const releaseReservation = vi.fn(async () => undefined);
    const generationError = new Error("OpenAI failed");

    const result = await completeDemoAttempt({
      generate: async () => {
        throw generationError;
      },
      normalizeAnswer: () => "",
      releaseReservation,
    });

    expect(result).toEqual({ kind: "error", error: generationError });
    expect(releaseReservation).toHaveBeenCalledOnce();
  });
});
