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
