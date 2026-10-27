import { afterEach, describe, expect, it } from "vitest";
import { forgetToken, rememberToken } from "@/lib/rollup/redact";
import { userMessage, userMessageLine } from "@/lib/userMessage";

const named = (name: string, message: string) => Object.assign(new Error(message), { name });
const KEY = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const TOKEN = "tok_0123456789abcdef0123456789abcdef";

afterEach(() => forgetToken(TOKEN));

describe("userMessage", () => {
  it("reads a decline in the wallet as one, by code or by wording", () => {
    const byCode = Object.assign(new Error("x"), { code: 4001 });
    expect(userMessage(byCode).text).toBe("You declined the request in your wallet.");
    expect(userMessage(new Error("User rejected the request.")).known).toBe(true);
  });

  it("says nothing was sent when the caller knows it", () => {
    expect(userMessage(new Error("User rejected the request."), { nothingSent: true }).text).toBe(
      "You declined the request in your wallet. Nothing was sent.",
    );
  });

  it("turns a failed network check into one sentence without the genesis hashes", () => {
    const refused = named(
      "NetworkRefused",
      `the Solana RPC now answers with genesis ${KEY}, not ${KEY}. Nothing was signed.`,
    );
    const { text, detail } = userMessage(refused);
    expect(text).toMatch(/right network, so nothing was signed/);
    expect(text).not.toContain(KEY);
    expect(detail).toBeNull();
  });

  it("turns an unreachable rollup into a connection line without the address", () => {
    const identity = named(
      "RollupIdentityError",
      "could not confirm who runs the rollup at https://mainnet-tee.example.app: answered 503",
    );
    const { text } = userMessage(identity, { nothingSent: true });
    expect(text).toBe(
      "Could not reach the exchange. Check your connection and try again in a moment. Nothing was sent.",
    );
    expect(text).not.toMatch(/https|503/);
  });

  it("turns a failed sign-in and a failed fetch into the same connection line", () => {
    expect(userMessage(named("SessionAuthError", "boom")).text).toMatch(/Could not reach/);
    expect(userMessage(new TypeError("Failed to fetch")).text).toMatch(/Could not reach/);
  });

  it("turns a market missing on chain into a plain sentence", () => {
    expect(userMessage(new Error("NSOL-PERP was not found on chain")).text).toBe(
      "This market is not available on the exchange right now. Try another market, or try again later.",
    );
  });

  it("keeps a message this app wrote for the trader", () => {
    const written = "Could not record this order on this device first, so it was not sent.";
    expect(userMessage(new Error(written))).toEqual({ text: written, detail: null, known: true });
  });

  it("does not keep a written message that carries an address or a long token", () => {
    const leaky = `The order was not sent to https://rollup.example/?token=${TOKEN}.`;
    expect(userMessage(new Error(leaky)).known).toBe(false);
  });

  it("falls back to the catch-all with a short cleaned detail for anything else", () => {
    const { text, detail, known } = userMessage(
      new Error(
        `Boom at https://rpc.example/?api-key=abc123 with ${KEY} for ${TOKEN}\n at x (y.js)`,
      ),
    );
    expect(known).toBe(false);
    expect(text).toBe(
      "Something went wrong. Try again in a moment, and if it keeps happening contact support.",
    );
    expect(detail).toBe("Boom at [address] with [key] for [key]");
  });

  it("removes a remembered sign-in token from the detail", () => {
    rememberToken(TOKEN);
    expect(userMessage(new Error(`failed for ${TOKEN}.`)).detail).not.toContain(TOKEN);
  });

  it("caps the detail's length", () => {
    const detail = userMessage(new Error("word ".repeat(100))).detail ?? "";
    expect(detail.length).toBeLessThanOrEqual(123);
    expect(detail.endsWith("...")).toBe(true);
  });

  it("copes with a thrown value that is not an error", () => {
    expect(userMessage("plain text").detail).toBe("plain text");
    expect(userMessage(undefined)).toEqual({
      text: "Something went wrong. Try again in a moment, and if it keeps happening contact support.",
      detail: null,
      known: false,
    });
  });

  it("never shows a program error label or a status number as copy", () => {
    const { text } = userMessage(new Error("program error 6123"));
    expect(text).not.toMatch(/6123|program error/);
  });
});

describe("userMessage wallet declines", () => {
  const DECLINED = "You declined the request in your wallet.";

  it.each([
    ["a 4001 code", Object.assign(new Error("x"), { code: 4001 })],
    ["a plain code object", { code: 4001 }],
    ["the wallet's wording", new Error("User rejected the request.")],
    [
      "a wallet adapter class with a rejection",
      named("WalletSignTransactionError", "User rejected the request."),
    ],
    ["a window the owner closed", named("WalletWindowClosedError", "x")],
    [
      "a decline wrapped as a cause",
      Object.assign(new Error("sign-in failed"), { cause: { code: 4001 } }),
    ],
  ])("reads %s as a decline", (_label, error) => {
    expect(userMessage(error).text).toBe(DECLINED);
  });

  it.each([
    ["no wallet to cancel", new Error("No wallet to cancel for")],
    ["a cancel that is not available", new Error("Per-order cancel is not available")],
    ["a refusing signature", new Error("Refusing to sign: the message is not the expected one")],
    [
      "a deployment check",
      new Error("https://book.example/v1/deployment refused: the pins do not match"),
    ],
    ["a wallet signing failure", named("WalletSignTransactionError", "Unexpected error")],
    ["a refused network check", named("NetworkRefused", "the network was refused")],
    ["a refused signed transaction", named("SignedTransactionRefused", "refused to sign")],
  ])("does not read %s as a decline", (_label, error) => {
    expect(userMessage(error).text).not.toBe(DECLINED);
  });

  it("gives an account switched mid-signing its own sentence", () => {
    expect(
      userMessage(named("StaleSigner", "the wallet account changed while it was signing")),
    ).toEqual({
      text: "Your wallet account changed while it was signing. Nothing was sent with the old account.",
      detail: null,
      known: true,
    });
  });
});

describe("userMessage busy network and unreadable exchange", () => {
  it("maps a 429 and a rate limit to the busy sentence", () => {
    const busy = "The network is busy. Nothing was sent. Try again in a moment.";
    expect(userMessage(new Error("failed to get genesis hash: 429 Too Many Requests")).text).toBe(
      busy,
    );
    expect(userMessage(new Error("Rate limit exceeded")).text).toBe(busy);
    expect(
      userMessage(new Error('{"jsonrpc":"2.0","error":{"code":429,"message":"slow down"},"id":1}'))
        .text,
    ).toBe(busy);
  });

  it("maps an unreadable exchange account to the cannot-be-reached sentence", () => {
    expect(
      userMessage(new Error("the exchange account is not readable here"), { nothingSent: true })
        .text,
    ).toBe("The exchange cannot be reached right now. Nothing was sent. Try again in a moment.");
  });

  it("keeps raw JSON out of the support detail and keeps a short code", () => {
    const body = '{"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid params"},"id":7}';
    const { detail, known } = userMessage(new Error(`RPC failed: ${body}`));
    expect(known).toBe(false);
    expect(detail).toBe("RPC failed: (code -32602)");
    expect(detail).not.toMatch(/[{}"]/);
    expect(userMessage(new Error(`{\n  "foo": 1\n}`)).detail).toBe("(error body)");
  });
});

describe("userMessageLine", () => {
  it("adds the support detail after the catch-all and nothing after a known sentence", () => {
    expect(userMessageLine(new Error("odd failure"))).toBe(
      "Something went wrong. Try again in a moment, and if it keeps happening contact support. Support detail: odd failure",
    );
    expect(userMessageLine(new Error("User rejected the request."))).toBe(
      "You declined the request in your wallet.",
    );
  });
});
