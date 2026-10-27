import { describe, expect, it } from "vitest";
import { messageDeclined, OwnerActionFailed, OwnerActionRefused } from "@/lib/rollup/ownerMessages";
import { retriesSignIn } from "@/lib/rollup/session";
import { isWalletDecline } from "@/lib/wallet/declined";

const named = (name: string, message: string) => Object.assign(new Error(message), { name });

describe("isWalletDecline", () => {
  it("accepts the wallet's own signals", () => {
    expect(isWalletDecline({ code: 4001 })).toBe(true);
    expect(isWalletDecline(new Error("User rejected the request."))).toBe(true);
    expect(isWalletDecline(named("WalletSignTransactionError", "User rejected the request."))).toBe(
      true,
    );
    expect(isWalletDecline(named("WalletWindowClosedError", "Window closed"))).toBe(true);
    expect(
      isWalletDecline(Object.assign(new Error("Unexpected error"), { cause: { code: 4001 } })),
    ).toBe(true);
  });

  it("does not read a signing failure as a decline, next to a real 4001", () => {
    for (const error of [
      named("WalletSignTransactionError", "Unexpected error"),
      named("WalletSignMessageError", "x"),
      named("WalletSendTransactionError", "Ledger device disconnected"),
      new Error("fetch failed"),
      Object.assign(new Error("Internal error"), { code: -32603 }),
    ]) {
      expect(isWalletDecline(error)).toBe(false);
    }
    expect(isWalletDecline(Object.assign(new Error("Unexpected error"), { code: 4001 }))).toBe(
      true,
    );
  });

  it("never matches free text from this app's own errors", () => {
    for (const error of [
      new Error("No wallet to cancel for"),
      new Error("Refusing to sign: the transaction differs"),
      new Error("https://book.example/v1/deployment refused: pins differ"),
      named("NetworkRefused", "the network was refused"),
      named("SignedTransactionRefused", "the wallet's answer was refused"),
      new OwnerActionRefused("the message is not the expected one"),
      new OwnerActionFailed("The request was refused for carrying a wrong time."),
      new Error("Cancelled"),
    ]) {
      expect(isWalletDecline(error)).toBe(false);
    }
  });
});

describe("callers of the shared decline check", () => {
  it("messageDeclined excludes the app's own owner-action errors", () => {
    expect(messageDeclined(new Error("User rejected the request"))).toBe(true);
    expect(messageDeclined(new OwnerActionRefused("the signature is wrong"))).toBe(false);
    expect(messageDeclined(new Error("refused"))).toBe(false);
  });

  it("retriesSignIn does not retry a decline but retries an unrelated failure", () => {
    expect(retriesSignIn({ code: 4001 })).toBe(false);
    expect(retriesSignIn(named("WalletWindowClosedError", "x"))).toBe(false);
    expect(retriesSignIn(new Error("No wallet to cancel for"))).toBe(true);
  });
});
