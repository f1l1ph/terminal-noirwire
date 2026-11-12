import { DISMISSED_KEY } from "../../src/lib/quests/invite";

export function withQuestDialogDismissed(baseUrl: string) {
  return {
    cookies: [],
    origins: [
      {
        origin: new URL(baseUrl).origin,
        localStorage: [{ name: DISMISSED_KEY, value: "1" }],
      },
    ],
  };
}
