import type { ChoiceStorage } from "@/lib/layout/persistedStore";

export function fakeStorage(initial: Record<string, string> = {}): ChoiceStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

export const throwingStorage: ChoiceStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("quota");
  },
};
