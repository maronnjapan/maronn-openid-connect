/**
 * The clock of a workspace's OP: the real one, moved on by the seconds a
 * page asked it to be (`POST /__live/clock`), so a reader can see what a
 * code, a token or a device code does once it has expired without waiting
 * for it. While a request of a workspace whose clock was moved runs, Date
 * is a Date whose present is that much later; one is run at a time
 * (isolation.ts), so the Date of the global scope is its own.
 */

/** Run with Date's present moved on by some milliseconds, and give Date back after. */
export async function withClockOffset<T>(offsetMilliseconds: number, run: () => Promise<T>): Promise<T> {
  if (offsetMilliseconds === 0) return run();
  const RealDate = globalThis.Date;
  /** A Date whose present is the real one moved on (see the module comment); a date of its own reads as it does. */
  class MovedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offsetMilliseconds);
      else super(...(args as [number]));
    }

    /** The present, moved on. */
    static override now(): number {
      return RealDate.now() + offsetMilliseconds;
    }
  }
  globalThis.Date = MovedDate as DateConstructor;
  try {
    return await run();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** Run with Date stopped at a time (Unix milliseconds), and give Date back after: the writes of a feature's store are made again at the clock they ran at. */
export async function atClock<T>(milliseconds: number, run: () => Promise<T>): Promise<T> {
  const RealDate = globalThis.Date;
  /** A Date whose present is the stopped time; a date of its own reads as it does. */
  class StoppedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(milliseconds);
      else super(...(args as [number]));
    }

    /** The stopped time. */
    static override now(): number {
      return milliseconds;
    }
  }
  globalThis.Date = StoppedDate as DateConstructor;
  try {
    return await run();
  } finally {
    globalThis.Date = RealDate;
  }
}
