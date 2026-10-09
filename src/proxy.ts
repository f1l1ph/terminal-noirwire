import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy } from "@/lib/csp";

/**
 * Gives every page its own script nonce. The policy goes on the request,
 * where Next.js reads the nonce for its inline bootstrap scripts, and on the
 * response, where it replaces the nonce-less policy next.config.ts sets for
 * everything else. Only one policy reaches the browser.
 */
export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const policy = contentSecurityPolicy(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Static files execute no script and keep the static policy.
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
