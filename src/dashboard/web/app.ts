import type { DashboardSnapshot, DashboardToken, TokenMinute, WindowName } from '../types.js';
import {
  classifyHeat,
  closedMinuteStarts,
  selectableCutoff,
  minuteOverlaps,
  compareHeat,
  escapeHtml as e,
  favoriteKey,
  formatMicros,
  heatIntensity,
  type HeatInput,
  type SortMode,
} from './view-model.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const windows = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 };
let snapshot: DashboardSnapshot | null = null;
let windowName: WindowName = '5m';
let sort: SortMode = 'warming';
let page: 'overview' | 'favorites' | 'health' = 'overview';
let horizon = 30;
let relative = false;
let query = '';
let historyAt: number | null = null;
let favorites = new Set<string>();
let favoritesNamespace = '';
let selectedToken: string | null = null;
let visiblePoolCount = 20;
let transportError: string | null = null;
let pending: DashboardSnapshot | null = null;
let hovering = false;
let focused = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let activeRequest: AbortController | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let lastFocus: HTMLElement | null = null;
let expandedHeatmap = false;
const dialog = $<HTMLDialogElement>('token-dialog');
const time = (sec: number | null, withDate = false) =>
  sec === null
    ? '—'
    : new Date(sec * 1000).toLocaleString('zh-CN', {
        ...(withDate ? { month: '2-digit', day: '2-digit' } : {}),
        hour: '2-digit',
        minute: '2-digit',
        ...(withDate ? { second: '2-digit' } : {}),
        hour12: false,
      });
const number = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('zh-CN'));
const short = (a: string) => (a.length > 17 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const selectedEnd = () => snapshot?.selectedEndSec ?? null;
const closedMinutes = (t: DashboardToken) =>
  t.minutes.filter((m) => m.minuteStartSec + 59 <= (selectedEnd() ?? 0));
const heatInput = (t: DashboardToken): HeatInput => ({
  current: t.windows[windowName].current.txCount,
  previous: t.windows[windowName].previous.txCount,
  minutes: closedMinutes(t),
});
const heat = (t: DashboardToken) => classifyHeat(heatInput(t));
const badge = (t: DashboardToken) => {
  const h = heat(t);
  return `<span class="heat-badge ${h.kind}">${h.label}</span>`;
};
const reasonText: Record<string, string> = {
  'coverage-missing': '缺少覆盖证据',
  'coverage-gap': '采集覆盖不完整',
  'boundary-time-unknown': '边界交易时间不确定',
  'pool-lifetime-incomplete': '池建立前历史不足',
  'watermark-partial': '本分钟尚未完整',
  'unknown-time-window-boundary': '窗口边界时间未知',
  warming: '历史积累不足',
  'projection-stale-or-missing': '投影过期或缺失',
};
const reasons = (xs: readonly string[]) => xs.map((s) => reasonText[s] ?? s).join(' / ');

function toast(message: string) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
  }, 3000);
}
function loadFavorites() {
  const key = favoriteKey(4663, snapshot?.scopeId ?? '');
  if (key === favoritesNamespace) return;
  favoritesNamespace = key;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    favorites = new Set(
      Array.isArray(parsed)
        ? parsed.filter((a): a is string => typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/.test(a))
        : [],
    );
  } catch {
    favorites = new Set();
  }
}
function toggleFavorite(address: string) {
  if (favorites.has(address)) favorites.delete(address);
  else favorites.add(address);
  try {
    localStorage.setItem(favoritesNamespace, JSON.stringify([...favorites]));
  } catch {
    toast('浏览器未允许保存，自选仅在本次页面有效');
  }
  render();
}
function listTokens() {
  const q = query.toLowerCase().trim();
  return (snapshot?.tokens ?? []).filter(
    (t) =>
      (page !== 'favorites' || favorites.has(t.address)) &&
      (!q || t.symbol.toLowerCase().includes(q) || t.address.toLowerCase().includes(q)),
  );
}
function rankedTokens() {
  const amount = $<HTMLInputElement>('amount-sort').checked;
  return listTokens().sort((a, b) => {
    if (amount && sort === 'activity') {
      const aa = a.windows[windowName].current.usdMicros,
        bb = b.windows[windowName].current.usdMicros;
      if (aa === null || bb === null)
        return aa === bb ? a.address.localeCompare(b.address) : aa === null ? 1 : -1;
      const difference = BigInt(bb) - BigInt(aa);
      return difference > 0n ? 1 : difference < 0n ? -1 : a.address.localeCompare(b.address);
    }
    return (
      compareHeat(heatInput(a), heatInput(b), sort) ||
      a.symbol.localeCompare(b.symbol) ||
      a.address.localeCompare(b.address)
    );
  });
}
/** Split paths at unknown minutes; isolated observed points remain visible. */
function chart(values: (number | null)[], kind: string, large = false, label = '每分钟交易数趋势') {
  const width = large ? 500 : 110,
    height = large ? 105 : 30;
  const maximum = Math.max(1, ...values.filter((v): v is number => v !== null));
  const x = (i: number) => 3 + (i / Math.max(1, values.length - 1)) * (width - 6);
  const y = (v: number) => height - 4 - (v / maximum) * (height - 9);
  let paths = '',
    segment: string[] = [],
    points = '';
  const flush = () => {
    if (segment.length > 1) paths += `<path class="spark-line" d="${segment.join(' ')}"/>`;
    segment = [];
  };
  values.forEach((v, i) => {
    if (v === null) {
      flush();
      return;
    }
    segment.push(`${segment.length ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`);
    points += `<circle cx="${x(i).toFixed(2)}" cy="${y(v).toFixed(2)}" r="${large ? 1.8 : 1}" fill="currentColor"/>`;
  });
  flush();
  return `<svg class="${large ? 'detail-chart' : 'spark'} ${e(kind)}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${e(label)}；缺失分钟不连线"><path class="gap-line" d="M0 ${height - 3}H${width}"/>${paths}${points}</svg>`;
}
function trendMinutes(t: DashboardToken, count: number) {
  const starts = closedMinuteStarts(selectedEnd() ?? 0, count);
  const map = new Map(t.minutes.map((m) => [m.minuteStartSec, m]));
  return starts.map((sec) => map.get(sec) ?? null);
}
function renderStatus() {
  const s = snapshot;
  const sourceAge =
    s?.sourceChainTimeSec == null ? null : Math.max(0, Date.now() / 1000 - s.sourceChainTimeSec);
  const stale =
    sourceAge === null || sourceAge > 60 || s?.status !== 'ok' || transportError !== null;
  $('status-dot').classList.toggle('fresh', !stale);
  $('connection-text').textContent = transportError
    ? '连接异常 · 保留上次结果'
    : !s
      ? '正在连接本地数据'
      : s.status === 'empty'
        ? '等待监控数据'
        : stale
          ? '数据非实时 / 待检查'
          : '本地数据已连接';
  $('data-time').textContent = `链上数据时间 ${time(s?.sourceChainTimeSec ?? null, true)}`;
  const notice = $('notice');
  notice.classList.toggle('good', !stale && historyAt === null);
  let message = transportError ?? s?.message ?? (!s ? '正在读取监控数据库…' : '');
  if (s?.tokens.length && !transportError) {
    message =
      historyAt !== null
        ? `历史回看 · 截止 ${time(s.selectedEndSec, true)}。排行使用该时点已留存的窗口证据。`
        : `数据截止 ${time(s.sourceChainTimeSec, true)}${sourceAge !== null && sourceAge > 60 ? `，距现在 ${Math.floor(sourceAge / 60).toLocaleString()} 分钟；当前展示已录制数据。` : ' · 页面每 5 秒检查更新，统计以已采集链上时间为准。'}`;
    if (s.message) message += ` ${s.message}`;
  }
  notice.replaceChildren(
    document.createTextNode(message || '数据已连接 · 数据覆盖与窗口可用性见下方。'),
  );
  if (historyAt !== null) {
    const button = document.createElement('button');
    button.textContent = '返回实时';
    button.addEventListener('click', () => {
      historyAt = null;
      void refresh(true);
    });
    notice.append(button);
  }
  $('rank-refresh').textContent = pending ? '正在查看表格 · 更新暂缓应用' : '每 5 秒检查更新';
}
function renderStats(tokens: DashboardToken[]) {
  const known = tokens.filter((t) => t.windows[windowName].current.available);
  const active = known.filter((t) => (t.windows[windowName].current.txCount ?? 0) > 0).length;
  const warm = tokens.filter(
    (t) =>
      ['warming', 'new'].includes(heat(t).kind) &&
      (t.windows[windowName].current.txCount ?? 0) >= 10,
  ).length;
  const activePools = new Set(
    tokens.flatMap((t) =>
      t.pools.filter((p) => (p.windows[windowName]?.txCount ?? 0) > 0).map((p) => p.poolId),
    ),
  ).size;
  const end = selectedEnd();
  const selectedCoverage =
    snapshot?.coverage.filter(
      (c) => end !== null && minuteOverlaps(c.minuteStartSec, end - windows[windowName], end),
    ) ?? [];
  const complete = selectedCoverage.filter((c) => c.complete).length;
  const cards = [
    [
      '活跃代币',
      known.length ? number(active) : '—',
      `/ ${tokens.length}`,
      `${known.length} 个窗口可用 · ${tokens.length - known.length} 个未知`,
      '↗',
    ],
    ['明显升温', known.length ? number(warm) : '—', '个', `当前至少 10 笔 · 结合前一窗口`, '⌁'],
    [
      '活跃交易池',
      known.length ? number(activePools) : '—',
      '个',
      '池标识去重 · 当前筛选范围',
      '◫',
    ],
    [
      '完整覆盖分钟',
      selectedCoverage.length ? number(complete) : '—',
      `/ ${selectedCoverage.length || '—'}`,
      '完整 / 涉及分钟 · 当前分钟可能未完整',
      '◷',
    ],
  ];
  $('stats').innerHTML = cards
    .map(
      ([label, value, unit, foot, icon]) =>
        `<div class="stat"><div class="stat-label">${label}<span>${icon}</span></div><div class="stat-value">${value}<small>${unit}</small></div><div class="stat-foot">${foot}</div></div>`,
    )
    .join('');
}
function renderRanking(tokens: DashboardToken[]) {
  $('count-heading').textContent = windowName;
  $('rank-count').textContent = `${tokens.length} TOKENS`;
  $('sort-explanation').textContent = {
    warming:
      '优先展示明显升温：当前 ≥10 笔、较前窗 ≥2 倍且增加 ≥5 笔；零基线单独标注。其余按交易增量排序。',
    activity: '按当前窗口去重交易数排序。可切换 USDG 等值量；未计价数据保留在末尾。',
    sustained: '优先展示当前 ≥10 笔，且最近 5 个完整分钟至少 4 分钟有交易的代币。',
    cooling: '优先展示前窗 ≥10 笔、当前交易数下降至少 50% 的代币。',
  }[sort];
  const amount = $<HTMLInputElement>('amount-sort');
  amount.disabled = sort !== 'activity';
  amount.parentElement!.style.opacity = sort === 'activity' ? '1' : '.45';
  $('rank-body').innerHTML = tokens
    .map((t, index) => {
      const h = heat(t),
        current = t.windows[windowName].current;
      const change =
        h.changePercent === null
          ? h.kind === 'new'
            ? '新增活跃'
            : '—'
          : `${h.changePercent > 0 ? '+' : ''}${h.changePercent.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`;
      return `<tr><td><button class="star ${favorites.has(t.address) ? 'selected' : ''}" data-favorite="${e(t.address)}" aria-label="${favorites.has(t.address) ? '取消' : '添加'}自选 ${e(t.symbol)}" aria-pressed="${favorites.has(t.address)}">${favorites.has(t.address) ? '★' : '☆'}</button></td><td><div class="token-cell"><span class="rank-index">${String(index + 1).padStart(2, '0')}</span><span class="token-avatar" aria-hidden="true">${e(t.symbol.slice(0, 2))}</span><button class="token-name" data-token="${e(t.address)}">${e(t.symbol)}<small>${e(short(t.address))}</small></button></div></td><td>${badge(t)}</td><td class="numeric" title="${e(reasons(current.reasons))}">${number(current.txCount)}</td><td class="numeric ${h.delta === null || h.delta === 0 ? 'neutral' : h.delta > 0 ? 'positive' : 'negative'}">${e(change)}<small class="delta-sub">${h.delta === null ? '前窗数据不足' : `${h.delta > 0 ? '+' : ''}${number(h.delta)} 笔`}</small></td><td class="numeric" title="${current.usdMicros === null ? '估值或窗口证据不足' : 'USDG = USD 为展示假设；各股票参与量不能相加当作全市场量'}">${formatMicros(current.usdMicros)}</td><td>${chart(
        trendMinutes(t, 15).map((m) => (m?.status === 'closed' ? m.txCount : null)),
        h.kind,
      )}</td><td class="numeric neutral">${t.poolIds.length}</td></tr>`;
    })
    .join('');
  const empty = $('rank-empty');
  empty.hidden = tokens.length > 0;
  if (!tokens.length) {
    const title =
      page === 'favorites'
        ? '还没有匹配的自选代币'
        : query
          ? '没有找到匹配的代币'
          : '等待可用的监控数据';
    const desc =
      page === 'favorites'
        ? '点击榜单中的星标，将代币加入当前监控范围的自选。'
        : query
          ? '试试完整合约地址，或清空搜索条件。'
          : (snapshot?.message ?? '启动时指定已录制数据库。页面只读取数据，采集由现有 CLI 负责。');
    empty.innerHTML = `<span>⌁</span><h3>${e(title)}</h3><p>${e(desc)}</p>`;
  }
  $('table-range').textContent =
    selectedEnd() === null
      ? '暂无窗口证据'
      : `(${time(selectedEnd()! - windows[windowName])}, ${time(selectedEnd())}] · ${windowName}`;
}
function renderHeatmap() {
  const end = Math.floor((snapshot?.sourceChainTimeSec ?? 0) / 60) * 60;
  const starts = Array.from({ length: horizon }, (_, i) => end - (horizon - 1 - i) * 60);
  const peak = (t: DashboardToken) =>
    Math.max(
      0,
      ...t.minutes
        .filter((m) => m.minuteStartSec >= starts[0]!)
        .map((m) => (m.status === 'closed' ? (m.txCount ?? 0) : 0)),
    );
  const all = listTokens().sort((a, b) => peak(b) - peak(a) || a.symbol.localeCompare(b.symbol));
  const tokens = expandedHeatmap ? all : all.slice(0, 12);
  if (!tokens.length) {
    $('heatmap').innerHTML =
      '<div class="empty-state"><span>▥</span><p>有分钟证据后，会在这里显示热度轨迹。</p></div>';
    return;
  }
  const maximum = Math.max(1, ...tokens.map(peak));
  $('heatmap').innerHTML =
    tokens
      .map((t) => {
        const map = new Map(t.minutes.map((m) => [m.minuteStartSec, m]));
        const localMax = Math.max(1, peak(t));
        return `<div class="heat-row"><button class="heat-name" data-token="${e(t.address)}" title="${e(t.symbol)} ${e(t.address)}">${e(t.symbol)}</button><div class="heat-cells">${starts
          .map((sec) => {
            const m = map.get(sec),
              closed = m?.status === 'closed';
            const intensity = heatIntensity(
              closed ? m.txCount : null,
              relative ? localMax : maximum,
            );
            const cls =
              !m || m.status === 'gap' || m.status === 'warming'
                ? 'gap'
                : m.status === 'partial'
                  ? 'partial'
                  : intensity === null
                    ? 'gap'
                    : intensity === 0
                      ? ''
                      : `h${Math.max(1, Math.ceil(intensity * 4))}`;
            const caption = `${t.symbol} · ${time(sec)} · ${closed ? number(m.txCount) + ' 笔' : m?.status === 'partial' ? '分钟尚未完整' : '缺少完整数据'} · USDG 等值 ${formatMicros(m?.usdMicros ?? null)}${m?.reasons.length ? ' · ' + reasons(m.reasons) : ''}`;
            return `<button class="heat-cell ${cls} ${historyAt === sec + 59 ? 'selected' : ''}" data-at="${sec + 59}" ${!selectableCutoff(sec + 59, snapshot?.availableFromSec ?? null, snapshot?.sourceChainTimeSec ?? null) ? 'disabled' : ''} aria-label="${e(caption)}" title="${e(caption)}"></button>`;
          })
          .join('')}</div></div>`;
      })
      .join('') +
    `<div class="heat-times"><span>${time(starts[0]!)}</span><span>${time(starts[Math.floor(horizon / 2)]!)}</span><span>${time(end)}</span></div>${all.length > 12 ? `<button id="expand-heat" class="subtle">${expandedHeatmap ? '收起到最活跃 12 个' : `展开全部 ${all.length} 个代币`} ↓</button>` : ''}`;
  $('heat-caption').textContent =
    `每格 1 分钟 · ${relative ? '各代币自身峰值归一化，颜色不可跨行比' : '跨代币统一色阶'} · ${expandedHeatmap ? '全部' : '最活跃12个'}`;
  $('expand-heat')?.addEventListener('click', () => {
    expandedHeatmap = !expandedHeatmap;
    renderHeatmap();
  });
}
function renderChanges() {
  const since = (snapshot?.sourceChainTimeSec ?? 0) - horizon * 60;
  const changes: {
    t: DashboardToken;
    m: TokenMinute;
    previous: number;
    h: ReturnType<typeof classifyHeat>;
  }[] = [];
  for (const t of listTokens()) {
    const map = new Map(t.minutes.map((m) => [m.minuteStartSec, m]));
    for (const m of t.minutes) {
      const previous = map.get(m.minuteStartSec - 60);
      if (
        m.minuteStartSec < since ||
        m.minuteStartSec + 59 > (selectedEnd() ?? 0) ||
        m.status !== 'closed' ||
        previous?.status !== 'closed' ||
        m.txCount === null ||
        previous.txCount === null
      )
        continue;
      const h = classifyHeat({ current: m.txCount, previous: previous.txCount, minutes: [] });
      if (((h.kind === 'warming' || h.kind === 'new') && m.txCount >= 10) || h.kind === 'cooling')
        changes.push({ t, m, previous: previous.txCount, h });
    }
  }
  changes.sort(
    (a, b) =>
      b.m.minuteStartSec - a.m.minuteStartSec ||
      Math.abs(b.h.delta ?? 0) - Math.abs(a.h.delta ?? 0),
  );
  $('changes').innerHTML =
    changes
      .slice(0, 8)
      .map(
        ({ t, m, previous, h }) =>
          `<button class="change-item" data-at="${m.minuteStartSec + 59}"><div class="change-meta"><span class="heat-badge ${h.kind}">${h.label}</span><time class="change-time">${time(m.minuteStartSec)}</time></div><div class="change-name">${e(t.symbol)}</div><div class="change-desc">${previous} → ${number(m.txCount)} 笔 / 分钟 <span aria-hidden="true">↗</span></div></button>`,
      )
      .join('') ||
    '<div class="empty-state"><span>⌁</span><p>这段时间尚无满足阈值的可确认变化。缺失分钟不参与判断。</p></div>';
}
function renderHealth() {
  const h = snapshot?.health;
  const cards = [
    [
      '运行观测',
      h?.status === 'available' ? '可读取' : '未知',
      '未取得运行侧写时不推测采集是否运行',
    ],
    ['距观测链头', number(h?.headLagBlocks), '区块 · 来自最近一次侧写，不是实时链头'],
    [
      '链头时间差',
      h?.headLagSeconds == null ? '—' : `${number(h.headLagSeconds)} s`,
      '采集游标与观测链头的时间差',
    ],
  ];
  cards.push(
    ['待处理本机提醒', number(h?.outboxPending), '数据库中 live outbox 待处理 / 失败条目'],
    [
      '指标处理耗时',
      h?.processingLatencyMs == null ? '—' : `${number(h.processingLatencyMs)} ms`,
      '最近一次侧写样本，不是端到端延迟',
    ],
    ['已记录 RPC 调用', number(h?.rpcCalls), '运行侧写累计；没有侧写时保持未知'],
  );
  const fields: [string, string][] = [
    ['运行状态', h?.runtimeState ?? '未知'],
    [
      '运行侧写新鲜度',
      (
        { fresh: '新鲜', stale: '过期', missing: '缺失', invalid: '无效' } as Record<string, string>
      )[h?.sidecarFreshness ?? ''] ?? '未知',
    ],
    ['采集区块', h?.scannedBlock ?? '—'],
    ['已验证投影区块', h?.projectedBlock ?? '—'],
    ['数据库体积', h?.dbBytes == null ? '—' : `${(h.dbBytes / 1048576).toFixed(2)} MiB`],
    ['WAL 体积', h?.walBytes == null ? '—' : `${(h.walBytes / 1048576).toFixed(2)} MiB`],
    ['运行侧写时间', time(h?.updatedAtMs == null ? null : h.updatedAtMs / 1000, true)],
    ['运行覆盖状态', h?.coverage ?? '未知'],
    ['监控范围', snapshot?.scopeId ?? '—'],
    ['观察名单版本', snapshot?.assetVersion ?? '—'],
    ['源数据时间', time(snapshot?.sourceChainTimeSec ?? null, true)],
    ['可用历史起点', time(snapshot?.availableFromSec ?? null, true)],
    ['指标来源哈希', snapshot?.sourceHash ?? '—'],
    ['数据性质', 'provisional · USDG = USD 为展示假设'],
    ['自动刷新', '每 5 秒检查 · 鼠标或键盘正在查看榜单时暂缓重绘'],
  ];
  $('health-view').innerHTML =
    `<div class="health-grid">${cards.map(([title, value, desc]) => `<div class="health-card"><h3>${e(title)}</h3><strong>${e(value)}</strong><p>${e(desc)}</p></div>`).join('')}</div><section class="panel"><div class="panel-header"><div><span class="section-number">01</span><h2>数据来源与运行事实</h2></div></div><dl class="health-facts">${fields.map(([k, v]) => `<div class="fact"><dt>${e(k)}</dt><dd>${e(v)}</dd></div>`).join('')}</dl></section><p class="source-note">页面仅读取现有数据。要更新热度，请在终端使用同一数据库、配置与观察名单运行现有有界采集命令。运行侧写缺失或过期时，不能把旧链头差值当作当前延迟。</p>`;
}
function renderDetail() {
  const t = snapshot?.tokens.find((t) => t.address === selectedToken);
  if (!t) {
    if (dialog.open)
      $('token-detail').innerHTML =
        '<div class="empty-state"><h3>当前快照中没有此代币</h3><p>监控范围或源数据可能已变化。</p></div>';
    return;
  }
  const sortedPools = [...t.pools].sort((a, b) => {
    const aa = a.windows[windowName].txCount,
      bb = b.windows[windowName].txCount;
    return aa === null || bb === null
      ? aa === bb
        ? a.poolId.localeCompare(b.poolId)
        : aa === null
          ? 1
          : -1
      : bb - aa || a.poolId.localeCompare(b.poolId);
  });
  const current = t.windows[windowName].current,
    previous = t.windows[windowName].previous;
  const minutes = trendMinutes(t, 30),
    allReasons = [...new Set([...current.reasons, ...previous.reasons])];
  const symbol = (address: string) =>
    snapshot?.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase())?.symbol ??
    short(address);
  const usdValues = minutes.map((m) =>
    m?.status === 'closed' && m.usdMicros !== null
      ? Number(BigInt(m.usdMicros) / 10000n) / 100
      : null,
  );
  const finiteUsd = usdValues.map((v) => (v !== null && Number.isFinite(v) ? v : null));
  $('token-detail').innerHTML =
    `<div class="drawer-title"><span class="token-avatar">${e(t.symbol.slice(0, 2))}</span><div><h2 id="token-title">${e(t.symbol)}</h2><span class="muted">RWA · Robinhood Chain</span></div><button class="star ${favorites.has(t.address) ? 'selected' : ''}" data-favorite="${e(t.address)}" aria-pressed="${favorites.has(t.address)}" aria-label="切换 ${e(t.symbol)} 自选">${favorites.has(t.address) ? '★' : '☆'}</button></div><div class="contract"><code>${e(t.address)}</code><button id="copy-address">复制</button></div>${badge(t)}<p class="drawer-caption">最近 ${windowName} ${number(current.txCount)} 笔交易，前一等长窗口 ${number(previous.txCount)} 笔。</p><div class="detail-stats"><div><label>去重交易数 / SWAPS</label><strong>${number(current.txCount)}</strong><small>${number(current.swapCount)} 个 Swap 事件</small></div><div><label>USDG 等值参与量</label><strong class="amount-value">${formatMicros(current.usdMicros)}</strong><small>估值未知时保留 —</small></div></div><section class="detail-section"><h3>最近 30 分钟 · 每分钟交易数</h3>${chart(
      minutes.map((m) => (m?.status === 'closed' ? m.txCount : null)),
      'warming',
      true,
    )}<div class="chart-caption"><span>${time((selectedEnd() ?? 0) - 1800)}</span><span>缺失分钟断开，不补零</span><span>${time(selectedEnd())}</span></div><h3>每分钟 USDG 等值参与量</h3>${chart(finiteUsd, 'warming', true, '每分钟 USDG 等值量')}<div class="chart-caption"><span>图形近似缩放；精确金额见窗口数据</span><span>${finiteUsd.every((v) => v === null) ? '暂无可靠估值' : 'USDG = USD 展示假设'}</span></div></section><section class="detail-section"><h3>活跃池与登记池 <span class="muted">/ ${t.pools.length}</span></h3>${
      sortedPools
        .slice(0, visiblePoolCount)
        .map(
          (p) =>
            `<div class="pool-card"><div class="pool-top"><span class="chip">${e(p.protocol.toUpperCase())}</span>${e(symbol(p.token0))} / ${e(symbol(p.token1))}</div><div class="pool-id">${e(p.poolId)}<br>${e(p.token0)}<br>${e(p.token1)}</div><div class="pool-metrics"><span>${windowName} ${number(p.windows[windowName]?.txCount)} 笔</span><span>USDG ${formatMicros(p.windows[windowName]?.usdMicros ?? null)}</span></div><div class="pool-id">最后精确 Swap 时间 ${time(p.lastSwapTimeSec, true)}</div></div>`,
        )
        .join('') || '<p class="detail-note">当前范围内尚无已登记池，不能据此推断全链没有成交。</p>'
    }</section><section class="detail-section"><h3>数据说明</h3><p class="detail-note">${e(allReasons.length ? reasons(allReasons) : '当前与前一窗口覆盖可用；估值仍可能独立缺失。')}<br>窗口截止 ${time(selectedEnd(), true)}。详情趋势展示完整分钟。<br>同一交易跨池去重；多只股票共池时分别计参与量，不能相加作为全市场成交额。<br>未登记的对手币使用地址显示，名称和 Meme 分类不作推断。</p></section>`;
  if (sortedPools.length > visiblePoolCount) {
    const more = document.createElement('button');
    more.className = 'more-pools';
    more.id = 'more-pools';
    more.textContent = `再显示 20 个池（已展示 ${visiblePoolCount} / ${sortedPools.length}）`;
    dialog.querySelector('.pool-card:last-child')?.parentElement?.append(more);
    more.addEventListener('click', () => {
      visiblePoolCount += 20;
      renderDetail();
      $('more-pools')?.focus();
    });
  }
  $('copy-address').addEventListener('click', () => {
    void navigator.clipboard
      .writeText(t.address)
      .then(() => toast('合约地址已复制'))
      .catch(() => toast('复制未获允许，请从上方选择合约地址'));
  });
}
function render() {
  loadFavorites();
  renderStatus();
  $('favorite-count').textContent = String(favorites.size);
  $('scope-label').textContent = `${snapshot?.tokens.length ?? 0} 个登记代币 · Meme 分类未登记`;
  $('page-crumb').textContent =
    page === 'health' ? '运行状态' : page === 'favorites' ? '自选代币' : '热度总览';
  $('page-title').innerHTML =
    page === 'health'
      ? '每一份热度，<span>都有据可查。</span>'
      : page === 'favorites'
        ? '你的关注，<span>此刻的变化。</span>'
        : '发现热度，<span>看见变化。</span>';
  $('page-description').textContent =
    page === 'health'
      ? '检查数据的时间、覆盖范围与最近一次运行观测。'
      : '从每一分钟的交易里，找到正在升温的代币。';
  $('monitor-view').hidden = page === 'health';
  $('health-view').hidden = page !== 'health';
  if (page === 'health') renderHealth();
  else {
    const tokens = rankedTokens();
    renderStats(tokens);
    renderRanking(tokens);
    renderHeatmap();
    renderChanges();
  }
  $('source-note').textContent =
    `范围：当前登记的 RWA 及其关联池。可用历史起点 ${time(snapshot?.availableFromSec ?? null, true)}。USDG 等值是估值参与量，不是去重后的全市场成交额；缺口、缺报价和未知时间保留为 —。`;
  if (dialog.open) {
    const focusedFavorite = (document.activeElement as HTMLElement | null)?.dataset.favorite;
    renderDetail();
    if (focusedFavorite) dialog.querySelector<HTMLButtonElement>('[data-favorite]')?.focus();
  }
}
function applySnapshot(data: DashboardSnapshot) {
  if (
    (data.status === 'error' || data.status === 'stale') &&
    !data.tokens.length &&
    snapshot?.tokens.length &&
    data.scopeId === snapshot.scopeId
  ) {
    transportError = `${data.message ?? '数据源暂时不可用'}；保留上次结果，截止 ${time(snapshot.selectedEndSec, true)}。`;
  } else {
    snapshot = data;
    transportError = null;
  }
  render();
}
async function refresh(force = false) {
  clearTimeout(timer);
  if (force) {
    activeRequest?.abort();
    pending = null;
  } else if (activeRequest) return;
  const controller = new AbortController();
  activeRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`/api/snapshot${historyAt === null ? '' : `?at=${historyAt}`}`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`本地接口返回 ${response.status}`);
    const data: DashboardSnapshot = await response.json();
    if (
      !Array.isArray(data.tokens) ||
      !Array.isArray(data.coverage) ||
      typeof data.generatedAtMs !== 'number'
    )
      throw new Error('本地接口数据格式异常');
    if (activeRequest !== controller) return;
    if (
      !force &&
      page !== 'health' &&
      (hovering || focused || dialog.open || $('heatmap').contains(document.activeElement)) &&
      snapshot
    ) {
      pending = data;
      renderStatus();
    } else applySnapshot(data);
  } catch (error) {
    if (activeRequest !== controller) return;
    pending = null;
    transportError = controller.signal.aborted
      ? '本地数据读取超时；保留上次结果。'
      : error instanceof Error
        ? `${error.message}；保留上次结果。`
        : '无法连接本地服务；保留上次结果。';
    renderStatus();
  } finally {
    clearTimeout(timeout);
    if (activeRequest === controller) {
      activeRequest = null;
      timer = setTimeout(() => {
        void refresh();
      }, 5000);
    }
  }
}
function releasePending() {
  if (
    !hovering &&
    !focused &&
    !dialog.open &&
    !$('heatmap').contains(document.activeElement) &&
    pending
  ) {
    const data = pending;
    pending = null;
    applySnapshot(data);
  }
}
function activate(group: string, attribute: string, value: string) {
  $(group)
    .querySelectorAll<HTMLButtonElement>('button')
    .forEach((b) => {
      const selected = b.getAttribute(attribute) === value;
      b.classList.toggle('active', selected);
      b.setAttribute('aria-pressed', String(selected));
    });
}
document.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!button) return;
  if (button.dataset.favorite) {
    toggleFavorite(button.dataset.favorite);
    return;
  }
  if (button.dataset.token) {
    selectedToken = button.dataset.token;
    visiblePoolCount = 20;
    lastFocus = button;
    renderDetail();
    if (!dialog.open) dialog.showModal();
    return;
  }
  if (button.dataset.at) {
    historyAt = Number(button.dataset.at);
    void refresh(true);
    return;
  }
  if (button.dataset.page) {
    page = button.dataset.page as typeof page;
    document
      .querySelectorAll('[data-page]')
      .forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.page === page));
    hovering = false;
    focused = false;
    releasePending();
    render();
    return;
  }
  if (button.dataset.window) {
    windowName = button.dataset.window as WindowName;
    activate('windows', 'data-window', windowName);
    render();
    return;
  }
  if (button.dataset.sort) {
    sort = button.dataset.sort as SortMode;
    activate('sorts', 'data-sort', sort);
    render();
    return;
  }
  if (button.dataset.horizon) {
    horizon = Number(button.dataset.horizon);
    activate('horizons', 'data-horizon', String(horizon));
    renderHeatmap();
    renderChanges();
    return;
  }
  if (button.dataset.scale) {
    relative = button.dataset.scale === 'relative';
    activate('scales', 'data-scale', button.dataset.scale);
    renderHeatmap();
  }
});
$('search').addEventListener('input', (event) => {
  query = (event.target as HTMLInputElement).value;
  render();
});
$('amount-sort').addEventListener('change', () => render());
$('refresh').addEventListener('click', () => {
  void refresh(true);
});
$('close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right) dialog.close();
  }
});
dialog.addEventListener('close', () => {
  selectedToken = null;
  releasePending();
  if (lastFocus?.isConnected) lastFocus.focus();
  else $('search').focus();
});
$('rank-area').addEventListener('mouseenter', () => {
  hovering = true;
});
$('rank-area').addEventListener('mouseleave', () => {
  hovering = false;
  releasePending();
});
$('rank-area').addEventListener('focusin', () => {
  focused = true;
});
$('rank-area').addEventListener('focusout', () =>
  queueMicrotask(() => {
    focused = $('rank-area').contains(document.activeElement);
    releasePending();
  }),
);
window.addEventListener('storage', (event) => {
  if (event.key === favoritesNamespace) {
    favoritesNamespace = '';
    render();
  }
});
window.addEventListener('beforeunload', () => {
  clearTimeout(timer);
  activeRequest?.abort();
});
render();
void refresh();

$('heatmap').addEventListener('focusout', () => queueMicrotask(releasePending));
