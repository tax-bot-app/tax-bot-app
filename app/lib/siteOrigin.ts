export function validateSiteOrigin(raw: string | undefined, nodeEnv = process.env.NODE_ENV): string {
  if (!raw) {
    throw new Error("Missing env: NEXT_PUBLIC_SITE_URL");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid NEXT_PUBLIC_SITE_URL");
  }

  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Invalid NEXT_PUBLIC_SITE_URL");
  }

  if (nodeEnv === "production" && url.protocol !== "https:") {
    throw new Error("NEXT_PUBLIC_SITE_URL must use https in production");
  }

  return url.origin;
}

export function siteOrigin(): string {
  return validateSiteOrigin(process.env.NEXT_PUBLIC_SITE_URL);
}
