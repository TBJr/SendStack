import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Ensure instrumentation.ts runs for env validation.
  },
  async rewrites() {
    return [{ source: "/", destination: "/index.html" }];
  },
};

export default nextConfig;
