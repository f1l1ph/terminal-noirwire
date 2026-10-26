import { afterEach, describe, expect, it, vi } from "vitest";
import { contentSecurityPolicy } from "@/lib/csp";

function connectSources(): string[] {
  const directive = contentSecurityPolicy("n")
    .split("; ")
    .find((entry) => entry.startsWith("connect-src "));
  return (directive ?? "").split(" ").slice(1);
}

afterEach(() => vi.unstubAllEnvs());

describe("connect-src", () => {
  it("on mainnet is the sim origins plus exactly the pinned rollup origins", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    vi.stubEnv("NEXT_PUBLIC_SIM_URL", "https://book.noirwire.com");
    vi.stubEnv("NEXT_PUBLIC_SIM_WS_URL", "wss://book.noirwire.com/v1/stream");
    vi.stubEnv("NEXT_PUBLIC_ROLLUP_RPC_URL", "");
    vi.stubEnv("NEXT_PUBLIC_ROLLUP_WS_URL", "");
    expect(connectSources()).toEqual([
      "'self'",
      "https://book.noirwire.com",
      "wss://book.noirwire.com/v1/stream",
      "https://mainnet-tee.magicblock.app",
      "wss://mainnet-tee.magicblock.app",
    ]);
  });

  it("on mainnet adds exactly the Solana RPC origin, never its path or key", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    vi.stubEnv("NEXT_PUBLIC_SIM_URL", "https://book.noirwire.com");
    vi.stubEnv("NEXT_PUBLIC_SIM_WS_URL", "wss://book.noirwire.com/v1/stream");
    vi.stubEnv("NEXT_PUBLIC_ROLLUP_RPC_URL", "");
    vi.stubEnv("NEXT_PUBLIC_ROLLUP_WS_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_RPC_URL", "https://rpc.example.com/v1?api-key=abc123");
    expect(connectSources()).toEqual([
      "'self'",
      "https://book.noirwire.com",
      "wss://book.noirwire.com/v1/stream",
      "https://mainnet-tee.magicblock.app",
      "wss://mainnet-tee.magicblock.app",
      "https://rpc.example.com",
    ]);
  });

  it("opens nothing for a Solana RPC URL that does not parse", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    vi.stubEnv("NEXT_PUBLIC_SIM_URL", "https://book.noirwire.com");
    vi.stubEnv("NEXT_PUBLIC_SIM_WS_URL", "wss://book.noirwire.com/v1/stream");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_RPC_URL", "not a url");
    expect(connectSources()).toHaveLength(5);
  });

  it("pins the rollup origins for a near-miss network name too", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "Mainnet");
    vi.stubEnv("NEXT_PUBLIC_SIM_URL", "https://book.noirwire.com");
    vi.stubEnv("NEXT_PUBLIC_SIM_WS_URL", "wss://book.noirwire.com/v1/stream");
    vi.stubEnv("NEXT_PUBLIC_ROLLUP_RPC_URL", "https://attacker.example");
    vi.stubEnv("NEXT_PUBLIC_ROLLUP_WS_URL", "");
    expect(connectSources()).not.toContain("https://attacker.example");
  });

  it("on a test build is the sim origins plus the configured overrides", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "");
    vi.stubEnv("NEXT_PUBLIC_SIM_URL", "http://localhost:4100");
    vi.stubEnv("NEXT_PUBLIC_SIM_WS_URL", "ws://localhost:4100/v1/stream");
    vi.stubEnv("NEXT_PUBLIC_ROLLUP_RPC_URL", "https://devnet-tee.magicblock.app");
    vi.stubEnv("NEXT_PUBLIC_ROLLUP_WS_URL", "wss://devnet-tee.magicblock.app");
    expect(connectSources()).toEqual([
      "'self'",
      "http://localhost:4100",
      "ws://localhost:4100/v1/stream",
      "https://devnet-tee.magicblock.app",
      "wss://devnet-tee.magicblock.app",
    ]);
  });
});
