import { redactToken } from "./rollup/redact";
import { isWalletDecline } from "./wallet/declined";

export interface UserMessage {
  /** Plain words for the trader: what happened, and what to do next. */
  text: string;
  /** A short line for a support request, set only when the text is the catch-all. Never carries keys, signatures, addresses or URLs. */
  detail: string | null;
  /** False when the text is the catch-all, so a caller with a better lead sentence of its own can use that instead. */
  known: boolean;
}

interface Options {
  /** True when the failing step runs before anything is signed or sent, so the line can say nothing was sent. */
  nothingSent?: boolean;
}

const MAX_DETAIL_LENGTH = 120;
const RATE_LIMITED = /\b429\b|too many requests|rate.?limit/i;
const ROLLUP_UNREADABLE = /the exchange account is not readable here/i;
const JSON_BODY = /[{[]\s*"/;
const JSON_ERROR_CODE = /"code"\s*:\s*(-?\d+)/;
const UNREACHABLE_NAMES = new Set(["SessionAuthError", "RollupIdentityError", "AbortError"]);
const UNREACHABLE_TEXT =
  /failed to fetch|networkerror|network request failed|load failed|timed? ?out/i;
const MARKET_NOT_ON_CHAIN = /was not found on chain/i;
/** Messages this app wrote as a sentence for the trader, which already say that nothing happened. */
const WRITTEN_FOR_TRADER = /\bnot sent\b|nothing was (?:sent|signed)|nothing moved/i;
const URL = /\bhttps?:\/\/\S+/g;
const LONG_TOKEN = /[A-Za-z0-9_-]{32,}/g;

const DECLINED_TEXT = "You declined the request in your wallet.";
const NETWORK_TEXT =
  "The terminal could not confirm that your wallet is on the right network, so nothing was signed. Reload the page and try again.";
const STALE_SIGNER_TEXT =
  "Your wallet account changed while it was signing. Nothing was sent with the old account.";
export const SESSION_REFUSED_TEXT =
  "The exchange stopped accepting your sign-in. Sign in again to continue.";
const BUSY_TEXT = "The network is busy. Nothing was sent. Try again in a moment.";
const ROLLUP_UNREADABLE_TEXT =
  "The exchange cannot be reached right now. Nothing was sent. Try again in a moment.";
const UNREACHABLE_TEXT_LINE =
  "Could not reach the exchange. Check your connection and try again in a moment.";
const MARKET_TEXT =
  "This market is not available on the exchange right now. Try another market, or try again later.";
const CATCH_ALL_TEXT =
  "Something went wrong. Try again in a moment, and if it keeps happening contact support.";

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

/** Text with any JSON body cut off and replaced by the body's error code, so raw JSON never reaches a support line. */
function withoutJson(text: string): string {
  const at = text.search(JSON_BODY);
  if (at < 0) return text;
  const code = JSON_ERROR_CODE.exec(text)?.[1];
  return `${text.slice(0, at).trim()} ${code ? `(code ${code})` : "(error body)"}`.trim();
}

function sanitized(text: string): string {
  const line = redactToken(withoutJson(text).split("\n")[0])
    .replace(URL, "[address]")
    .replace(LONG_TOKEN, "[key]")
    .trim();
  return line.length > MAX_DETAIL_LENGTH ? `${line.slice(0, MAX_DETAIL_LENGTH)}...` : line;
}

function withNothingSent(text: string, { nothingSent = false }: Options): string {
  return nothingSent && !/nothing was (?:sent|signed)/i.test(text)
    ? `${text} Nothing was sent.`
    : text;
}

/**
 * Safe copy for anything that was thrown on the way to the screen. A decline
 * in the wallet, a failed network check, an unreachable service and a market
 * missing on chain each get their own sentence. A message this app wrote for
 * the trader is kept once it is cleaned of addresses and tokens; everything
 * else becomes the catch-all with a short cleaned `detail` to quote to support.
 */
export function userMessage(error: unknown, options: Options = {}): UserMessage {
  const message = messageOf(error);
  const name = nameOf(error);
  const say = (text: string): UserMessage => ({
    text: withNothingSent(text, options),
    detail: null,
    known: true,
  });
  if (name === "StaleSigner") return say(STALE_SIGNER_TEXT);
  if (name === "SessionRefused") return say(SESSION_REFUSED_TEXT);
  if (name === "NetworkRefused") return say(NETWORK_TEXT);
  if (isWalletDecline(error)) return say(DECLINED_TEXT);
  if (RATE_LIMITED.test(message)) return say(BUSY_TEXT);
  if (ROLLUP_UNREADABLE.test(message)) return say(ROLLUP_UNREADABLE_TEXT);
  if (UNREACHABLE_NAMES.has(name) || UNREACHABLE_TEXT.test(message)) {
    return say(UNREACHABLE_TEXT_LINE);
  }
  if (MARKET_NOT_ON_CHAIN.test(message)) return say(MARKET_TEXT);
  if (WRITTEN_FOR_TRADER.test(message)) {
    const line = sanitized(message);
    if (!line.includes("[")) return { text: line, detail: null, known: true };
  }
  const detail = sanitized(message);
  return { text: withNothingSent(CATCH_ALL_TEXT, options), detail: detail || null, known: false };
}

/** `userMessage` as one line, with the support detail after the sentence when there is one. */
export function userMessageLine(error: unknown, options: Options = {}): string {
  const { text, detail } = userMessage(error, options);
  return detail ? `${text} Support detail: ${detail}` : text;
}
