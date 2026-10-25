const MIN_TOKEN_LENGTH = 8;
const REDACTED = "[redacted]";

/** Credentials a URL carries in its query string: the rollup sign-in token, or a provider key on an RPC URL. */
const URL_CREDENTIAL = /([?&](?:token|api[-_]?key)=)[^&\s"'<>)\]]+/gi;

/** Sign-in tokens held in this page right now, replaced wherever they turn up as plain text. */
const known = new Set<string>();

/** Registers a token so `redactToken` removes it even when it appears outside a URL. */
export function rememberToken(token: string): void {
  if (token.length >= MIN_TOKEN_LENGTH) known.add(token);
}

export function forgetToken(token: string): void {
  known.delete(token);
}

/**
 * `text` with every sign-in token and URL credential replaced. Every place a
 * rollup URL or an error becomes text (a message, a log line, a state shown
 * to the trader) goes through this: the token is a bearer credential for
 * private reads and must never be readable from an error.
 */
export function redactToken(text: string): string {
  let redacted = text.replace(URL_CREDENTIAL, `$1${REDACTED}`);
  for (const token of known) redacted = redacted.split(token).join(REDACTED);
  return redacted;
}

/**
 * Rewrites the message, stack and cause of `error` in place and returns it,
 * so its class (and every `instanceof` check on it) survives while its text
 * no longer carries a token.
 */
export function scrubError<T>(error: T): T {
  if (!(error instanceof Error)) return error;
  error.message = redactToken(error.message);
  if (error.stack) error.stack = redactToken(error.stack);
  if (error.cause instanceof Error) scrubError(error.cause);
  return error;
}
