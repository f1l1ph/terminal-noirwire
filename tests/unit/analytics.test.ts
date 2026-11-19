import { afterEach, describe, expect, it, vi } from "vitest";
import { track } from "@/lib/analytics";

afterEach(() => vi.unstubAllGlobals());

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

  it("hands the tracker exactly the event and its data", () => {
    const umamiTrack = vi.fn();
    vi.stubGlobal("window", { umami: { track: umamiTrack } });
    track("deposit_result", { result: "done" });
    expect(umamiTrack).toHaveBeenCalledWith("deposit_result", { result: "done" });
  });
});
