import type { TimeProvider } from "../core/di/types";

export class MockTimeProvider implements TimeProvider {
  private current = 0;
  private tickLength: number;

  constructor(tickLength = 16) {
    this.tickLength = tickLength;
  }

  now(): number {
    return this.current;
  }

  getTickLength(): number {
    return this.tickLength;
  }

  setTickLength(ms: number): void {
    this.tickLength = ms;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
