"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useDismissOnOutside } from "@/components/hooks/useDismissOnOutside";
import { useFunMode } from "@/components/hooks/useFunMode";
import { usePrivacyTools } from "@/components/hooks/usePrivacyTools";
import { Dialog } from "@/components/ui/Dialog";
import { sectionLabel, btnGhost } from "@/components/ui/styles";
import { Switch } from "@/components/ui/Switch";
import type { FunModeSettings } from "@/lib/layout/funMode";
import type { OrderKeyState } from "@/lib/trading/types";
import {
  MOVE_TRADING_HERE,
  SWITCH_DEVICE_STEPS,
  SWITCH_DEVICE_TITLE,
  SWITCH_DEVICE_WARNING,
  deviceStatus,
} from "@/lib/trading/openCopy";

const ROW_BUTTON =
  "rounded-tile text-ink hover:bg-elevated flex min-h-8 w-full items-center px-2 text-[12px]";

export function SettingsPanel({
  keys,
  mainnet,
  funMode,
  onFunModeChange,
  privacyTools,
  onPrivacyToolsChange,
  onResetLayout,
  onOpenGuide,
}: {
  keys: OrderKeyState | null;
  mainnet: boolean;
  funMode: FunModeSettings;
  onFunModeChange: (patch: Partial<FunModeSettings>) => void;
  privacyTools: boolean;
  onPrivacyToolsChange: (on: boolean) => void;
  onResetLayout?: () => void;
  onOpenGuide: () => void;
}) {
  const status = deviceStatus(keys);
  return (
    <>
      <p className={`${sectionLabel} px-2 pt-1 pb-0.5`}>Device</p>
      {status && (
        <p className="text-dim flex min-h-8 items-center gap-2 px-2 text-[12px]">
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${status === "here" ? "bg-safe" : "bg-line-strong"}`}
          />
          {status === "here" ? "Trading on this device" : "Trading on another device"}
        </p>
      )}
      <button type="button" className={ROW_BUTTON} onClick={onOpenGuide}>
        How to switch device
      </button>
      <hr className="border-line-subtle my-1.5" />
      <p className={`${sectionLabel} px-2 pt-1 pb-0.5`}>Display</p>
      <Switch
        label="Fun mode"
        on={funMode.enabled}
        onChange={(enabled) => onFunModeChange({ enabled })}
      />
      <Switch
        label="Screen tint"
        on={funMode.tint}
        onChange={(tint) => onFunModeChange({ tint })}
      />
      <Switch
        label="Wizard"
        on={funMode.wizard}
        onChange={(wizard) => onFunModeChange({ wizard })}
      />
      {mainnet && (
        <Switch label="Privacy tools" on={privacyTools} onChange={onPrivacyToolsChange} />
      )}
      {onResetLayout && (
        <button type="button" className={ROW_BUTTON} onClick={onResetLayout}>
          Reset layout
        </button>
      )}
    </>
  );
}

export function DeviceGuideBody({ titleId, onClose }: { titleId: string; onClose: () => void }) {
  return (
    <>
      <h2 id={titleId} className="text-ink-strong text-[16px] font-medium">
        {SWITCH_DEVICE_TITLE}
      </h2>
      <ol className="text-dim mt-3 flex list-decimal flex-col gap-1.5 pl-5 text-[13px]">
        {SWITCH_DEVICE_STEPS.map((step) => (
          <li key={step} className={step.endsWith(MOVE_TRADING_HERE) ? "text-ink" : undefined}>
            {step}
          </li>
        ))}
      </ol>
      <p className="text-warning mt-3 text-[11px]">{SWITCH_DEVICE_WARNING}</p>
      <button
        type="button"
        data-initial-focus
        className={`${btnGhost} mt-4 h-11 w-full`}
        onClick={onClose}
      >
        Close
      </button>
    </>
  );
}

function GearIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    >
      <circle cx="8" cy="8" r="3.5" />
      <circle cx="8" cy="8" r="1.25" />
      <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2.1 2.1M10.5 10.5l2.1 2.1M12.6 3.4l-2.1 2.1M5.5 10.5l-2.1 2.1" />
    </svg>
  );
}

/** The header cog: device status, the switch-device guide, and the display switches. */
export function SettingsMenu({
  keys,
  mainnet,
  onResetLayout,
}: {
  keys: OrderKeyState | null;
  mainnet: boolean;
  onResetLayout?: () => void;
}) {
  const [funMode, updateFunMode] = useFunMode();
  const [privacyTools, setPrivacyTools] = usePrivacyTools();
  const [open, setOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const cogRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const guideTitleId = useId();
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const close = useCallback(() => setOpen(false), []);
  const closeGuide = useCallback(() => setGuideOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const buttons = Array.from(popoverRef.current?.querySelectorAll<HTMLElement>("button") ?? []);
    buttons.find((button) => button.offsetParent !== null)?.focus();
  }, [open]);
  useDismissOnOutside(open, rootRef, close, () => cogRef.current?.focus());

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        ref={cogRef}
        type="button"
        aria-label="Settings"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={toggle}
        className="rounded-tile text-faint hover:text-ink inline-flex h-8 w-8 items-center justify-center transition-colors"
      >
        <GearIcon />
      </button>
      {open && (
        <div
          ref={popoverRef}
          id={popoverId}
          role="group"
          aria-label="Settings"
          className="border-line bg-surface-raised rounded-panel border p-2 whitespace-normal shadow-lg max-sm:fixed max-sm:top-12 max-sm:right-3 max-sm:w-[calc(100vw-24px)] sm:absolute sm:top-full sm:right-0 sm:mt-1 sm:w-64"
        >
          <SettingsPanel
            keys={keys}
            mainnet={mainnet}
            funMode={funMode}
            onFunModeChange={updateFunMode}
            privacyTools={privacyTools}
            onPrivacyToolsChange={setPrivacyTools}
            onResetLayout={onResetLayout}
            onOpenGuide={() => {
              cogRef.current?.focus();
              close();
              setGuideOpen(true);
            }}
          />
        </div>
      )}
      {guideOpen && (
        <Dialog name={{ titleId: guideTitleId }} onDismiss={closeGuide}>
          <DeviceGuideBody titleId={guideTitleId} onClose={closeGuide} />
        </Dialog>
      )}
    </div>
  );
}
