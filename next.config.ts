import type { NextConfig } from "next";

import { securityHeaders } from "./app/lib/securityHeaders";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders(),
      },
    ];
  },
};

export default nextConfig;
