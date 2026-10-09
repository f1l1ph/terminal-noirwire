import { z } from "zod";

/**
 * Every value the terminal needs to reach the simulation service, read once
 * at module load. A missing or malformed URL throws here, which fails the
 * build and refuses to start the dev server, rather than shipping a terminal
 * that silently reaches nothing.
 */
const wsUrl = (name: string) =>
  z
    .string()
    .url(`${name} must be an absolute ws(s) URL`)
    .refine((value) => value.startsWith("ws://") || value.startsWith("wss://"), {
      message: `${name} must start with ws:// or wss://`,
    });

/**
 * Rollup mode reads its own URLs and program id from sim-noirwire's
 * `GET /v1/deployment` (see src/lib/rollup/deployment.ts) rather than from
 * configuration - these three are optional overrides only, for when the
 * service reaches the network at an address this browser cannot (a
 * container, a hosted deployment with a different public endpoint). There
 * is no NEXT_PUBLIC_SOLANA_RPC_URL: nothing in the trading path ever talks
 * to base-layer Solana directly (open+fund and every trading instruction
 * are rollup-only), so it would be configuration with no reader.
 */
const envSchema = z.object({
  simUrl: z.string().url("NEXT_PUBLIC_SIM_URL must be an absolute http(s) URL"),
  simWsUrl: wsUrl("NEXT_PUBLIC_SIM_WS_URL"),
  tradingMode: z.enum(["dev", "rollup"]),
  networkLabel: z.string().min(1),
  rollupRpcUrlOverride: z
    .string()
    .url("NEXT_PUBLIC_ROLLUP_RPC_URL must be an absolute http(s) URL")
    .optional(),
  rollupWsUrlOverride: wsUrl("NEXT_PUBLIC_ROLLUP_WS_URL").optional(),
  orderbookProgramIdOverride: z.string().min(32).max(44).optional(),
});

export type Env = z.infer<typeof envSchema>;

function readEnv(): Env {
  const result = envSchema.safeParse({
    simUrl: process.env.NEXT_PUBLIC_SIM_URL,
    simWsUrl: process.env.NEXT_PUBLIC_SIM_WS_URL,
    tradingMode: process.env.NEXT_PUBLIC_TRADING_MODE || "dev",
    networkLabel: process.env.NEXT_PUBLIC_NETWORK_LABEL || "TEST NETWORK",
    rollupRpcUrlOverride: process.env.NEXT_PUBLIC_ROLLUP_RPC_URL || undefined,
    rollupWsUrlOverride: process.env.NEXT_PUBLIC_ROLLUP_WS_URL || undefined,
    orderbookProgramIdOverride: process.env.NEXT_PUBLIC_ORDERBOOK_PROGRAM_ID || undefined,
  });
  if (!result.success) {
    const reasons = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid terminal configuration:\n${reasons.join("\n")}`);
  }
  return result.data;
}

export const env = readEnv();
