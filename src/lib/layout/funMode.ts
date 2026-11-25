import type { ChoiceStorage } from "./persistedStore";

/**
 * The trader's Fun mode choice: whether it is on, and which of its two
 * visuals (screen tint, wizard) show. Off by default and remembered per
 * browser; storage access is injected so every rule here is testable without
 * a browser, and a storage that throws only means the choice is not
 * remembered.
 */
export const FUN_MODE_STORAGE_KEY = "noirwire-terminal-fun-mode";

export interface FunModeSettings {
  enabled: boolean;
  tint: boolean;
  wizard: boolean;
}

export const DEFAULT_FUN_MODE: FunModeSettings = { enabled: false, tint: true, wizard: true };

export function loadFunMode(storage: ChoiceStorage | null): FunModeSettings {
  if (!storage) return DEFAULT_FUN_MODE;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(FUN_MODE_STORAGE_KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_FUN_MODE;
    const { enabled, tint, wizard } = parsed as Record<string, unknown>;
    if (typeof enabled !== "boolean" || typeof tint !== "boolean" || typeof wizard !== "boolean") {
      return DEFAULT_FUN_MODE;
    }
    return { enabled, tint, wizard };
  } catch {
    return DEFAULT_FUN_MODE;
  }
}

export function saveFunMode(storage: ChoiceStorage | null, settings: FunModeSettings): void {
  if (!storage) return;
  try {
    storage.setItem(FUN_MODE_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // The choice still holds for this session; it is just not remembered.
  }
}
