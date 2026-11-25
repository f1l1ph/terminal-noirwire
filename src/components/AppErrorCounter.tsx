"use client";

import { useEffect } from "react";
import { trackAppError } from "@/lib/analytics";

/** Counts uncaught errors and unhandled rejections on the page, by kind only. */
export function AppErrorCounter() {
  useEffect(() => {
    const onError = () => trackAppError("uncaught");
    const onRejection = () => trackAppError("rejection");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
