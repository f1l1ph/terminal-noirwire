import { readChoice, writeChoice, type ChoiceStorage } from "./persistedStore";

/**
 * The trader's Fun mode choice: whether it is on, and which of its two
 * visuals (screen tint, wizard) show. Off by default and remembered per
 * browser.
 */
export const FUN_MODE_STORAGE_KEY = "noirwire-terminal-fun-mode";

/** How the screen tint draws closeness to a target: a closing ring with lamp light, or lines on the chart. */
export type TintStyle = "fuse" | "tripwire";

export const TINT_STYLES: readonly TintStyle[] = ["fuse", "tripwire"];

export interface FunModeSettings {
  enabled: boolean;
  tint: boolean;
  tintStyle: TintStyle;
  wizard: boolean;
}

export const DEFAULT_FUN_MODE: FunModeSettings = {
  enabled: false,
  tint: true,
  tintStyle: "fuse",
  wizard: true,
};

function parseTintStyle(value: unknown): TintStyle {
  return TINT_STYLES.find((style) => style === value) ?? "fuse";
}

function parseFunMode(raw: string | null): FunModeSettings {
  const parsed: unknown = JSON.parse(raw ?? "null");
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_FUN_MODE;
  const { enabled, tint, tintStyle, wizard } = parsed as Record<string, unknown>;
  if (typeof enabled !== "boolean" || typeof tint !== "boolean" || typeof wizard !== "boolean") {
    return DEFAULT_FUN_MODE;
  }
  return { enabled, tint, tintStyle: parseTintStyle(tintStyle), wizard };
}

export function loadFunMode(storage: ChoiceStorage | null): FunModeSettings {
  return readChoice(storage, FUN_MODE_STORAGE_KEY, parseFunMode, DEFAULT_FUN_MODE);
}

export function saveFunMode(storage: ChoiceStorage | null, settings: FunModeSettings): void {
  writeChoice(storage, FUN_MODE_STORAGE_KEY, () => JSON.stringify(settings));
}
