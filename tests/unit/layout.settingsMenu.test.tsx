import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeviceGuideBody, SettingsPanel } from "../../src/components/SettingsMenu";
import { DEFAULT_FUN_MODE } from "../../src/lib/layout/funMode";
import {
  SWITCH_DEVICE_STEPS,
  SWITCH_DEVICE_TITLE,
  SWITCH_DEVICE_WARNING,
} from "../../src/lib/trading/openCopy";

type PanelProps = Parameters<typeof SettingsPanel>[0];

function renderPanel(overrides: Partial<PanelProps> = {}) {
  return renderToStaticMarkup(
    createElement(SettingsPanel, {
      keys: null,
      mainnet: true,
      funMode: DEFAULT_FUN_MODE,
      onFunModeChange: () => {},
      privacyTools: false,
      onPrivacyToolsChange: () => {},
      onOpenGuide: () => {},
      ...overrides,
    }),
  );
}

describe("settings panel", () => {
  it("lists the device and display sections with the three display switches", () => {
    const html = renderPanel();
    expect(html).toContain("Device");
    expect(html).toContain("How to switch device");
    expect(html).toContain("Display");
    for (const label of ["Fun mode", "Screen tint", "Wizard"]) expect(html).toContain(label);
  });

  it("shows the privacy tools switch on mainnet only", () => {
    expect(renderPanel({ mainnet: true })).toContain("Privacy tools");
    expect(renderPanel({ mainnet: false })).not.toContain("Privacy tools");
  });

  it("shows Reset layout only when a handler is given", () => {
    expect(renderPanel({ onResetLayout: () => {} })).toContain("Reset layout");
    expect(renderPanel()).not.toContain("Reset layout");
  });

  it("shows no device status while the keys are unknown", () => {
    const html = renderPanel({ keys: null });
    expect(html).not.toContain("Trading on this device");
    expect(html).not.toContain("Trading on another device");
  });

  it("says where trading is once the keys are known", () => {
    expect(renderPanel({ keys: { stage: "ready", seedPersisted: true } })).toContain(
      "Trading on this device",
    );
    expect(
      renderPanel({ keys: { stage: "elsewhere", cancelsStops: false, seedPersisted: true } }),
    ).toContain("Trading on another device");
  });
});

describe("switch device guide", () => {
  const html = renderToStaticMarkup(
    createElement(DeviceGuideBody, { titleId: "guide-title", onClose: () => {} }),
  );

  it("carries the title, the three steps and the stops warning", () => {
    expect(html).toContain(SWITCH_DEVICE_TITLE);
    expect(html).toContain("<ol");
    expect(SWITCH_DEVICE_STEPS).toEqual([
      "Open NoirWire on the new device",
      "Connect the same wallet",
      "Press Move trading here",
    ]);
    for (const step of SWITCH_DEVICE_STEPS) expect(html).toContain(step);
    expect(html).toContain(SWITCH_DEVICE_WARNING);
  });
});
