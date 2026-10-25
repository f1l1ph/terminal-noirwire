import type { NextConfig } from "next";
import { contentSecurityPolicy } from "./src/lib/csp";
import { readEnv } from "./src/lib/envConfig";

/**
 * The terminal's configuration is otherwise only validated when a page first
 * renders, which would let a bad mainnet environment deploy. A build that
 * sets NEXT_PUBLIC_NETWORK at all validates it here, so a near-miss of
 * "mainnet" fails the build too. A build that sets NEXT_PUBLIC_DEPOSITS at
 * all is validated the same way, so a misspelt switch never builds as off.
 * Other builds are untouched.
 */
if (process.env.NEXT_PUBLIC_NETWORK || process.env.NEXT_PUBLIC_DEPOSITS) readEnv();

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // An unset switch is "off" in the bundle too, so the build can drop the transfer code.
  env: { NEXT_PUBLIC_DEPOSITS: process.env.NEXT_PUBLIC_DEPOSITS || "off" },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy() },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
