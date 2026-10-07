/** Jitter added to every wait, as a fraction of the wait. The wait grows by 0 to this much. */
export const JITTER_FRACTION = 0.1;

/** The backoff exponent stops growing here; the cap on the wait applies long before this matters. */
const MAX_BACKOFF_EXPONENT = 30;

/**
 * How long to wait before the next tick.
 * The base wait is `intervalMs` doubled once per consecutive failing tick, capped at half of
 * `maxStalenessMs` so staleness is still noticed on time. Jitter of up to 10 percent is added on top
 * of the capped base, so the real wait is at most 1.1 times the cap. `random` returns a number in [0, 1).
 */
export function nextDelayMs(
  failingTicks: number,
  intervalMs: number,
  maxStalenessMs: number,
  random: () => number,
): number {
  const cap = maxStalenessMs / 2;
  const base = Math.min(intervalMs * 2 ** Math.min(failingTicks, MAX_BACKOFF_EXPONENT), cap);
  return base * (1 + JITTER_FRACTION * random());
}

export interface PollerOptions {
  intervalMs: number;
  maxStalenessMs: number;
  /**
   * Performs one check of every contract and applies the results. Resolves to true when every
   * contract's lookup failed, which makes the poller back off. A rejection counts as a failure.
   */
  tick: () => Promise<boolean>;
  /** Source of jitter in [0, 1). Defaults to `Math.random`. */
  random?: () => number;
}

export interface Poller {
  /** Runs one check immediately, then keeps checking. Resolves once that first check is done. */
  start(): Promise<void>;
  /** Cancels the timer and waits for a check that is already running to finish. */
  stop(): Promise<void>;
}

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Schedules `tick` as a chain of timeouts: the next timer is only armed after the current tick has
 * finished, so two ticks never overlap. Timers are unref'd on Node so the poller alone never keeps
 * a process alive.
 */
export function createPoller(options: PollerOptions): Poller {
  const random = options.random ?? Math.random;
  let running = false;
  let generation = 0;
  let failingTicks = 0;
  let timer: TimerHandle | undefined;
  let inFlight: Promise<void> | undefined;
  let startPromise: Promise<void> | undefined;

  function runTick(): Promise<void> {
    const run = (async () => {
      let allFailed: boolean;
      try {
        allFailed = await options.tick();
      } catch {
        allFailed = true;
      }
      failingTicks = allFailed ? failingTicks + 1 : 0;
    })();
    inFlight = run;
    void run.then(() => {
      if (inFlight === run) inFlight = undefined;
    });
    return run;
  }

  function schedule(owner: number): void {
    const delay = nextDelayMs(failingTicks, options.intervalMs, options.maxStalenessMs, random);
    const handle = setTimeout(() => {
      timer = undefined;
      // A stop, or a stop followed by a start, makes this chain obsolete.
      if (!running || owner !== generation) return;
      void runTick().then(() => {
        if (running && owner === generation) schedule(owner);
      });
    }, delay);
    if (typeof handle === 'object' && typeof handle.unref === 'function') handle.unref();
    timer = handle;
  }

  return {
    start(): Promise<void> {
      if (running && startPromise !== undefined) return startPromise;
      running = true;
      generation += 1;
      const owner = generation;
      failingTicks = 0;
      startPromise = (async () => {
        // A tick from before a stop may still be running. Never start a second one beside it.
        if (inFlight !== undefined) await inFlight;
        if (!running || owner !== generation) return;
        await runTick();
        if (running && owner === generation) schedule(owner);
      })();
      return startPromise;
    },

    async stop(): Promise<void> {
      running = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      while (inFlight !== undefined) await inFlight;
    },
  };
}
