import { expect, test } from 'vitest';
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
  expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(990);
  expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(990);
});
