// app/lib/metaPixel.ts
"use client";

declare global {
  interface Window {
    fbq?: (...args: any[]) => void;
  }
}

export const META_PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID;

export function hasMetaPixel() {
  return typeof window !== "undefined" && !!META_PIXEL_ID && typeof window.fbq === "function";
}

export function pageView() {
  if (!hasMetaPixel()) return;
  window.fbq!("track", "PageView");
}

export function trackMeta(eventName: string, params?: Record<string, unknown>) {
  if (!hasMetaPixel()) return;
  if (params && Object.keys(params).length > 0) {
    window.fbq!("track", eventName, params);
    return;
  }
  window.fbq!("track", eventName);
}

// 無料体験送信完了時
export function trackDemoStart() {
  // Meta標準イベントに完全一致はないので Custom Event で十分
  trackMeta("DemoStart");
}

// プラン表示時
export function trackPlanView(plan?: string) {
  trackMeta("PlanView", plan ? { plan } : undefined);
}

// Checkout遷移時
export function trackInitiateCheckout(plan?: string, value?: number, currency = "JPY") {
  const params: Record<string, unknown> = { currency };
  if (plan) params.plan = plan;
  if (typeof value === "number") params.value = value;
  trackMeta("InitiateCheckout", params);
}

// 購入完了時
export function trackPurchase(opts?: {
  value?: number;
  currency?: string;
  plan?: string;
  transaction_id?: string;
}) {
  const params: Record<string, unknown> = {
    currency: opts?.currency ?? "JPY",
  };
  if (typeof opts?.value === "number") params.value = opts.value;
  if (opts?.plan) params.plan = opts.plan;
  if (opts?.transaction_id) params.transaction_id = opts.transaction_id;

  trackMeta("Purchase", params);
}