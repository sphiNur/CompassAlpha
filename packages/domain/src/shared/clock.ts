/**
 * Injectable clock. Tests pass a fixed instant; production passes Date.now().
 * Domain code never calls Date.now() / new Date() directly.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(at: Date): Clock {
  return { now: () => new Date(at) };
}
