// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import type {
  DashboardSummary,
  DashboardTokenSummary,
  TokenMinute,
} from '../../src/dashboard/types.js';

afterEach(() => {
  window.dispatchEvent(new Event('beforeunload'));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

test('the three-hour page ranks complete blocks and renders honest coverage with bounded history clicks', async () => {
  vi.useFakeTimers();
  vi.resetModules();
  document.documentElement.innerHTML = readFileSync('src/dashboard/web/index.html', 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(
      '<link rel="stylesheet" href="/styles.css" />',
      `<style>${readFileSync('src/dashboard/web/styles.css', 'utf8')}</style>`,
    );
  const token = (symbol: string, digit: string): DashboardTokenSummary => {
    const metric = {
      available: true,
      txCount: 10,
      swapCount: 10,
      usdMicros: '1000000',
      reasons: [],
      startSec: 479,
      endSec: 779,
    };
    return {
      symbol,
      address: `0x${digit.repeat(40)}`,
      category: 'rwa',
      poolCount: 1,
      activePoolCount: { '1m': 1, '5m': 1, '15m': 1, '1h': 1 },
      windows: {
        '1m': { current: metric, previous: metric },
        '5m': { current: metric, previous: metric },
        '15m': { current: metric, previous: metric },
        '1h': { current: metric, previous: metric },
      },
    };
  };
  const partial = token('A_PARTIAL', '1'),
    full = token('Z_FULL', '2'),
    unpriced = token('U_UNPRICED', '3');
  const base: DashboardSummary = {
    apiVersion: 2,
    generation: 'g1',
    refreshing: false,
    status: 'ok',
    generatedAtMs: 780000,
    sourceChainTimeSec: 780,
    selectedEndSec: 779,
    availableFromSec: 0,
    sourceHash: 'fixture',
    scopeId: 'fixture',
    assetVersion: 'fixture',
    tokens: [partial, full, unpriced],
    coverage: [],
    health: {
      status: 'unavailable',
      updatedAtMs: null,
      headLagBlocks: null,
      headLagSeconds: null,
      coverage: null,
    },
    message: null,
    notes: [],
  };
  const series = (t: DashboardTokenSummary): TokenMinute[] =>
    Array.from(
      { length: 13 },
      (_, i) =>
        ({
          minuteStartSec: i * 60,
          status: 'closed',
          txCount: t === partial ? 100 : t === full ? 2 : 1,
          swapCount: 1,
          usdMicros: t === unpriced ? null : '1000000',
          reasons: [],
        }) satisfies TokenMinute,
    ).filter((m) => t !== partial || m.minuteStartSec !== 240);
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (path: string) => {
    requests.push(path);
    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/api/snapshot')
      return Response.json({
        ...base,
        selectedEndSec: url.searchParams.has('at')
          ? Number(url.searchParams.get('at'))
          : base.selectedEndSec,
      });
    if (url.pathname === '/api/history')
      return Response.json({
        generation: 'g1',
        minutes: Number(url.searchParams.get('minutes')),
        tokens: base.tokens.map((t) => ({ address: t.address, minutes: series(t) })),
      });
    throw new Error(`Unexpected dashboard request: ${path}`);
  });
  await import('../../src/dashboard/web/app.js');
  await vi.advanceTimersByTimeAsync(0);
  document.querySelector<HTMLButtonElement>('[data-horizon="180"]')!.click();
  await vi.advanceTimersByTimeAsync(0);
  const row = (symbol: string) =>
    [...document.querySelectorAll('.heat-row')].find(
      (r) => r.querySelector('.heat-name')?.textContent === symbol,
    )!;
  const cell = (symbol: string, at: number) =>
    row(symbol).querySelector<HTMLButtonElement>(`[data-at="${at}"]`)!;
  expect([...document.querySelectorAll('.heat-name')].map((n) => n.textContent)).toEqual([
    'Z_FULL',
    'U_UNPRICED',
    'A_PARTIAL',
  ]);
  expect(cell('A_PARTIAL', 599).classList.contains('gap')).toBe(true);
  expect(cell('A_PARTIAL', 599).title).toContain('历史数据不完整');
  expect(cell('A_PARTIAL', 599).title).toContain('已观测 900 笔');
  expect(cell('A_PARTIAL', 599).title).toContain('缺少分钟证据');
  expect(cell('Z_FULL', 599).classList.contains('h4')).toBe(true);
  expect(cell('Z_FULL', 1199).classList.contains('partial')).toBe(true);
  expect(cell('Z_FULL', 1199).title).toContain('进行中');
  expect(cell('Z_FULL', 1199).disabled).toBe(true);
  expect(cell('Z_FULL', -1).disabled).toBe(true);
  const requestCount = requests.length;
  cell('Z_FULL', 1199).click();
  await vi.advanceTimersByTimeAsync(0);
  expect(requests).toHaveLength(requestCount);
  document.querySelector<HTMLButtonElement>('[data-metric="amount"]')!.click();
  expect(cell('U_UNPRICED', 599).classList.contains('unpriced')).toBe(true);
  expect(cell('U_UNPRICED', 599).title).toContain('未计价');
  expect(cell('A_PARTIAL', 599).title).toContain('已观测 USDG');
  expect(cell('A_PARTIAL', 599).disabled).toBe(false);
  cell('A_PARTIAL', 599).click();
  await vi.advanceTimersByTimeAsync(0);
  expect(requests).toContain('/api/snapshot?at=599');
  expect(document.querySelector('#notice')!.textContent).toContain('历史回看');
  document.querySelector<HTMLButtonElement>('[data-horizon="30"]')!.click();
  expect(cell('Z_FULL', 779).disabled).toBe(false);
  expect(cell('U_UNPRICED', 779).classList.contains('unpriced')).toBe(true);
  expect(cell('Z_FULL', 839).disabled).toBe(true);
});
