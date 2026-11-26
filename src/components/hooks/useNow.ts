"use client";

import { useEffect, useState } from "react";

const TICK_MS = 1000;

/** The current time, refreshed every second, for age and staleness displays. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}
