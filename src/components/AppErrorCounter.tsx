"use client";

import { useEffect } from "react";
import { trackAppError } from "@/lib/analytics";

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
