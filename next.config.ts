import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    '/privacy': ['./content/legal/privacy.md'],
  },
};


export default nextConfig;
