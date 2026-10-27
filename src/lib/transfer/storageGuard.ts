/**
 * A deposit's key and its record live only in this browser's storage. Before
 * the first signature, the browser must be able to keep them: storage that
 * is missing, blocked or wiped when the window closes would strand the USDC
 * a deposit has moved between its first step and its last.
 */
export interface BrowserStorageEnv {
  /** `navigator.storage`; absent where the browser offers none. */
  storage?: {
    persist?: () => Promise<boolean>;
    persisted?: () => Promise<boolean>;
    estimate?: () => Promise<{ quota?: number }>;
  };
  /** Opens the transfer record store; throws where IndexedDB is missing or blocked. */
  openRecords: () => Promise<unknown>;
}

export type DepositStorage =
  | {
      ok: true;
      /** Whether the browser has promised to keep this app's data until the user clears it. */
      persisted: boolean;
    }
  | { ok: false; reason: string };

/**
 * Private windows give a site a small, temporary quota that is dropped when
 * the window closes; ordinary profiles get far more.
 */
const PRIVATE_WINDOW_QUOTA_BYTES = 120 * 1024 * 1024;

const UNAVAILABLE =
  "This browser is not letting the app save data, which a deposit needs to finish. Allow site data for this page, or use a regular browser window. Nothing was sent.";
const PRIVATE_WINDOW =
  "This looks like a private window, which deletes the app's saved data when it closes. A deposit could not be finished after that. Open the app in a regular window. Nothing was sent.";

async function attempt<T>(run: () => Promise<T> | undefined): Promise<T | undefined> {
  try {
    return await run();
  } catch {
    return undefined;
  }
}

/** Asks the browser to keep the data, and says whether a deposit may start. */
export async function checkDepositStorage(env: BrowserStorageEnv): Promise<DepositStorage> {
  if (!env.storage) return { ok: false, reason: UNAVAILABLE };
  try {
    await env.openRecords();
  } catch {
    return { ok: false, reason: UNAVAILABLE };
  }
  const estimate = await attempt(() => env.storage?.estimate?.());
  if (estimate?.quota !== undefined && estimate.quota < PRIVATE_WINDOW_QUOTA_BYTES) {
    return { ok: false, reason: PRIVATE_WINDOW };
  }
  const granted = await attempt(() => env.storage?.persist?.());
  const persisted = await attempt(() => env.storage?.persisted?.());
  return { ok: true, persisted: persisted ?? granted ?? false };
}
