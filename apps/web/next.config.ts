import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Shared types live as TypeScript source in the monorepo; let Next compile them.
  transpilePackages: ["@nymbus/shared"],
  reactStrictMode: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
