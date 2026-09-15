import { expect, test, vi } from 'vitest';
import { RateLimiter } from '../../src/rpc/rate-limit.js';

test('server 429 reduces later throughput while retaining configured ceiling', async () => {
  const limiter = new RateLimiter(5);
  const times: number[] = [];
  await limiter.acquire();
  times.push(Date.now());
  limiter.penalize();
  const work = Promise.all([
    limiter.acquire().then(() => times.push(Date.now())),
    limiter.acquire().then(() => times.push(Date.now())),
  ]);
  await work;
  // The cooldown holds the next slot back, and the slot after that is still spaced wider than
  // the configured 200ms ceiling, so one 429 keeps reducing throughput instead of being ignored.
  expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(990);
  expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(390);
  expect(times[2]! - times[1]!).toBeGreaterThan(Math.ceil(1000 / 5));
});

test('recovery after six 429s stays bounded and returns to the configured interval', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  try {
    const limiter = new RateLimiter(5);
    for (let i = 0; i < 6; i++) limiter.penalize();
    const work = (async () => {
      for (let i = 0; i < 15; i++) {
        await limiter.acquire();
        limiter.succeed();
      }
    })();
    await vi.runAllTimersAsync();
    await work;
    expect(Date.now()).toBeLessThanOrEqual(45000);
    expect(limiter.state().effectiveIntervalMs).toBe(200);
  } finally {
    vi.useRealTimers();
  }
});

test('a cooldown delays the next slot while commits use only the effective interval', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  try {
    const limiter = new RateLimiter(5);
    limiter.penalize();
    expect(limiter.state()).toMatchObject({
      effectiveIntervalMs: 400,
      cooldownUntilMs: 1000,
      consecutiveSuccesses: 0,
    });
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const slot = limiter.acquire().then(() => times.push(Date.now()));
      await vi.runAllTimersAsync();
      await slot;
    }
    // 1000 is the cooldown; the following slots add the 400ms effective interval, not the
    // 30s maximum cooldown delay.
    expect(times).toEqual([1000, 1400, 1800]);
  } finally {
    vi.useRealTimers();
  }
});

test('a sustained idle stretch relaxes the curve', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  try {
    const limiter = new RateLimiter(5);
    for (let i = 0; i < 3; i++) limiter.penalize();
    expect(limiter.state().effectiveIntervalMs).toBe(1600);
    vi.setSystemTime(70000);
    const idle = limiter.acquire().then(() => Date.now());
    await vi.runAllTimersAsync();
    expect(await idle).toBe(70000);
    expect(limiter.state().effectiveIntervalMs).toBe(200);
  } finally {
    vi.useRealTimers();
  }
});

test('an unexpired explicit defer survives relaxation and success', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  try {
    const limiter = new RateLimiter(5);
    limiter.penalize();
    limiter.defer(90000);
    vi.setSystemTime(61000);
    limiter.succeed();
    limiter.succeed();
    limiter.succeed();
    const waited = limiter.acquire().then(() => Date.now());
    await vi.runAllTimersAsync();
    // Neither the idle relaxation nor the success streak may pull the explicit defer forward.
    expect(await waited).toBe(90000);
    expect(limiter.state().effectiveIntervalMs).toBe(200);
  } finally {
    vi.useRealTimers();
  }
});

test('a fresh 429 after recovery re-tightens the interval and resets the streak', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  try {
    const limiter = new RateLimiter(5);
    limiter.penalize();
    for (let i = 0; i < 15; i++) limiter.succeed();
    expect(limiter.state()).toMatchObject({
      effectiveIntervalMs: 200,
      consecutiveSuccesses: 0,
    });
    limiter.penalize();
    expect(limiter.state()).toMatchObject({
      effectiveIntervalMs: 400,
      consecutiveSuccesses: 0,
    });
    const waited = limiter.acquire().then(() => Date.now());
    await vi.runAllTimersAsync();
    expect(await waited).toBeGreaterThanOrEqual(1000);
  } finally {
    vi.useRealTimers();
  }
});

test('a sub-half-hertz ceiling is never accelerated by the two second cap', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  try {
    const limiter = new RateLimiter(0.4);
    expect(limiter.state().effectiveIntervalMs).toBe(2500);
    for (let i = 0; i < 6; i++) limiter.penalize();
    expect(limiter.state().effectiveIntervalMs).toBe(2500);
    for (let i = 0; i < 15; i++) {
      limiter.succeed();
      expect(limiter.state().effectiveIntervalMs).toBe(2500);
    }
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const slot = limiter.acquire().then(() => times.push(Date.now()));
      await vi.runAllTimersAsync();
      await slot;
    }
    expect(times).toEqual([30000, 32500, 35000]);
  } finally {
    vi.useRealTimers();
  }
});

test('dispatch with an additional limiter satisfies both ceilings', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  try {
    const limiter = new RateLimiter(5);
    const backfill = new RateLimiter(1);
    backfill.penalize();
    expect(backfill.state().effectiveIntervalMs).toBe(2000);
    const times: number[] = [];
    for (let i = 0; i < 2; i++) {
      const slot = limiter
        .acquire(undefined, undefined, backfill)
        .then(() => times.push(Date.now()));
      await vi.runAllTimersAsync();
      await slot;
    }
    expect(times).toEqual([1000, 3000]);
  } finally {
    vi.useRealTimers();
  }
});

test('concurrent occupancy serializes transports and a double release is inert', async () => {
  const limiter = new RateLimiter(10000, 1);
  const releaseFirst = await limiter.enter();
  let secondAcquired = false;
  const second = limiter.enter().then((release) => {
    secondAcquired = true;
    return release;
  });
  let thirdAcquired = false;
  const third = limiter.enter().then((release) => {
    thirdAcquired = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 1));
  expect(secondAcquired).toBe(false);
  expect(thirdAcquired).toBe(false);
  releaseFirst();
  releaseFirst();
  const releaseSecond = await second;
  expect(secondAcquired).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 1));
  // The second release was inert, so only one slot exists and the third waiter is still queued.
  expect(thirdAcquired).toBe(false);
  releaseSecond();
  const releaseThird = await third;
  expect(thirdAcquired).toBe(true);
  releaseThird();
});
