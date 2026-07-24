export type SecurityHeader = {
  key: string;
  value: string;
};

const COMMON_SECURITY_HEADERS: readonly SecurityHeader[] = [
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
];

export function securityHeaders(
  nodeEnv: string | undefined = process.env.NODE_ENV
): SecurityHeader[] {
  const headers = COMMON_SECURITY_HEADERS.map((header) => ({ ...header }));

  if (nodeEnv === "production") {
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=31536000",
    });
  }

  return headers;
}
