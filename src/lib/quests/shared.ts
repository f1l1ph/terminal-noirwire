import { browserLocalStorage } from "../wallet/index";
import { indexedDbDeviceKeys } from "./keyStore";
import type { QuestDeps } from "./optIn";
import { createQuestQueue, type QuestQueue } from "./queue";

const queues = new Map<string, QuestQueue>();

export function browserQuestDeps(simUrl: string): QuestDeps {
  return {
    storage: browserLocalStorage(),
    keys: indexedDbDeviceKeys,
    fetchFn: (input, init) => fetch(input, init),
    simUrl,
  };
}

export function sharedQuestQueue(simUrl: string): QuestQueue {
  let queue = queues.get(simUrl);
  if (!queue) {
    queue = createQuestQueue(browserQuestDeps(simUrl));
    queues.set(simUrl, queue);
  }
  return queue;
}
