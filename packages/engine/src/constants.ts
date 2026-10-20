import { NR } from "./nums";

export const DESIRED_FPS = 60;
export const TICK_MS_INTERVAL = 1000.0 / DESIRED_FPS;
export const MOVING_AVG_WINDOW = 200;
export const ZERO = NR(0);

/** Default budget of `Engine.tick()`, in game ms per call: covers a hidden tab woken once a minute. */
export const MAX_CATCHUP_MS_PER_TICK = 60_000;
/** Cap of `Engine.simulateOffline()`. */
export const MAX_OFFLINE_MS = 24 * 60 * 60 * 1000;
