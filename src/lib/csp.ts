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
  const rollupUrl = process.env.NEXT_PUBLIC_ROLLUP_RPC_URL ?? "";
  const rollupWsUrl = process.env.NEXT_PUBLIC_ROLLUP_WS_URL ?? "";
  const rollupPrivateUrl = process.env.NEXT_PUBLIC_ROLLUP_PRIVATE_URL ?? "";
  // The SDK's privateConnection() derives the private endpoint's websocket
  // from rollupPrivateUrl itself (same host, ws(s) scheme, port + 1) rather
  // than taking a separate configured URL, so its origin is computed here too
  // (mirrors `websocketUrl` in @noirwire/orderbook/dist/auth.js).
  const rollupPrivateWsUrl = (() => {
    if (!rollupPrivateUrl) return "";
    try {
      const url = new URL(rollupPrivateUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      if (url.port) url.port = String(Number(url.port) + 1);
      return url.origin;
    } catch {
      return "";
    }
  })();
  const connectSources = [
    "'self'",
    simUrl,
    simWsUrl,
    rollupUrl,
    rollupWsUrl,
    rollupPrivateUrl,
    rollupPrivateWsUrl,
  ]
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
