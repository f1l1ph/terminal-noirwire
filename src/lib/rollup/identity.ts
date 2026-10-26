const IDENTITY_TIMEOUT_MS = 15_000;

/** The rollup behind the pinned URL is not run by the pinned validator, or would not say. Nothing was signed. */
export class RollupIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RollupIdentityError";
  }
}

/**
 * Asks the rollup who runs it (`getIdentity`) and refuses unless it is
 * `expected`. Fails closed: any exception, non-200, RPC error or malformed
 * answer is a refusal. A `text/plain` body needs no CORS preflight, and the
 * endpoint parses it as JSON all the same.
 */
export async function assertRollupIdentity(
  rpcUrl: string,
  expected: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  let identity: unknown;
  try {
    const answer = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIdentity" }),
      cache: "no-store",
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    });
    if (!answer.ok) throw new Error(`answered ${answer.status}`);
    const body = (await answer.json()) as { result?: { identity?: unknown } } | null;
    identity = body?.result?.identity;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "no answer";
    throw new RollupIdentityError(`could not confirm who runs the rollup at ${rpcUrl}: ${reason}`);
  }
  if (typeof identity !== "string") {
    throw new RollupIdentityError(`the rollup at ${rpcUrl} gave no identity`);
  }
  if (identity !== expected) {
    throw new RollupIdentityError(`the rollup at ${rpcUrl} is run by ${identity}, not ${expected}`);
  }
}
