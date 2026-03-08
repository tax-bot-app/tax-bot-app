export type FeedbackKind = "report_answer" | "contact" | "request";
export type FeedbackRole = "user" | "assistant";

export type FeedbackContextMessage = {
  id: string;
  role: FeedbackRole;
  content: string;
  created_at: string;
};

export type FeedbackDraft = {
  kind: FeedbackKind;
  conversation_id: string | null;
  message_id: string | null;
  target_answer: string | null;
  context_messages: FeedbackContextMessage[];
  page_path: string;
  dialect?: string | null;
  stance?: string | null;
  appVersion?: string | null;
};

export const FEEDBACK_DRAFT_KEY = "feedback:draft:v1";
export const FEEDBACK_COOLDOWN_KEY = "feedback_last_sent_at";
export const FEEDBACK_COOLDOWN_MS = 60_000;

export function saveFeedbackDraft(draft: FeedbackDraft) {
  try {
    sessionStorage.setItem(FEEDBACK_DRAFT_KEY, JSON.stringify(draft));
  } catch {}
}

export function loadFeedbackDraft(): FeedbackDraft | null {
  try {
    const raw = sessionStorage.getItem(FEEDBACK_DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as FeedbackDraft;
  } catch {
    return null;
  }
}

export function clearFeedbackDraft() {
  try {
    sessionStorage.removeItem(FEEDBACK_DRAFT_KEY);
  } catch {}
}

export function readFeedbackCooldownLeftMs(now = Date.now()): number {
  try {
    const raw = localStorage.getItem(FEEDBACK_COOLDOWN_KEY);
    if (!raw) return 0;
    const last = Number(raw);
    if (!Number.isFinite(last) || last <= 0) return 0;
    return Math.max(0, FEEDBACK_COOLDOWN_MS - (now - last));
  } catch {
    return 0;
  }
}

export function writeFeedbackCooldown(now = Date.now()) {
  try {
    localStorage.setItem(FEEDBACK_COOLDOWN_KEY, String(now));
  } catch {}
}

export function normalizeFeedbackKind(raw?: string | null): FeedbackKind {
  if (raw === "report_answer") return "report_answer";
  if (raw === "request") return "request";
  return "contact";
}