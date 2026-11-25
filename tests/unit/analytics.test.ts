import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildVersion,
  EVENT_SCHEMA,
  resetAppErrors,
  resetTrackOnce,
  sanitizeEventData,
  track,
  trackAppError,
  trackOnce,
} from "@/lib/analytics";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetTrackOnce();
  resetAppErrors();
});

describe("track", () => {
  it("does nothing when the tracker is not loaded", () => {
    vi.stubGlobal("window", {});
    expect(() => track("order_submitted", { type: "limit" })).not.toThrow();
  });

  it("never throws when the tracker does", () => {
    vi.stubGlobal("window", {
      umami: {
        track: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(() => track("wallet_connected")).not.toThrow();
  });

  it("hands the tracker the event, its allowed data and the build version", () => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA", "86A9F8C1234567890abcdef");
    const umamiTrack = vi.fn();
    vi.stubGlobal("window", { umami: { track: umamiTrack } });
    track("deposit_result", { result: "done" });
    expect(umamiTrack).toHaveBeenCalledWith("deposit_result", { result: "done", v: "86a9f8c" });
  });

  it("drops anything the schema does not allow before it reaches the tracker", () => {
    const umamiTrack = vi.fn();
    vi.stubGlobal("window", { umami: { track: umamiTrack } });
    const leaky = {
      result: "error",
      reason: "Failed to fetch https://rpc.example/?api-key=secret",
      address: "So11111111111111111111111111111111111111112",
      amount: "25.00",
    } as unknown as Parameters<typeof track<"deposit_result">>[1];
    track("deposit_result", leaky);
    const sent = umamiTrack.mock.calls[0][1];
    expect(sent).toEqual({ result: "error", reason: "other", v: "dev" });
    expect(JSON.stringify(sent)).not.toMatch(/secret|So111|25\.00|https/);
  });

  it("sends nothing for an event that is not in the schema", () => {
    const umamiTrack = vi.fn();
    vi.stubGlobal("window", { umami: { track: umamiTrack } });
    track("made_up" as never);
    expect(umamiTrack).not.toHaveBeenCalled();
  });
});

describe("sanitizeEventData", () => {
  it("keeps a listed value", () => {
    expect(
      sanitizeEventData("setup_step_done", { step: "keys", how: "already" }, "abc1234"),
    ).toEqual({ step: "keys", how: "already", v: "abc1234" });
  });

  it("turns an unlisted value into other", () => {
    expect(sanitizeEventData("setup_step_seen", { step: "withdraw" }, "dev")).toEqual({
      step: "other",
      v: "dev",
    });
  });

  it("turns a non-string value into other", () => {
    expect(sanitizeEventData("order_blocked", { reason: 42 }, "dev")).toEqual({
      reason: "other",
      v: "dev",
    });
    expect(sanitizeEventData("order_blocked", { reason: { text: "x" } }, "dev")).toEqual({
      reason: "other",
      v: "dev",
    });
  });

  it("drops an unknown key and leaves an omitted one out", () => {
    expect(sanitizeEventData("setup_failed", { step: "open", invite: "ABC-123" }, "dev")).toEqual({
      step: "open",
      v: "dev",
    });
  });

  it("does not read keys from the prototype", () => {
    const data = Object.create({ step: "open" }) as Record<string, unknown>;
    expect(sanitizeEventData("setup_action", data, "dev")).toEqual({ v: "dev" });
  });

  it("cannot be told to overwrite the version", () => {
    expect(sanitizeEventData("wallet_connected", { v: "spoofed" }, "dev")).toEqual({ v: "dev" });
  });

  it("returns null for an event outside the schema, including inherited names", () => {
    expect(sanitizeEventData("made_up", {}, "dev")).toBeNull();
    expect(sanitizeEventData("toString", {}, "dev")).toBeNull();
  });

  it("only ever lists short snake-case or known words, never free text", () => {
    for (const keys of Object.values(EVENT_SCHEMA)) {
      for (const values of Object.values(keys as Record<string, readonly string[]>)) {
        for (const value of values) expect(value).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
      }
    }
  });
});

describe("buildVersion", () => {
  it("is the first seven characters of a commit sha, lower-cased", () => {
    expect(buildVersion("86A9F8CDEADBEEF")).toBe("86a9f8c");
  });

  it("is dev when there is no sha or it is not a sha", () => {
    expect(buildVersion(undefined)).toBe("dev");
    expect(buildVersion("")).toBe("dev");
    expect(buildVersion("main")).toBe("dev");
    expect(buildVersion("abc12")).toBe("dev");
  });
});

describe("trackOnce", () => {
  it("sends once per key per page load", () => {
    const umamiTrack = vi.fn();
    vi.stubGlobal("window", { umami: { track: umamiTrack } });
    trackOnce("ticket", "ticket_seen");
    trackOnce("ticket", "ticket_seen");
    trackOnce("other", "ticket_seen");
    expect(umamiTrack).toHaveBeenCalledTimes(2);
  });
});

describe("trackAppError", () => {
  it("sends the kind only, at most three times per page load", () => {
    const umamiTrack = vi.fn();
    vi.stubGlobal("window", { umami: { track: umamiTrack } });
    for (const kind of [
      "uncaught",
      "rejection",
      "route_boundary",
      "uncaught",
      "rejection",
    ] as const) {
      trackAppError(kind);
    }
    expect(umamiTrack.mock.calls).toEqual([
      ["app_error", { kind: "uncaught", v: "dev" }],
      ["app_error", { kind: "rejection", v: "dev" }],
      ["app_error", { kind: "route_boundary", v: "dev" }],
    ]);
  });
});
