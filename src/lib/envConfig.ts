import { z } from "zod";
import { MAINNET_PINS } from "./rollup/pins";
import { mainnetRefusals, unsignedDevModeRefusal } from "./trading/modeGuard";

/**
 * Every value the terminal needs to reach the simulation service. A missing
 * or malformed URL throws, which refuses to start the dev server, rather
 * than shipping a terminal that silently reaches nothing. `src/lib/env` reads
 * it once at module load; `next.config.ts` reads it at build time on a
 * mainnet build, so a bad mainnet environment fails the build.
 */
const wsUrl = (name: string) =>
  z
    .string()
    .url(`${name} must be an absolute ws(s) URL`)
    .refine((value) => value.startsWith("ws://") || value.startsWith("wss://"), {
      message: `${name} must start with ws:// or wss://`,
    });

/**
 * On a test network, rollup mode reads its own URLs and program id from
 * sim-noirwire's `GET /v1/deployment` (see src/lib/rollup/deployment.ts)
 * rather than from configuration - these three are optional overrides only,
 * for when the service reaches the network at an address this browser cannot
 * (a container, a hosted deployment with a different public endpoint). On
 * `NEXT_PUBLIC_NETWORK=mainnet` they are pinned in code instead
 * (src/lib/rollup/pins.ts): each must be unset or exactly the pin, and the
 * pin is what the build uses either way. There
 * is no NEXT_PUBLIC_SOLANA_RPC_URL: nothing in the trading path ever talks
 * to base-layer Solana directly (open+fund and every trading instruction
 * are rollup-only), so it would be configuration with no reader.
 */
const envSchema = z.object({
  simUrl: z.string().url("NEXT_PUBLIC_SIM_URL must be an absolute http(s) URL"),
  simWsUrl: wsUrl("NEXT_PUBLIC_SIM_WS_URL"),
  tradingMode: z.enum(["dev", "rollup"]),
  network: z.enum(["mainnet", "test"]),
  networkLabel: z.string().min(1),
  rollupRpcUrlOverride: z
    .string()
    .url("NEXT_PUBLIC_ROLLUP_RPC_URL must be an absolute http(s) URL")
    .optional(),
  rollupWsUrlOverride: wsUrl("NEXT_PUBLIC_ROLLUP_WS_URL").optional(),
  orderbookProgramIdOverride: z.string().min(32).max(44).optional(),
});

type Env = z.infer<typeof envSchema>;

export function readEnv(): Env {
  const result = envSchema.safeParse({
    simUrl: process.env.NEXT_PUBLIC_SIM_URL,
    simWsUrl: process.env.NEXT_PUBLIC_SIM_WS_URL,
    tradingMode: process.env.NEXT_PUBLIC_TRADING_MODE || "dev",
    network: process.env.NEXT_PUBLIC_NETWORK || "test",
    networkLabel:
      process.env.NEXT_PUBLIC_NETWORK_LABEL ||
      (process.env.NEXT_PUBLIC_NETWORK === "mainnet" ? "MAINNET" : "TEST NETWORK"),
    rollupRpcUrlOverride: process.env.NEXT_PUBLIC_ROLLUP_RPC_URL || undefined,
    rollupWsUrlOverride: process.env.NEXT_PUBLIC_ROLLUP_WS_URL || undefined,
    orderbookProgramIdOverride: process.env.NEXT_PUBLIC_ORDERBOOK_PROGRAM_ID || undefined,
  });
  if (!result.success) {
    const reasons = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid terminal configuration:\n${reasons.join("\n")}`);
  }
  const refusal = unsignedDevModeRefusal(
    result.data.tradingMode,
    process.env.NODE_ENV,
    process.env.NEXT_PUBLIC_ALLOW_UNSIGNED_DEV_MODE,
  );
  if (refusal) throw new Error(`Invalid terminal configuration:\n${refusal}`);
  if (result.data.network !== "mainnet") return result.data;
  const mainnetProblems = mainnetRefusals(
    {
      tradingMode: result.data.tradingMode,
      allowUnsignedDev: process.env.NEXT_PUBLIC_ALLOW_UNSIGNED_DEV_MODE,
      networkLabel: result.data.networkLabel,
      programIdOverride: result.data.orderbookProgramIdOverride,
      rollupRpcUrlOverride: result.data.rollupRpcUrlOverride,
      rollupWsUrlOverride: result.data.rollupWsUrlOverride,
    },
    MAINNET_PINS,
  );
  if (mainnetProblems.length > 0) {
    throw new Error(`Invalid terminal configuration:\n${mainnetProblems.join("\n")}`);
  }
  return {
    ...result.data,
    rollupRpcUrlOverride: MAINNET_PINS.rollupRpcUrl,
    rollupWsUrlOverride: MAINNET_PINS.rollupWsUrl,
    orderbookProgramIdOverride: MAINNET_PINS.programId,
  };
}
