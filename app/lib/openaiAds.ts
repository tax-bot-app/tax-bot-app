type OpenAIAdsEvent =
  | ["lead_created", { type: "customer_action" }]
  | ["checkout_started", { type: "contents" }]
  | ["subscription_created", { type: "plan_enrollment" }];

declare global {
  interface Window {
    oaiq?: (command: "measure", event: string, payload: unknown) => void;
  }
}

const LEAD_CREATED_KEY = "sajikagen_openai_ads_lead_created";
const SUBSCRIPTION_CREATED_PREFIX =
  "sajikagen_openai_ads_subscription_created:";
const measuredThisPage = new Set<string>();

function measure([event, payload]: OpenAIAdsEvent): boolean {
  if (typeof window === "undefined" || typeof window.oaiq !== "function") {
    return false;
  }

  try {
    window.oaiq("measure", event, payload);
    return true;
  } catch {
    return false;
  }
}

function wasStored(key: string): boolean {
  if (measuredThisPage.has(key)) return true;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function store(key: string): void {
  measuredThisPage.add(key);
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // 計測用ストレージが使えなくても、本体の動作は止めない。
  }
}

export function trackOpenAILeadCreatedOnce(): void {
  if (wasStored(LEAD_CREATED_KEY)) return;
  if (measure(["lead_created", { type: "customer_action" }])) {
    store(LEAD_CREATED_KEY);
  }
}

export function trackOpenAICheckoutStarted(): void {
  measure(["checkout_started", { type: "contents" }]);
}

export function trackOpenAISubscriptionCreatedOnce(
  conversionId: string
): boolean {
  if (!conversionId) return false;
  const key = `${SUBSCRIPTION_CREATED_PREFIX}${conversionId}`;
  if (wasStored(key)) return true;
  if (!measure(["subscription_created", { type: "plan_enrollment" }])) {
    return false;
  }
  store(key);
  return true;
}
