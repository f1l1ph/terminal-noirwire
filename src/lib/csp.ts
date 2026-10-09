/**
 * For anything that is not a page: static files. Loads and runs nothing.
 * `src/proxy.ts` sets the real, nonced policy on every page response; this
 * one only ever reaches a request the proxy's matcher excludes.
 */
const NO_DOCUMENT_POLICY = "default-src 'none'; frame-ancestors 'none'";

/**
 * `connect-src` is the simulation service's own HTTP and websocket origins
 * (read directly from the environment, not the validated schema in
 * `src/lib/env`, so a malformed URL still produces a restrictive policy
 * rather than crashing config evaluation before Next.js can report the real
 * error) and nothing else: the page reaches no other host. Inline scripts
 * run only with the request's nonce: Next.js reads it from this header and
 * puts it on its own bootstrap scripts, and `strict-dynamic` lets those load
 * the page's bundles.
 */
export function contentSecurityPolicy(nonce?: string): string {
  if (!nonce) return NO_DOCUMENT_POLICY;
  const simUrl = process.env.NEXT_PUBLIC_SIM_URL ?? "";
  const simWsUrl = process.env.NEXT_PUBLIC_SIM_WS_URL ?? "";
  // Rollup mode reads its own URLs from sim-noirwire's `/v1/deployment` at
  // runtime (src/lib/rollup/deployment.ts), which a static response header
  // cannot know in advance; these two env vars are the override the
  // README asks an operator to set to the same addresses specifically so
  // CSP can allow them (dev mode's blanket `ws://localhost:*` below covers
  // a local websocket but never an HTTP connect-src).
  const rollupUrl = process.env.NEXT_PUBLIC_ROLLUP_RPC_URL ?? "";
  const rollupWsUrl = process.env.NEXT_PUBLIC_ROLLUP_WS_URL ?? "";
  const connectSources = ["'self'", simUrl, simWsUrl, rollupUrl, rollupWsUrl]
    .filter(Boolean)
    .join(" ");
  const isDev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${connectSources}${isDev ? " ws://localhost:*" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}
