import { describe, expect, it } from "vitest";
import { forgetToken, redactToken, rememberToken, scrubError } from "@/lib/rollup/redact";
import { SessionAuthError } from "@/lib/rollup/session";

const TOKEN = "f3a9c2d1e8b74a6f9d0c5b1a7e3d2c4b";

describe("redactToken", () => {
  it("removes a token from a URL's query string", () => {
    expect(redactToken(`failed https://rollup.example/?token=${TOKEN}&x=1`)).not.toContain(TOKEN);
  });

  it("removes a provider key from an RPC URL", () => {
    expect(redactToken("GET https://rpc.example/v1?api-key=abc123def456")).not.toContain(
      "abc123def456",
    );
  });

  it("removes a token it was told about wherever it appears", () => {
    rememberToken(TOKEN);
    try {
      expect(redactToken(`the endpoint rejected ${TOKEN} as expired`)).not.toContain(TOKEN);
    } finally {
      forgetToken(TOKEN);
    }
  });

  it("leaves text without a token as it was", () => {
    expect(redactToken("the view is not readable")).toBe("the view is not readable");
  });
});

describe("scrubError", () => {
  it("removes the token from the message and the stack and keeps the class", () => {
    const error = new TypeError(`fetch failed for https://rollup.example?token=${TOKEN}`);
    const scrubbed = scrubError(error);
    expect(scrubbed).toBeInstanceOf(TypeError);
    expect(`${scrubbed.message}\n${scrubbed.stack}`).not.toContain(TOKEN);
  });

  it("removes the token from a wrapped cause", () => {
    const cause = new Error(`401 for ?token=${TOKEN}`);
    const scrubbed = scrubError(new Error("outer", { cause }));
    expect(
      `${(scrubbed.cause as Error).message}\n${(scrubbed.cause as Error).stack}`,
    ).not.toContain(TOKEN);
  });

  it("leaves a thrown value that is not an error alone", () => {
    expect(scrubError("plain")).toBe("plain");
  });
});

describe("a failed sign-in", () => {
  it("does not carry a token in the text the trader sees", () => {
    const failure = new SessionAuthError(new Error(`401 at https://r.example?token=${TOKEN}`));
    expect(failure.message).not.toContain(TOKEN);
  });
});
