import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPoller, JITTER_FRACTION, nextDelayMs } from '../../src/poller.js';

const INTERVAL = 30_000;
const MAX_STALENESS = 120_000;
const CAP = MAX_STALENESS / 2;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A tick that records when it ran and how many ran at once. */
function recorder(results: (boolean | Error)[] = [], durationMs = 0) {
  const starts: number[] = [];
  let active = 0;
  let maxActive = 0;
  let index = 0;
  const tick = vi.fn(async (): Promise<boolean> => {
    starts.push(Date.now());
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (durationMs > 0) await new Promise((resolve) => setTimeout(resolve, durationMs));
      const result = results[Math.min(index, results.length - 1)] ?? false;
      index += 1;
      if (result instanceof Error) throw result;
      return result;
    } finally {
      active -= 1;
    }
  });
  return { tick, starts, maxActive: () => maxActive };
}

function poller(tick: () => Promise<boolean>, overrides: { random?: () => number } = {}) {
  return createPoller({ intervalMs: INTERVAL, maxStalenessMs: MAX_STALENESS, tick, random: () => 0, ...overrides });
}

describe('nextDelayMs', () => {
  it('is the plain interval with no failures and no jitter', () => {
    expect(nextDelayMs(0, INTERVAL, MAX_STALENESS, () => 0)).toBe(INTERVAL);
  });

  it('adds jitter of up to 10 percent', () => {
    expect(nextDelayMs(0, INTERVAL, MAX_STALENESS, () => 0.5)).toBeCloseTo(INTERVAL * 1.05);
    const nearTop = nextDelayMs(0, INTERVAL, MAX_STALENESS, () => 0.999999);
    expect(nearTop).toBeGreaterThan(INTERVAL * 1.099);
    expect(nearTop).toBeLessThan(INTERVAL * (1 + JITTER_FRACTION));
  });

  it('stays within the jitter bounds for any random value', () => {
    for (let r = 0; r < 1; r += 0.05) {
      const delay = nextDelayMs(0, INTERVAL, MAX_STALENESS, () => r);
      expect(delay).toBeGreaterThanOrEqual(INTERVAL);
      expect(delay).toBeLessThan(INTERVAL * 1.1);
    }
  });

  it('doubles per consecutive failing tick', () => {
    const delays = [0, 1].map((failures) => nextDelayMs(failures, 10_000, 1_000_000, () => 0));
    expect(delays).toEqual([10_000, 20_000]);
    expect(nextDelayMs(2, 10_000, 1_000_000, () => 0)).toBe(40_000);
    expect(nextDelayMs(3, 10_000, 1_000_000, () => 0)).toBe(80_000);
  });

  it('caps the backoff at half of maxStalenessMs', () => {
    expect(nextDelayMs(2, INTERVAL, MAX_STALENESS, () => 0)).toBe(CAP);
    expect(nextDelayMs(50, INTERVAL, MAX_STALENESS, () => 0)).toBe(CAP);
    expect(nextDelayMs(10_000, INTERVAL, MAX_STALENESS, () => 0)).toBe(CAP);
  });

  it('applies jitter on top of the cap', () => {
    expect(nextDelayMs(9, INTERVAL, MAX_STALENESS, () => 0.5)).toBeCloseTo(CAP * 1.05);
  });

  it('never waits less than the interval when maxStalenessMs is exactly twice it', () => {
    expect(nextDelayMs(5, INTERVAL, INTERVAL * 2, () => 0)).toBe(INTERVAL);
  });
});

describe('createPoller: schedule', () => {
  it('runs one check immediately on start and resolves after it finishes', async () => {
    const { tick } = recorder([false], 50);
    const p = poller(tick);
    let started = false;
    const done = p.start().then(() => (started = true));
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(started).toBe(true);
    await p.stop();
  });

  it('then checks again once per interval', async () => {
    const { tick, starts } = recorder([false]);
    const p = poller(tick);
    const t0 = Date.now();
    await p.start();
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(tick).toHaveBeenCalledTimes(5);
    expect(starts.map((s) => s - t0)).toEqual([0, INTERVAL, INTERVAL * 2, INTERVAL * 3, INTERVAL * 4]);
    await p.stop();
  });

  it('uses the jittered delay for the schedule', async () => {
    const { tick } = recorder([false]);
    const p = poller(tick, { random: () => 0.5 });
    await p.start();
    await vi.advanceTimersByTimeAsync(INTERVAL * 1.05 - 1);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(tick).toHaveBeenCalledTimes(2);
    await p.stop();
  });

  it('starts counting the interval after a slow tick finishes', async () => {
    const { tick, starts } = recorder([false], 10_000);
    const p = poller(tick);
    const t0 = Date.now();
    const started = p.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await started;
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(starts.map((s) => s - t0)).toEqual([0, 10_000 + INTERVAL]);
    // Let the second slow tick finish so stop() has nothing left to wait for.
    await vi.advanceTimersByTimeAsync(10_000);
    await p.stop();
  });
});

describe('createPoller: backoff', () => {
  it('doubles the wait for each consecutive all-failed tick, then holds at the cap', async () => {
    const { tick, starts } = recorder([true]);
    const p = poller(tick);
    const t0 = Date.now();
    await p.start();
    await vi.advanceTimersByTimeAsync(INTERVAL * 2 + CAP * 3);
    // Waits after failing ticks: 60000 (2x), then capped at 60000 each time.
    expect(starts.map((s) => s - t0)).toEqual([0, 60_000, 120_000, 180_000, 240_000]);
    await p.stop();
  });

  it('doubles step by step when the cap is far away', async () => {
    const tick = recorder([true]);
    const p = createPoller({ intervalMs: 5_000, maxStalenessMs: 10_000_000, tick: tick.tick, random: () => 0 });
    const t0 = Date.now();
    await p.start();
    await vi.advanceTimersByTimeAsync(10_000 + 20_000 + 40_000 + 80_000);
    expect(tick.starts.map((s) => s - t0)).toEqual([0, 10_000, 30_000, 70_000, 150_000]);
    await p.stop();
  });

  it('returns to the plain interval after a tick that succeeds', async () => {
    const { tick, starts } = recorder([true, true, false]);
    const p = poller(tick);
    const t0 = Date.now();
    await p.start();
    await vi.advanceTimersByTimeAsync(CAP * 2 + INTERVAL * 2);
    expect(starts.map((s) => s - t0)).toEqual([0, 60_000, 120_000, 120_000 + INTERVAL, 120_000 + INTERVAL * 2]);
    await p.stop();
  });

  it('treats a tick that throws as a failing tick and keeps going', async () => {
    const { tick, starts } = recorder([new Error('boom'), false]);
    const p = poller(tick);
    const t0 = Date.now();
    await p.start();
    await vi.advanceTimersByTimeAsync(CAP + INTERVAL);
    expect(starts.map((s) => s - t0)).toEqual([0, 60_000, 60_000 + INTERVAL]);
    await p.stop();
  });
});

describe('createPoller: overlap and restart', () => {
  it('never runs two ticks at once, even when a tick outlasts the interval', async () => {
    const { tick, starts, maxActive } = recorder([false], INTERVAL * 3);
    const p = poller(tick);
    const started = p.start();
    await vi.advanceTimersByTimeAsync(INTERVAL * 20);
    await started;
    expect(maxActive()).toBe(1);
    // Each tick takes 3 intervals and the next begins one interval after it ends: every 4 intervals.
    expect(starts.length).toBe(Math.floor((INTERVAL * 20) / (INTERVAL * 4)) + 1);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    await p.stop();
  });

  it('does not start a new tick beside an old one after stop and start', async () => {
    const { tick, maxActive } = recorder([false], 5_000);
    const p = poller(tick);
    const first = p.start();
    await vi.advanceTimersByTimeAsync(1_000);
    const stopping = p.stop();
    const second = p.start();
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all([first, stopping, second]);
    expect(maxActive()).toBe(1);
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2);
    await p.stop();
  });

  it('keeps a single schedule after stop and start', async () => {
    const { tick } = recorder([false]);
    const p = poller(tick);
    await p.start();
    await p.stop();
    await p.start();
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    await p.stop();
  });
});

describe('createPoller: start and stop', () => {
  it('ignores a second start', async () => {
    const { tick } = recorder([false]);
    const p = poller(tick);
    const first = p.start();
    const second = p.start();
    expect(second).toBe(first);
    await first;
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await p.stop();
  });

  it('stops scheduling and clears the timer', async () => {
    const { tick } = recorder([false]);
    const p = poller(tick);
    await p.start();
    expect(vi.getTimerCount()).toBe(1);
    await p.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(INTERVAL * 10);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('waits for a tick that is in flight before stop resolves', async () => {
    const { tick } = recorder([false], 10_000);
    const p = poller(tick);
    const started = p.start();
    await vi.advanceTimersByTimeAsync(2_000);
    let stopped = false;
    const stopping = p.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(7_999);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    await started;
    expect(stopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('does not schedule anything when stopped during the first tick', async () => {
    const { tick } = recorder([false], 1_000);
    const p = poller(tick);
    const started = p.start();
    const stopping = p.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([started, stopping]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is safe to stop before starting and to stop twice', async () => {
    const { tick } = recorder([false]);
    const p = poller(tick);
    await p.stop();
    await p.start();
    await p.stop();
    await p.stop();
    expect(tick).toHaveBeenCalledTimes(1);
  });
});

describe('createPoller: timers', () => {
  it('unrefs Node timers so the poller never keeps a process alive', async () => {
    const unref = vi.fn();
    vi.stubGlobal(
      'setTimeout',
      vi.fn(() => ({ unref })),
    );
    const { tick } = recorder([false]);
    const p = poller(tick);
    await p.start();
    expect(unref).toHaveBeenCalledTimes(1);
    vi.stubGlobal('clearTimeout', vi.fn());
    await p.stop();
  });

  it('works when the timer handle is a number, as in browsers', async () => {
    vi.stubGlobal(
      'setTimeout',
      vi.fn(() => 7),
    );
    const clear = vi.fn();
    vi.stubGlobal('clearTimeout', clear);
    const { tick } = recorder([false]);
    const p = poller(tick);
    await p.start();
    await p.stop();
    expect(clear).toHaveBeenCalledWith(7);
  });

  it('uses Math.random for jitter by default', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const { tick } = recorder([false]);
    const p = createPoller({ intervalMs: INTERVAL, maxStalenessMs: MAX_STALENESS, tick });
    await p.start();
    expect(random).toHaveBeenCalled();
    await p.stop();
    random.mockRestore();
  });
});
