import FeedbackNewClient from "./FeedbackNewClient";
import { normalizeFeedbackKind, type FeedbackKind } from "@/app/lib/feedbackDraft";

export default async function FeedbackNewPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const params = await searchParams;
  const initialKind: FeedbackKind = normalizeFeedbackKind(params?.kind);

  return <FeedbackNewClient initialKind={initialKind} />;
}