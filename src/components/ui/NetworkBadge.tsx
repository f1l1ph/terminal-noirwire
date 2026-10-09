import { env } from "@/lib/env";

/**
 * Sits beside every balance, volume and speed figure, per the brief: no
 * number on this screen is ever mistaken for real money or a real-money
 * venue.
 */
export function NetworkBadge({ className }: { className?: string }) {
  return (
    <span
      className={`border-line text-faint inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] tracking-wide uppercase ${className ?? ""}`}
    >
      {env.networkLabel}
    </span>
  );
}
