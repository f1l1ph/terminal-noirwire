/**
 * Steers e2e/fake-sim/server.mts from the test process, over its own
 * control channel (`/__control/*`), never through the page. Everything the
 * page itself fetches still goes the real way, straight to this server's
 * public and dev routes.
 */
export const FAKE_SIM_PORT = 4200;
export const FAKE_SIM_URL = `http://127.0.0.1:${FAKE_SIM_PORT}`;
export const FAKE_SIM_WS_URL = `ws://127.0.0.1:${FAKE_SIM_PORT}/v1/stream`;

async function control(name: string): Promise<void> {
  const response = await fetch(`${FAKE_SIM_URL}/__control/${name}`, { method: "POST" });
  if (!response.ok) throw new Error(`The fake sim refused "${name}" (${response.status}).`);
}

export const fakeSim = {
  /** Back to three fresh markets, no traders, nothing recorded. */
  reset: () => control("reset"),
  /** Closes every open websocket and refuses new ones, until reconnect(). */
  disconnect: () => control("disconnect"),
  reconnect: () => control("reconnect"),
};
