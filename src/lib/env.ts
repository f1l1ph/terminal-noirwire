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
 * Rollup config is required only in rollup mode (NEXT_PUBLIC_TRADING_MODE=rollup).
 * `programId` is optional: it defaults to the package's own baked-in program
 * id (`@noirwire/orderbook`'s `PROGRAM_ID`), which is the id this terminal's
 * deployment actually uses unless a redeploy needs a different one. There is
 * no NEXT_PUBLIC_SOLANA_RPC_URL: nothing in the trading path ever talks to
 * base-layer Solana directly (open+fund and every trading instruction are
 * rollup-only), so it would be configuration with no reader. See
 * docs/BUILD-NOTES.md, "Rollup config the service doesn't expose yet."
 */
const envSchema = z
  .object({
    simUrl: z.string().url("NEXT_PUBLIC_SIM_URL must be an absolute http(s) URL"),
    simWsUrl: wsUrl("NEXT_PUBLIC_SIM_WS_URL"),
    tradingMode: z.enum(["dev", "rollup"]),
    networkLabel: z.string().min(1),
    rollupRpcUrl: z
      .string()
      .url("NEXT_PUBLIC_ROLLUP_RPC_URL must be an absolute http(s) URL")
      .optional(),
    rollupWsUrl: wsUrl("NEXT_PUBLIC_ROLLUP_WS_URL").optional(),
    rollupPrivateUrl: z
      .string()
      .url("NEXT_PUBLIC_ROLLUP_PRIVATE_URL must be an absolute http(s) URL")
      .optional(),
    orderbookProgramId: z.string().min(32).max(44).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.tradingMode !== "rollup") return;
    for (const [field, name] of [
      ["rollupRpcUrl", "NEXT_PUBLIC_ROLLUP_RPC_URL"],
      ["rollupWsUrl", "NEXT_PUBLIC_ROLLUP_WS_URL"],
      ["rollupPrivateUrl", "NEXT_PUBLIC_ROLLUP_PRIVATE_URL"],
    ] as const) {
      if (!value[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name} is required in rollup mode`,
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

function readEnv(): Env {
  const result = envSchema.safeParse({
    simUrl: process.env.NEXT_PUBLIC_SIM_URL,
    simWsUrl: process.env.NEXT_PUBLIC_SIM_WS_URL,
    tradingMode: process.env.NEXT_PUBLIC_TRADING_MODE || "dev",
    networkLabel: process.env.NEXT_PUBLIC_NETWORK_LABEL || "TEST NETWORK",
    rollupRpcUrl: process.env.NEXT_PUBLIC_ROLLUP_RPC_URL || undefined,
    rollupWsUrl: process.env.NEXT_PUBLIC_ROLLUP_WS_URL || undefined,
    rollupPrivateUrl: process.env.NEXT_PUBLIC_ROLLUP_PRIVATE_URL || undefined,
    orderbookProgramId: process.env.NEXT_PUBLIC_ORDERBOOK_PROGRAM_ID || undefined,
  });
  if (!result.success) {
    const reasons = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid terminal configuration:\n${reasons.join("\n")}`);
  }
  return result.data;
}

export const env = readEnv();
