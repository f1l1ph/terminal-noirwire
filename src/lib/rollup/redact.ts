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
 * `error` itself when nothing in it carries a token. Otherwise a new error
 * with the redacted message and stack and the same name; the original is
 * never mutated (some errors, a DOMException among them, refuse writes to
 * their message). A cause is kept only in its own scrubbed form.
 */
export function scrubError<T>(error: T): T {
  if (!(error instanceof Error)) return error;
  const message = redactToken(error.message);
  const stack = error.stack === undefined ? undefined : redactToken(error.stack);
  const cause = error.cause instanceof Error ? scrubError(error.cause) : undefined;
  if (message === error.message && stack === error.stack && cause === error.cause) return error;
  const clean = new Error(message, cause === undefined ? undefined : { cause });
  clean.name = error.name;
  if (stack !== undefined) clean.stack = stack;
  return clean as T;
}
