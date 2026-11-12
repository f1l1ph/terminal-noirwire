export const QUEST_DEVICE_DAYS = 30;
export const QUEST_ORDER_BATCH = 20;

export interface QuestOrder {
  market: string;
  secret: string;
}

export function consentText(
  wallet: string,
  deviceKey: string,
  until: string,
  challenge: string,
): string {
  return [
    "Earn MagicBlock quest points on this device. While on, NoirWire records which of your trades count toward quests.",
    `Wallet: ${wallet}`,
    `Device key: ${deviceKey}`,
    `Until: ${until}`,
    `Code: ${challenge}`,
  ].join("\n");
}

export function ordersText(deviceKey: string, signedAt: number, orders: QuestOrder[]): string {
  const lines = orders.map((order) => `${order.market} ${order.secret}`);
  return ["NoirWire quest orders", deviceKey, String(signedAt), ...lines].join("\n");
}

export function revokeText(deviceKey: string, signedAt: number): string {
  return ["NoirWire quest device off", deviceKey, String(signedAt)].join("\n");
}
