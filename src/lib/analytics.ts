declare global {
  interface Window {
    umami?: {
      track: (eventName: string, eventData?: Record<string, unknown>) => void;
    };
  }
}

export type AnalyticsEvent =
  | "wallet_connected"
  | "wallet_verified"
  | "account_opened"
  | "keys_ready"
  | "account_funded"
  | "invite_asked"
  | "account_open_result"
  | "deposit_submitted"
  | "deposit_result"
  | "deposit_needs_sol"
  | "deposit_below_minimum"
  | "order_submitted"
  | "order_result"
  | "quests_enabled";

/**
 * Counts a funnel step. Only the fixed event names and short enum-like words
 * (a status, an order type) are ever sent: never an address, signature,
 * record id, amount, balance, price, size, side, position, invite code or
 * error text. A missing tracker or a tracker that throws is ignored, so
 * analytics can never get in the way of trading.
 */
export function track(event: AnalyticsEvent, data?: Record<string, string>): void {
  try {
    window.umami?.track(event, data);
  } catch {
    // Analytics never breaks the page.
  }
}
