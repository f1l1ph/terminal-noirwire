import { readEnv } from "./envConfig";

/** The terminal's validated configuration, read once at module load. */
export const env = readEnv();
