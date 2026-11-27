import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FUN_MODE_STORAGE_KEY } from "@/lib/layout/funMode";

function storageWith(saved: Record<string, string>) {
  return {
    getItem: (key: string) => saved[key] ?? null,
    setItem: (key: string, value: string) => {
      saved[key] = value;
    },
  };
}

async function freshFunMode(saved: Record<string, string> = {}) {
  const umamiTrack = vi.fn();
  vi.stubGlobal("window", { umami: { track: umamiTrack }, localStorage: storageWith(saved) });
  const funMode = await import("@/components/hooks/useFunMode");
  return { ...funMode, umamiTrack };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fun mode analytics", () => {
  it("counts the stored choice once per page load", async () => {
    const { reportFunModeAtLoad, umamiTrack } = await freshFunMode({
      [FUN_MODE_STORAGE_KEY]: JSON.stringify({ enabled: true, tint: true, wizard: false }),
    });
    reportFunModeAtLoad();
    reportFunModeAtLoad();
    expect(umamiTrack).toHaveBeenCalledTimes(1);
    expect(umamiTrack).toHaveBeenCalledWith("fun_mode_seen", { state: "on", v: "dev" });
  });

  it("counts a browser with no stored choice as off", async () => {
    const { reportFunModeAtLoad, umamiTrack } = await freshFunMode();
    reportFunModeAtLoad();
    expect(umamiTrack).toHaveBeenCalledWith("fun_mode_seen", { state: "off", v: "dev" });
  });

  it("counts each switch of Fun mode with the state it lands on", async () => {
    const { changeFunMode, umamiTrack } = await freshFunMode();
    changeFunMode({ enabled: true });
    changeFunMode({ enabled: false });
    expect(umamiTrack.mock.calls).toEqual([
      ["fun_mode_switched", { state: "on", v: "dev" }],
      ["fun_mode_switched", { state: "off", v: "dev" }],
    ]);
  });

  it("counts nothing for a change that leaves Fun mode where it was", async () => {
    const { changeFunMode, umamiTrack } = await freshFunMode();
    changeFunMode({ enabled: false });
    changeFunMode({ tintStyle: "tripwire" });
    changeFunMode({ wizard: false });
    expect(umamiTrack).not.toHaveBeenCalled();
  });
});
