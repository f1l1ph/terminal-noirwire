import { z } from "zod";

/**
 * Every value the terminal needs to reach the simulation service, read once
 * at module load. A missing or malformed URL throws here, which fails the
 * build and refuses to start the dev server, rather than shipping a terminal
 * that silently reaches nothing.
 */
const envSchema = z.object({
  simUrl: z.string().url("NEXT_PUBLIC_SIM_URL must be an absolute http(s) URL"),
  simWsUrl: z
    .string()
    .url("NEXT_PUBLIC_SIM_WS_URL must be an absolute ws(s) URL")
    .refine((value) => value.startsWith("ws://") || value.startsWith("wss://"), {
      message: "NEXT_PUBLIC_SIM_WS_URL must start with ws:// or wss://",
    }),
  tradingMode: z.enum(["dev", "rollup"]),
  networkLabel: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

function readEnv(): Env {
  const result = envSchema.safeParse({
    simUrl: process.env.NEXT_PUBLIC_SIM_URL,
    simWsUrl: process.env.NEXT_PUBLIC_SIM_WS_URL,
    tradingMode: process.env.NEXT_PUBLIC_TRADING_MODE || "dev",
    networkLabel: process.env.NEXT_PUBLIC_NETWORK_LABEL || "TEST NETWORK",
  });
  if (!result.success) {
    const reasons = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid terminal configuration:\n${reasons.join("\n")}`);
  }
  return result.data;
}

export const env = readEnv();
