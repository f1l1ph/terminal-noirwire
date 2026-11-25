import { describe, expect, it } from "vitest";
import { FAILURE_REASONS } from "@/lib/analytics";
import {
  failureReasonOf,
  openRefusalReason,
  reasonForStatus,
  tookBucket,
} from "@/lib/failureReason";
import { SeedStorageError } from "@/lib/rollup/orderKeySetup";
import type { OpenRefusal } from "@/lib/rollup/openClient";

const named = (name: string, message = "anything") => {
  const error = new Error(message);
  error.name = name;
  return error;
};

describe("failureReasonOf", () => {
  it("reads a wallet rejection code as declined", () => {
    expect(failureReasonOf(Object.assign(new Error("x"), { code: 4001 }))).toBe("wallet_declined");
    expect(failureReasonOf(named("WalletWindowClosedError"))).toBe("wallet_declined");
  });

  it("reads a wallet that cannot sign as unavailable", () => {
    for (const name of [
      "WalletNotReadyError",
      "WalletNotConnectedError",
      "WalletConnectionError",
      "WalletDisconnectedError",
      "NetworkRefused",
      "StaleSigner",
    ]) {
      expect(failureReasonOf(named(name)), name).toBe("wallet_unavailable");
    }
  });

  it("reads aborts and timeouts by name", () => {
    expect(failureReasonOf(new DOMException("x", "AbortError"))).toBe("request_timeout");
    expect(failureReasonOf(new DOMException("x", "TimeoutError"))).toBe("request_timeout");
  });

  it("reads the app's unreachable-service errors by name", () => {
    expect(failureReasonOf(named("SessionAuthError"))).toBe("network_unreachable");
    expect(failureReasonOf(named("RollupIdentityError"))).toBe("network_unreachable");
    expect(failureReasonOf(named("SessionRefused"))).toBe("server_refused");
    expect(failureReasonOf(named("OrderOutcomeUnknownError"))).toBe("request_timeout");
  });

  it("reads a seed store failure as key storage", () => {
    expect(failureReasonOf(new SeedStorageError(new Error("browser storage is unavailable")))).toBe(
      "key_storage_unavailable",
    );
  });

  it("reads an HTTP status on the error", () => {
    const withStatus = (status: number) => Object.assign(new Error("x"), { status });
    expect(failureReasonOf(withStatus(429))).toBe("rate_limited");
    expect(failureReasonOf(withStatus(503))).toBe("network_unreachable");
    expect(failureReasonOf(withStatus(400))).toBe("server_refused");
  });

  it("follows the cause chain a few levels and no further", () => {
    const wrapped = new Error("outer", {
      cause: new Error("inner", { cause: named("AbortError") }),
    });
    expect(failureReasonOf(wrapped)).toBe("request_timeout");
    let deep: unknown = named("AbortError");
    for (let i = 0; i < 6; i++) deep = new Error("wrap", { cause: deep });
    expect(failureReasonOf(deep)).toBe("other");
  });

  it("reads a wallet's rejection wording as declined, the one wording it knows", () => {
    expect(failureReasonOf(new Error("User rejected the request."))).toBe("wallet_declined");
  });

  it("reads no other message: an error that only says it timed out is other", () => {
    expect(failureReasonOf(new Error("request timed out"))).toBe("other");
    expect(failureReasonOf(new Error("429 Too Many Requests"))).toBe("other");
    expect(failureReasonOf(new TypeError("Failed to fetch"))).toBe("other");
  });

  it("is other for values that are not errors", () => {
    expect(failureReasonOf(undefined)).toBe("other");
    expect(failureReasonOf(null)).toBe("other");
    expect(failureReasonOf(42)).toBe("other");
    expect(failureReasonOf({ status: "429" })).toBe("other");
  });

  it("only returns listed reasons", () => {
    const samples = [
      new Error("x"),
      named("AbortError"),
      Object.assign(new Error(), { status: 418 }),
    ];
    for (const sample of samples) expect(FAILURE_REASONS).toContain(failureReasonOf(sample));
  });
});

describe("reasonForStatus", () => {
  it.each([
    [429, "rate_limited"],
    [408, "request_timeout"],
    [504, "request_timeout"],
    [502, "network_unreachable"],
    [503, "network_unreachable"],
    [400, "server_refused"],
    [403, "server_refused"],
    [500, "server_refused"],
    [200, "other"],
    [0, "other"],
  ] as const)("%i is %s", (status, reason) => {
    expect(reasonForStatus(status)).toBe(reason);
  });
});

describe("openRefusalReason", () => {
  it.each([
    [{ kind: "notInvited" }, "invite_required"],
    [{ kind: "inviteCodeNeeded" }, "invite_required"],
    [{ kind: "inviteCodeWrong" }, "invite_required"],
    [{ kind: "inviteUsed" }, "invite_required"],
    [{ kind: "tryLater" }, "rate_limited"],
    [{ kind: "dailyCapReached" }, "daily_cap"],
    [{ kind: "addressLimit" }, "daily_cap"],
    [{ kind: "prepareExpired" }, "request_timeout"],
    [{ kind: "mayBeOpen" }, "request_timeout"],
    [{ kind: "unreachable" }, "network_unreachable"],
    [{ kind: "badAnswer" }, "server_refused"],
    [{ kind: "rejected", status: 429 }, "rate_limited"],
    [{ kind: "rejected", status: 500 }, "server_refused"],
    [{ kind: "accountOpen" }, null],
  ] as [OpenRefusal, string | null][])("%o is %s", (refusal, reason) => {
    expect(openRefusalReason(refusal)).toBe(reason);
  });
});

describe("tookBucket", () => {
  it.each([
    [0, "under_5s"],
    [4_999, "under_5s"],
    [5_000, "5_30s"],
    [29_999, "5_30s"],
    [30_000, "30_120s"],
    [119_999, "30_120s"],
    [120_000, "over_120s"],
    [-1, "under_5s"],
    [Number.NaN, "under_5s"],
  ] as const)("%d ms is %s", (ms, bucket) => {
    expect(tookBucket(ms)).toBe(bucket);
  });
});
