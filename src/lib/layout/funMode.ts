import { readChoice, writeChoice, type ChoiceStorage } from "./persistedStore";

/**
 * The trader's Fun mode choice: whether it is on, and which of its two
 * visuals (screen tint, wizard) show. Off by default and remembered per
 * browser.
 */
export const FUN_MODE_STORAGE_KEY = "noirwire-terminal-fun-mode";

export interface FunModeSettings {
  enabled: boolean;
  tint: boolean;
  wizard: boolean;
}

export const DEFAULT_FUN_MODE: FunModeSettings = { enabled: false, tint: true, wizard: true };

function parseFunMode(raw: string | null): FunModeSettings {
  const parsed: unknown = JSON.parse(raw ?? "null");
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_FUN_MODE;
  const { enabled, tint, wizard } = parsed as Record<string, unknown>;
  if (typeof enabled !== "boolean" || typeof tint !== "boolean" || typeof wizard !== "boolean") {
    return DEFAULT_FUN_MODE;
  }
  return { enabled, tint, wizard };
}

export function loadFunMode(storage: ChoiceStorage | null): FunModeSettings {
  return readChoice(storage, FUN_MODE_STORAGE_KEY, parseFunMode, DEFAULT_FUN_MODE);
}

export function saveFunMode(storage: ChoiceStorage | null, settings: FunModeSettings): void {
  writeChoice(storage, FUN_MODE_STORAGE_KEY, () => JSON.stringify(settings));
}
