/**
 * The clock of the OP of the map: while a request runs, Date stands still at
 * the time of the premises, as it does in the tests that fake Date
 * (`vi.useFakeTimers({ toFake: ['Date'] })`), so the codes and tokens of the
 * premises are neither expired nor issued in the future. The OP runs one
 * request at a time (alone in a worker of the page, or one call at a time in
 * Node), so the Date of the global scope is its own while it runs.
 */

/** Run with Date stopped at a time (Unix milliseconds), and give Date back after. */
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
