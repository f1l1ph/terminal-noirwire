import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fillSyncDelayMs, syncUntilDone } from "@/lib/trading/fillSync";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fillSyncDelayMs", () => {
  it("doubles from two seconds up to a minute", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(fillSyncDelayMs)).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
    ]);
  });
});

describe("syncUntilDone", () => {
  it("reports done only after the sync succeeded", async () => {
    const sync = vi.fn().mockResolvedValue(true);
    const onDone = vi.fn();
    syncUntilDone(sync, onDone);
    expect(onDone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("asks again with a growing wait while the sync fails, and is done when it lands", async () => {
    const sync = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValue(true);
    const onDone = vi.fn();
    syncUntilDone(sync, onDone);
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(onDone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sync).toHaveBeenCalledTimes(3);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("never gives up: it keeps asking once a minute after the waits have grown to the ceiling", async () => {
    const sync = vi.fn().mockResolvedValue(false);
    const onDone = vi.fn();
    syncUntilDone(sync, onDone);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const early = sync.mock.calls.length;
    expect(early).toBeGreaterThan(8);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sync.mock.calls.length - early).toBe(60);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("stops asking and never reports done once stopped", async () => {
    let finish!: (value: boolean) => void;
    const sync = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const onDone = vi.fn();
    const stop = syncUntilDone(sync, onDone);
    stop();
    finish(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(onDone).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("stops a pending retry", async () => {
    const sync = vi.fn().mockResolvedValue(false);
    const stop = syncUntilDone(sync, () => {});
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sync).toHaveBeenCalledTimes(1);
  });
});
